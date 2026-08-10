// v1B durable local persistence (DEMO-62 section A). A single SQLite file,
// accessed only through `node:sqlite` (built into Node >=22.5, no native
// module / no build toolchain / no new network service). One process
// (ingressServer.js) writes; one process (workerEntry.js) reads and marks
// delivered/retried. WAL mode + a busy timeout let both hold the file open
// concurrently without a bespoke lock protocol.
//
// Schema stores only trusted routing identifiers (see webhookClassifier.js).
// Raw webhook body / issue title / description / comments never reach this
// module — callers only ever pass already-normalized values. This also
// applies to reconciliation-discovered rows (DEMO-62 one-shot-worker
// revision): only issueIdentifier/issueId/projectId/teamId/targetState/url
// ever cross into this store, never Linear free text.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// DEMO-62 revision: `PRAGMA busy_timeout` does not fully cover every
// lock-taking statement. Verified experimentally (dev-workers/openDurableStoreWorker.mjs
// raced 2-way, 40 iterations): even with busy_timeout configured first,
// `PRAGMA journal_mode = WAL` and schema creation can still throw a raw
// SQLITE_BUSY ("database is locked", errcode 5) immediately, with no
// retry, when two processes open the same brand-new db path at nearly the
// same instant — the exact ingress/worker concurrent-startup scenario this
// task exists to make reliable. This wrapper adds an explicit synchronous
// retry/backoff around exactly the statements that exhibited the failure,
// bounded by the same ~5s budget busy_timeout itself uses, so DB
// initialization becomes deterministic under concurrent process startup
// instead of merely "usually fine".
function isSqliteBusy(err) {
  return err?.code === 'ERR_SQLITE_ERROR' && (err?.errcode === 5 || /database is locked/i.test(String(err?.message ?? '')));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function execWithBusyRetry(db, sql, { totalTimeoutMs = 5000, initialDelayMs = 5, maxDelayMs = 200 } = {}) {
  const deadline = Date.now() + totalTimeoutMs;
  let delay = initialDelayMs;
  for (;;) {
    try {
      db.exec(sql);
      return;
    } catch (err) {
      const remaining = deadline - Date.now();
      if (!isSqliteBusy(err) || remaining <= 0) throw err;
      sleepSync(Math.min(delay, remaining));
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS deliveries (
  delivery_id      TEXT PRIMARY KEY,
  received_at      INTEGER NOT NULL,
  outcome          TEXT NOT NULL CHECK (outcome IN ('accepted', 'ignored')),
  reason           TEXT NOT NULL,
  issue_identifier TEXT
);

-- DEMO-62 one-shot-worker revision: added issue_identifier (denormalized,
-- for fast per-issue lookups without a join — used by reconciliation
-- idempotency) and retry/backoff bookkeeping (attempt_count, next_attempt_at,
-- last_outcome, last_error_class, last_attempt_at). status gained
-- 'needs_review': an item that exhausted its retry budget without becoming
-- delivered — kept, never silently discarded, surfaced via
-- countNeedsReview()/listNeedsReview() for human/reviewer attention.
--
-- DEMO-65 v1C: added job_type (execute|review — which leg this row is for)
-- and cycle_id (denormalized copy of this issue's issue_cycles.cycle_id at
-- creation time, for auditability). Defaults exist only so a bare INSERT in
-- an older test fixture can't violate NOT NULL; every real caller
-- (recordDelivery) always supplies both explicitly.
CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id     TEXT NOT NULL UNIQUE REFERENCES deliveries(delivery_id),
  issue_identifier TEXT NOT NULL,
  event_json      TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'needs_review')) DEFAULT 'pending',
  created_at      INTEGER NOT NULL,
  delivered_at    INTEGER,
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_outcome    TEXT,
  last_error_class TEXT,
  last_attempt_at INTEGER,
  job_type        TEXT NOT NULL CHECK (job_type IN ('execute', 'review')) DEFAULT 'execute',
  cycle_id        TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS events_status_idx ON events (status, next_attempt_at, id);
CREATE INDEX IF NOT EXISTS events_issue_idx ON events (issue_identifier, status);

-- DEMO-65 v1C: one row per issue that has ever entered the execute/review
-- loop. cycle_id identifies one attempt sequence from first Todo pickup
-- through eventual pass/needs_human; revision_count is the worker's own
-- TRUSTED count of completed revision_required rounds within that cycle
-- (never taken from an Opus turn's self-report — see worker.js's
-- processReviewEventInner()). status='active' while the loop may still
-- continue; 'needs_human'/'done' are terminal — recordDelivery() below
-- refuses to create a new active event row for an issue whose cycle is
-- already terminal, so reconciliation can never re-open an exhausted cycle.
CREATE TABLE IF NOT EXISTS issue_cycles (
  issue_identifier TEXT PRIMARY KEY,
  cycle_id         TEXT NOT NULL,
  revision_count   INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL CHECK (status IN ('active', 'needs_human', 'done')) DEFAULT 'active',
  updated_at       INTEGER NOT NULL
);
`;

export class DurableStore {
  constructor(dbPath) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(dbPath);
    // busy_timeout MUST be the first statement on this connection, before
    // any lock-taking operation — but is not sufficient by itself (see
    // execWithBusyRetry above): the statements below are additionally
    // wrapped in an explicit retry so concurrent first-open (e.g. ingress
    // and the worker both starting near-simultaneously during recovery/
    // reboot) cannot surface a raw SQLITE_BUSY constructor failure.
    this.db.exec('PRAGMA busy_timeout = 5000');
    execWithBusyRetry(this.db, 'PRAGMA journal_mode = WAL');
    execWithBusyRetry(this.db, 'PRAGMA foreign_keys = ON');
    execWithBusyRetry(this.db, SCHEMA);

    this.stmtGetDelivery = this.db.prepare(
      'SELECT delivery_id, outcome, reason FROM deliveries WHERE delivery_id = ?',
    );
    this.stmtInsertDelivery = this.db.prepare(
      'INSERT INTO deliveries (delivery_id, received_at, outcome, reason, issue_identifier) VALUES (?, ?, ?, ?, ?)',
    );
    this.stmtInsertEvent = this.db.prepare(
      'INSERT INTO events (delivery_id, issue_identifier, event_json, status, created_at, job_type, cycle_id) VALUES (?, ?, ?, \'pending\', ?, ?, ?)',
    );
    this.stmtPendingEvents = this.db.prepare(
      'SELECT id, delivery_id, issue_identifier, event_json, created_at, attempt_count, next_attempt_at, last_outcome, last_error_class, job_type, cycle_id FROM events WHERE status = \'pending\' ORDER BY id ASC',
    );
    this.stmtEligibleEvents = this.db.prepare(
      'SELECT id, delivery_id, issue_identifier, event_json, created_at, attempt_count, next_attempt_at, last_outcome, last_error_class, job_type, cycle_id FROM events WHERE status = \'pending\' AND next_attempt_at <= ? ORDER BY id ASC',
    );
    this.stmtNeedsReviewEvents = this.db.prepare(
      'SELECT id, delivery_id, issue_identifier, event_json, created_at, attempt_count, last_outcome, last_error_class, job_type, cycle_id FROM events WHERE status = \'needs_review\' ORDER BY id ASC',
    );
    this.stmtMarkDelivered = this.db.prepare(
      'UPDATE events SET status = \'delivered\', delivered_at = ? WHERE id = ? AND status IN (\'pending\', \'needs_review\')',
    );
    this.stmtCountPending = this.db.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE status = 'pending'",
    );
    this.stmtCountNeedsReview = this.db.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE status = 'needs_review'",
    );
    this.stmtGetAttemptCount = this.db.prepare('SELECT attempt_count FROM events WHERE id = ?');
    this.stmtRecordAttempt = this.db.prepare(
      'UPDATE events SET attempt_count = ?, next_attempt_at = ?, last_outcome = ?, last_error_class = ?, last_attempt_at = ?, status = ? WHERE id = ?',
    );
    this.stmtResetToPending = this.db.prepare(
      'UPDATE events SET status = \'pending\', next_attempt_at = 0, attempt_count = 0 WHERE id = ?',
    );
    this.stmtHasActiveEventForIssue = this.db.prepare(
      "SELECT 1 FROM events WHERE issue_identifier = ? AND status IN ('pending', 'needs_review') LIMIT 1",
    );

    // DEMO-65 v1C: issue_cycles bookkeeping.
    this.stmtGetCycle = this.db.prepare(
      'SELECT issue_identifier, cycle_id, revision_count, status FROM issue_cycles WHERE issue_identifier = ?',
    );
    this.stmtInsertCycle = this.db.prepare(
      'INSERT INTO issue_cycles (issue_identifier, cycle_id, revision_count, status, updated_at) VALUES (?, ?, 0, \'active\', ?)',
    );
    this.stmtIncrementRevisionCount = this.db.prepare(
      'UPDATE issue_cycles SET revision_count = revision_count + 1, updated_at = ? WHERE issue_identifier = ?',
    );
    this.stmtSetCycleStatus = this.db.prepare(
      'UPDATE issue_cycles SET status = ?, updated_at = ? WHERE issue_identifier = ?',
    );
  }

  // Atomically records the delivery receipt (for dedup) and, for a relevant
  // event, the queued normalized event — in one transaction, so a retry of
  // the same Linear-Delivery id can never produce a second queue row and a
  // durable commit always happens before the caller may answer HTTP 200.
  //
  // The existence check happens INSIDE the `BEGIN IMMEDIATE` transaction,
  // not before it (DEMO-62 revision item 5): `BEGIN IMMEDIATE` acquires
  // SQLite's write lock immediately, so once held, no other connection —
  // whether a second in-process caller or a second OS process pointed at
  // the same file — can insert a competing row between our SELECT and our
  // INSERT. A second concurrent caller for the same deliveryId simply
  // blocks (bounded by `PRAGMA busy_timeout`) until the first commits, then
  // its own SELECT (now correctly inside its own IMMEDIATE transaction)
  // deterministically observes the just-committed row and returns
  // `duplicate: true` — it can never reach the INSERT and hit the UNIQUE
  // constraint, which is what previously surfaced as a spurious 500 instead
  // of a deterministic 200 duplicate response.
  //
  // Returns:
  //   { duplicate: true,  outcome }                 -- already recorded, no write performed
  //   { duplicate: false, outcome: 'ignored' }       -- newly recorded, not queued
  //   { duplicate: false, outcome: 'accepted', eventId } -- newly recorded and queued
  //   { duplicate: false, outcome: 'accepted', eventId: undefined } -- new delivery id recorded, but
  //     no second active row created (see the active-issue check below)
  //
  // DEMO-62 revision, finding 3: for a relevant event, this also checks —
  // atomically, inside the SAME transaction as the insert, not as a
  // separate earlier query — whether an ACTIVE (pending/needs_review)
  // event already exists for this issue_identifier from ANY source
  // (webhook or reconciliation). If so, the delivery receipt is still
  // recorded (so a retry of THIS exact delivery id stays idempotent), but
  // no second execution row is created. Because `BEGIN IMMEDIATE` holds
  // SQLite's single writer lock for the whole transaction, this closes the
  // race the prior revision's separate check-then-insert in
  // upsertReconciledIssue() left open — a webhook-sourced and a
  // reconciliation-sourced write for the same issue can never both
  // conclude "not yet active" and each insert their own row: whichever
  // begins its transaction first commits, and the second's fresh check
  // (now unavoidably inside the same lock) correctly observes it.
  // DEMO-65 v1C: gained `jobType` ('execute'|'review', default 'execute' for
  // backward compatibility with every pre-v1C caller/test) and cycle
  // bookkeeping, still entirely inside this same BEGIN IMMEDIATE
  // transaction — the same TOCTOU-safety reasoning finding 3/5 established
  // for the active-issue check applies identically here: a webhook-sourced
  // and a reconciliation-sourced write for the same issue must never both
  // conclude "cycle is still open" and each insert their own row.
  //
  // Two independent reasons a relevant delivery may end up with no active
  // row created (exposed via `skipReason`, not thrown):
  //   'already_active'  — an execute or review job is already in flight for
  //                        this issue (unchanged v1B behavior).
  //   'cycle_exhausted'  — this issue's cycle already reached a terminal
  //                        state ('needs_human'/'done') — DEMO-65's
  //                        requirement that reconciliation can never re-open
  //                        an exhausted cycle, enforced at the single choke
  //                        point both the webhook and reconciliation paths
  //                        share.
  recordDelivery({ deliveryId, now, relevant, reason, issueIdentifier, normalizedEvent, jobType = 'execute' }) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.stmtGetDelivery.get(deliveryId);
      if (existing) {
        this.db.exec('COMMIT'); // read-only; nothing to roll back, but closes the transaction cleanly
        return { duplicate: true, outcome: existing.outcome };
      }

      const outcome = relevant ? 'accepted' : 'ignored';
      this.stmtInsertDelivery.run(deliveryId, now, outcome, reason, issueIdentifier ?? null);

      let eventId;
      let cycleId;
      let skipReason;
      if (relevant) {
        const cycleRow = this.stmtGetCycle.get(issueIdentifier);
        if (cycleRow && cycleRow.status !== 'active') {
          skipReason = 'cycle_exhausted';
        } else if (this.stmtHasActiveEventForIssue.get(issueIdentifier)) {
          skipReason = 'already_active';
        } else {
          cycleId = cycleRow ? cycleRow.cycle_id : randomUUID();
          if (!cycleRow) this.stmtInsertCycle.run(issueIdentifier, cycleId, now);
          const result = this.stmtInsertEvent.run(
            deliveryId,
            issueIdentifier,
            JSON.stringify(normalizedEvent),
            now,
            jobType,
            cycleId,
          );
          eventId = Number(result.lastInsertRowid);
        }
      }

      this.db.exec('COMMIT');
      return relevant ? { duplicate: false, outcome, eventId, cycleId, skipReason } : { duplicate: false, outcome };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // DEMO-62 one-shot-worker revision: discovery-only upsert used by
  // reconciliation (src/worker.js's reconcileOnce()). Delegates entirely
  // to recordDelivery(), which now (finding 3) performs the active-issue
  // check atomically inside its own transaction — reconciliation no longer
  // needs (or performs) a separate pre-check.
  //
  // Each call uses a FRESH, per-attempt synthetic delivery id
  // (`reconcile:<identifier>:<now>:<random>`), not a permanent
  // `reconcile:<identifier>` — this is the finding-3 fix for "reconciliation
  // cannot recover a missed webhook after the same issue has already been
  // reconciled once": since the ONLY thing preventing a duplicate active
  // row is the fresh active-issue check (not delivery-id history), a prior
  // reconciled episode that has since been delivered no longer blocks a
  // later genuine re-entry into Todo from being queued again — the old
  // terminal delivery row is simply irrelevant to a new, different
  // delivery id. Idempotency for an issue that is CURRENTLY still active
  // is unaffected: recordDelivery's active-issue check still catches it
  // regardless of the delivery id being new every time (test item 11).
  // DEMO-65 v1C: gained `jobType` ('execute'|'review', default 'execute') so
  // reconciliation can discover missed In Review (review) work the same way
  // it already discovers missed Todo (execute) work — see worker.js's
  // reconcileForState(), called once per target state.
  upsertReconciledIssue({ issueIdentifier, issueId, projectId, teamId, targetState, jobType = 'execute', url, now }) {
    const result = this.recordDelivery({
      deliveryId: `reconcile:${issueIdentifier}:${now}:${randomUUID()}`,
      now,
      relevant: true,
      reason: 'reconciled',
      issueIdentifier,
      normalizedEvent: {
        event: jobType === 'review' ? 'issue_entered_review' : 'issue_entered_todo',
        issueIdentifier,
        issueId,
        projectId,
        teamId,
        targetState,
        jobType,
        url: url ?? undefined,
      },
      jobType,
    });
    // The synthetic id is always fresh, so `result.duplicate` (a retried
    // delivery id) is structurally impossible here — the "already queued
    // elsewhere" / "cycle already exhausted" cases instead surface as a
    // defined outcome with no eventId, which this method translates to the
    // same { duplicate: true, outcome } shape callers (worker.js's
    // reconcileOnce()) already expect.
    if (result.eventId === undefined) {
      return { duplicate: true, outcome: result.skipReason ?? 'already_active' };
    }
    return { duplicate: false, outcome: result.outcome, eventId: result.eventId };
  }

  // DEMO-65 v1C: read-only lookup of an issue's current cycle — used by
  // worker.js's processReviewEventInner() to obtain the worker's own
  // TRUSTED revision_count (never taken from an Opus turn's self-report)
  // before building the review prompt and evaluating its result. Returns
  // null if this issue has never entered the loop yet.
  getCycle(issueIdentifier) {
    const row = this.stmtGetCycle.get(issueIdentifier);
    if (!row) return null;
    return {
      issueIdentifier: row.issue_identifier,
      cycleId: row.cycle_id,
      revisionCount: row.revision_count,
      status: row.status,
    };
  }

  // DEMO-65 v1C: the review-leg counterpart to markDelivered() — atomically
  // marks the review event row delivered AND applies the durable cycle
  // bookkeeping the review outcome implies, in one transaction, so a crash
  // between the two can never happen:
  //   'revision_required' -> issue_cycles.revision_count += 1 (cycle stays
  //                           'active'; the execute leg picks the re-opened
  //                           Todo issue up again via webhook/reconciliation)
  //   'pass'               -> issue_cycles.status = 'done'
  //   'needs_human'        -> issue_cycles.status = 'needs_human'
  // Both terminal statuses are checked by recordDelivery()'s cycle-exhausted
  // guard, so once written here, reconciliation can never re-open this
  // issue's cycle again.
  markReviewDelivered({ eventId, issueIdentifier, now = Date.now(), cycleOutcome }) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.stmtMarkDelivered.run(now, eventId);
      if (cycleOutcome === 'revision_required') {
        this.stmtIncrementRevisionCount.run(now, issueIdentifier);
      } else if (cycleOutcome === 'pass') {
        this.stmtSetCycleStatus.run('done', now, issueIdentifier);
      } else if (cycleOutcome === 'needs_human') {
        this.stmtSetCycleStatus.run('needs_human', now, issueIdentifier);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  listPendingEvents() {
    return this.stmtPendingEvents.all().map(rowToEvent);
  }

  // Only rows eligible to be attempted right now: status='pending' AND
  // past their backoff window (or never attempted, next_attempt_at=0).
  // This is what the worker's poll loop actually consumes.
  listEligibleEvents(now = Date.now()) {
    return this.stmtEligibleEvents.all(now).map(rowToEvent);
  }

  listNeedsReview() {
    return this.stmtNeedsReviewEvents.all().map(rowToEvent);
  }

  markDelivered(eventId, now = Date.now()) {
    const result = this.stmtMarkDelivered.run(now, eventId);
    return result.changes > 0;
  }

  // Records a non-terminal attempt outcome (blocked/failed/malformed/
  // timeout/signal/nonzero_exit/mismatch/etc — anything that must fail
  // closed per DEMO-62's completion contract) and schedules the next
  // eligible retry time with the given backoff. Once attemptCount reaches
  // maxAttempts, the row moves to 'needs_review' instead of being retried
  // further — it is never marked delivered and never silently discarded.
  recordAttemptFailure({ eventId, now = Date.now(), outcome, errorClass, backoffMs, maxAttempts }) {
    const row = this.stmtGetAttemptCount.get(eventId);
    if (!row) return null;
    const attemptCount = row.attempt_count + 1;
    const needsReview = attemptCount >= maxAttempts;
    const status = needsReview ? 'needs_review' : 'pending';
    const nextAttemptAt = needsReview ? 0 : now + backoffMs;
    this.stmtRecordAttempt.run(attemptCount, nextAttemptAt, outcome ?? null, errorClass ?? null, now, status, eventId);
    return { attemptCount, status, nextAttemptAt };
  }

  // Manual recovery path for a needs_review row — not exercised by normal
  // worker flow, kept so a stuck item is provably recoverable rather than
  // a dead end.
  resetToPending(eventId) {
    const result = this.stmtResetToPending.run(eventId);
    return result.changes > 0;
  }

  countPending() {
    return this.stmtCountPending.get().n;
  }

  countNeedsReview() {
    return this.stmtCountNeedsReview.get().n;
  }

  close() {
    this.db.close();
  }
}

function rowToEvent(row) {
  return {
    id: row.id,
    deliveryId: row.delivery_id,
    issueIdentifier: row.issue_identifier,
    normalizedEvent: JSON.parse(row.event_json),
    createdAt: row.created_at,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    lastOutcome: row.last_outcome,
    lastErrorClass: row.last_error_class,
    jobType: row.job_type,
    cycleId: row.cycle_id,
  };
}
