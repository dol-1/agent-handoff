// Requires Node >=22.5 (built-in node:sqlite). Run under the pinned nvm
// Node 24 build: /usr/local/bin/node --test test/
//
// Under an older Node (e.g. this host's system-default v18), this file
// registers a single skipped test instead of throwing, so `npm test` /
// `node --test test/` stays green for the v1A-only test files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNodeSqliteSupported, MIN_NODE_VERSION } from '../src/nodeVersionGuard.js';

if (!isNodeSqliteSupported()) {
  test(
    `durableStore tests require Node >=${MIN_NODE_VERSION.join('.')} (node:sqlite) — skipped under Node ${process.versions.node}`,
    { skip: true },
    () => {},
  );
} else {
  const { DurableStore } = await import('../src/durableStore.js');

  function tmpDbPath() {
    const dir = mkdtempSync(join(tmpdir(), 'agent-handoff-store-'));
    return join(dir, 'queue.db');
  }

  const NORMALIZED_EVENT = {
    event: 'issue_entered_todo',
    issueIdentifier: 'DEMO-62',
    issueId: 'issue-uuid',
    projectId: 'project-1',
    teamId: 'team-1',
    targetState: 'Todo',
    url: 'https://linear.app/example/issue/DEMO-62/example',
  };

  test('1. accepted event is durable before the caller could answer 200', () => {
    const dbPath = tmpDbPath();
    const store = new DurableStore(dbPath);
    const result = store.recordDelivery({
      deliveryId: 'd1',
      now: Date.now(),
      relevant: true,
      reason: 'accepted',
      issueIdentifier: 'DEMO-62',
      normalizedEvent: NORMALIZED_EVENT,
    });
    assert.equal(result.duplicate, false);
    assert.equal(result.outcome, 'accepted');
    store.close();

    // A fresh connection to the same file proves the commit already landed
    // on disk, independent of the process that wrote it.
    const reopened = new DurableStore(dbPath);
    assert.equal(reopened.countPending(), 1);
    reopened.close();
    rmSync(dbPath, { force: true });
  });

  test('2. queued event survives a simulated ingress process restart', () => {
    const dbPath = tmpDbPath();
    const first = new DurableStore(dbPath);
    first.recordDelivery({
      deliveryId: 'd1',
      now: Date.now(),
      relevant: true,
      reason: 'accepted',
      issueIdentifier: 'DEMO-62',
      normalizedEvent: NORMALIZED_EVENT,
    });
    first.close();

    const second = new DurableStore(dbPath);
    const pending = second.listPendingEvents();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].deliveryId, 'd1');
    assert.deepEqual(pending[0].normalizedEvent, NORMALIZED_EVENT);
    second.close();
  });

  test('3. duplicate Linear-Delivery stays deduplicated across restart, no second row', () => {
    const dbPath = tmpDbPath();
    const first = new DurableStore(dbPath);
    first.recordDelivery({
      deliveryId: 'd1',
      now: Date.now(),
      relevant: true,
      reason: 'accepted',
      issueIdentifier: 'DEMO-62',
      normalizedEvent: NORMALIZED_EVENT,
    });
    first.close();

    const second = new DurableStore(dbPath);
    const retry = second.recordDelivery({
      deliveryId: 'd1',
      now: Date.now(),
      relevant: true,
      reason: 'accepted',
      issueIdentifier: 'DEMO-62',
      normalizedEvent: NORMALIZED_EVENT,
    });
    assert.equal(retry.duplicate, true);
    assert.equal(retry.outcome, 'accepted');
    assert.equal(second.listPendingEvents().length, 1);
    second.close();
  });

  test('5. two concurrent processes racing the same Linear-Delivery id never error, exactly one wins', async () => {
    const dbPath = tmpDbPath();
    // Pre-create the schema/file so both workers open an existing db and
    // race purely on the recordDelivery() transaction, not table creation.
    new DurableStore(dbPath).close();

    // Deliberately NOT under test/ — node's `--test` auto-discovery treats
    // any file inside a directory literally named `test` as a test file
    // (`**/test/**/*.?(c|m)js`), which would otherwise execute this worker
    // standalone (no argv) as a bogus, always-failing "test".
    const workerPath = fileURLToPath(new URL('../dev-workers/concurrentRecordDeliveryWorker.mjs', import.meta.url));

    function runWorker() {
      return new Promise((resolveRun, rejectRun) => {
        const child = spawn(process.execPath, [workerPath, dbPath, 'race-delivery-1']);
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => {
          stdout += d;
        });
        child.stderr.on('data', (d) => {
          stderr += d;
        });
        child.on('exit', (code) => {
          if (code !== 0) {
            rejectRun(new Error(`worker exited ${code}: ${stderr}`));
          } else {
            resolveRun(JSON.parse(stdout));
          }
        });
      });
    }

    // Fire both workers as close together as possible; SQLite's own
    // BEGIN IMMEDIATE + busy_timeout locking (see durableStore.js's
    // recordDelivery) is what must serialize them correctly — this is a
    // real cross-process race, not simulated within a single event loop.
    const [a, b] = await Promise.all([runWorker(), runWorker()]);

    const outcomes = [a, b];
    const fresh = outcomes.filter((o) => !o.duplicate);
    const duplicates = outcomes.filter((o) => o.duplicate);
    assert.equal(fresh.length, 1, 'exactly one racing writer must win and insert the row');
    assert.equal(duplicates.length, 1, 'the other must deterministically observe a duplicate, never throw/500');
    assert.equal(duplicates[0].outcome, 'accepted');

    const check = new DurableStore(dbPath);
    assert.equal(check.countPending(), 1, 'the race must never produce a second queue row');
    check.close();
  });

  test('5b. concurrent DurableStore construction against a brand-new db path never throws SQLITE_BUSY', async () => {
    // Targets the specific defect a second Opus review round identified:
    // busy_timeout was previously configured AFTER `PRAGMA journal_mode =
    // WAL`, leaving a window — most exposed exactly here, at concurrent
    // FIRST open of a not-yet-existing file, where WAL-mode switch and
    // `CREATE TABLE IF NOT EXISTS` both take locks — where a connection
    // with no busy_timeout yet configured could surface a raw
    // SQLITE_BUSY/"database is locked" constructor failure instead of
    // waiting. This is the actual production scenario the task cares
    // about: ingress and the Channel runner can both open the same db
    // during recovery/reboot. Unlike the recordDelivery race above (which
    // pre-creates the schema before racing), this races real separate OS
    // processes' *constructors* — node:sqlite's DatabaseSync is
    // synchronous, so racing `new DurableStore()` calls within one JS
    // process can never actually overlap; only separate processes can.
    const workerPath = fileURLToPath(new URL('../dev-workers/openDurableStoreWorker.mjs', import.meta.url));
    const CONCURRENT_OPENERS = 8;

    function runWorker(dbPath) {
      return new Promise((resolveRun, rejectRun) => {
        const child = spawn(process.execPath, [workerPath, dbPath]);
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => {
          stdout += d;
        });
        child.stderr.on('data', (d) => {
          stderr += d;
        });
        child.on('exit', (code) => {
          if (code !== 0) rejectRun(new Error(`opener exited ${code}: ${stderr}`));
          else resolveRun(stdout);
        });
      });
    }

    // Repeat the whole race across several iterations with a fresh,
    // never-before-touched path each time (per Opus review: "run the full
    // suite repeatedly" — applied here at the scenario level too, since a
    // single trial is not reliable proof against a timing-dependent bug).
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const dbPath = tmpDbPath(); // tmpDbPath's directory exists, but queue.db itself does not yet
      const results = await Promise.all(
        Array.from({ length: CONCURRENT_OPENERS }, () => runWorker(dbPath)),
      );
      assert.equal(
        results.filter((r) => r === 'ok').length,
        CONCURRENT_OPENERS,
        `iteration ${iteration}: all ${CONCURRENT_OPENERS} concurrent openers must construct successfully, none may throw SQLITE_BUSY`,
      );

      const check = new DurableStore(dbPath);
      assert.equal(check.countPending(), 0);
      check.close();
    }
  });

  test('ignored (verified but irrelevant) delivery is recorded without an event row', () => {
    const dbPath = tmpDbPath();
    const store = new DurableStore(dbPath);
    const result = store.recordDelivery({
      deliveryId: 'd2',
      now: Date.now(),
      relevant: false,
      reason: 'wrong_project',
      issueIdentifier: 'OTHER-1',
    });
    assert.equal(result.duplicate, false);
    assert.equal(result.outcome, 'ignored');
    assert.equal(store.countPending(), 0);
    store.close();
  });

  test('markDelivered removes an event from the pending set idempotently', () => {
    const dbPath = tmpDbPath();
    const store = new DurableStore(dbPath);
    const { eventId } = store.recordDelivery({
      deliveryId: 'd3',
      now: Date.now(),
      relevant: true,
      reason: 'accepted',
      issueIdentifier: 'DEMO-62',
      normalizedEvent: NORMALIZED_EVENT,
    });
    assert.equal(store.countPending(), 1);
    assert.equal(store.markDelivered(eventId), true);
    assert.equal(store.countPending(), 0);
    // Marking an already-delivered row again is a safe no-op, not an error.
    assert.equal(store.markDelivered(eventId), false);
    store.close();
  });

  test('10. raw title/description/comment text never lands in the stored event_json', () => {
    const dbPath = tmpDbPath();
    const store = new DurableStore(dbPath);
    store.recordDelivery({
      deliveryId: 'd4',
      now: Date.now(),
      relevant: true,
      reason: 'accepted',
      issueIdentifier: 'DEMO-62',
      normalizedEvent: NORMALIZED_EVENT, // classifier is the only producer; it never includes free text
    });
    const [row] = store.listPendingEvents();
    const serialized = JSON.stringify(row.normalizedEvent);
    assert.deepEqual(Object.keys(row.normalizedEvent).sort(), Object.keys(NORMALIZED_EVENT).sort());
    assert.ok(!serialized.toLowerCase().includes('description'));
    assert.ok(!serialized.toLowerCase().includes('comment'));
    store.close();
  });

  test('3a. reconciliation can recover a missed webhook after a prior reconciled episode was delivered', () => {
    const dbPath = tmpDbPath();
    const store = new DurableStore(dbPath);

    const first = store.upsertReconciledIssue({
      issueIdentifier: 'DEMO-99',
      issueId: 'issue-99',
      projectId: 'project-1',
      teamId: 'team-1',
      targetState: 'Todo',
      url: null,
      now: Date.now(),
    });
    assert.equal(first.duplicate, false);
    assert.ok(first.eventId);
    store.markDelivered(first.eventId);

    // A genuine later re-entry into Todo (e.g. the issue was completed,
    // then reopened) whose webhook was missed — reconciliation must be
    // able to queue it again, not be permanently blocked by the first
    // episode's now-terminal delivery row.
    const second = store.upsertReconciledIssue({
      issueIdentifier: 'DEMO-99',
      issueId: 'issue-99',
      projectId: 'project-1',
      teamId: 'team-1',
      targetState: 'Todo',
      url: null,
      now: Date.now(),
    });
    assert.equal(second.duplicate, false, 'a later episode must be queueable again, not blocked by the first delivered one');
    assert.notEqual(second.eventId, first.eventId);
    assert.equal(store.countPending(), 1);

    store.close();
  });

  // --- DEMO-65 v1C: job_type / cycle bookkeeping ---

  test('v1C. recordDelivery defaults jobType to execute and creates a fresh cycle', () => {
    const dbPath = tmpDbPath();
    const store = new DurableStore(dbPath);
    const result = store.recordDelivery({
      deliveryId: 'd-v1c-1',
      now: Date.now(),
      relevant: true,
      reason: 'accepted',
      issueIdentifier: 'DEMO-200',
      normalizedEvent: { ...NORMALIZED_EVENT, issueIdentifier: 'DEMO-200' },
    });
    assert.equal(result.eventId !== undefined, true);
    assert.ok(result.cycleId, 'a fresh cycle_id must be assigned');
    const [row] = store.listPendingEvents();
    assert.equal(row.jobType, 'execute');
    assert.equal(row.cycleId, result.cycleId);
    const cycle = store.getCycle('DEMO-200');
    assert.equal(cycle.cycleId, result.cycleId);
    assert.equal(cycle.revisionCount, 0);
    assert.equal(cycle.status, 'active');
    store.close();
  });

  test('v1C. a review job re-uses the SAME cycle an execute job for that issue already created', () => {
    const dbPath = tmpDbPath();
    const store = new DurableStore(dbPath);
    const execResult = store.recordDelivery({
      deliveryId: 'd-v1c-2a',
      now: Date.now(),
      relevant: true,
      reason: 'accepted',
      issueIdentifier: 'DEMO-201',
      normalizedEvent: { ...NORMALIZED_EVENT, issueIdentifier: 'DEMO-201' },
      jobType: 'execute',
    });
    store.markDelivered(execResult.eventId);

    const reviewResult = store.recordDelivery({
      deliveryId: 'd-v1c-2b',
      now: Date.now(),
      relevant: true,
      reason: 'accepted',
      issueIdentifier: 'DEMO-201',
      normalizedEvent: { ...NORMALIZED_EVENT, issueIdentifier: 'DEMO-201', targetState: 'In Review' },
      jobType: 'review',
    });
    assert.equal(reviewResult.cycleId, execResult.cycleId, 'the review job must reuse the execute job\'s cycle, not start a new one');
    const [row] = store.listPendingEvents();
    assert.equal(row.jobType, 'review');
    store.close();
  });

  test('v1C. markReviewDelivered(pass) marks delivered AND sets cycle status=done', () => {
    const dbPath = tmpDbPath();
    const store = new DurableStore(dbPath);
    const { eventId } = store.recordDelivery({
      deliveryId: 'd-v1c-3',
      now: Date.now(),
      relevant: true,
      reason: 'accepted',
      issueIdentifier: 'DEMO-202',
      normalizedEvent: { ...NORMALIZED_EVENT, issueIdentifier: 'DEMO-202' },
      jobType: 'review',
    });
    store.markReviewDelivered({ eventId, issueIdentifier: 'DEMO-202', now: Date.now(), cycleOutcome: 'pass' });
    assert.equal(store.countPending(), 0);
    assert.equal(store.getCycle('DEMO-202').status, 'done');
    store.close();
  });

  test('v1C. markReviewDelivered(needs_human) marks delivered AND sets cycle status=needs_human', () => {
    const dbPath = tmpDbPath();
    const store = new DurableStore(dbPath);
    const { eventId } = store.recordDelivery({
      deliveryId: 'd-v1c-4',
      now: Date.now(),
      relevant: true,
      reason: 'accepted',
      issueIdentifier: 'DEMO-203',
      normalizedEvent: { ...NORMALIZED_EVENT, issueIdentifier: 'DEMO-203' },
      jobType: 'review',
    });
    store.markReviewDelivered({ eventId, issueIdentifier: 'DEMO-203', now: Date.now(), cycleOutcome: 'needs_human' });
    assert.equal(store.countPending(), 0);
    assert.equal(store.getCycle('DEMO-203').status, 'needs_human');
    store.close();
  });

  test('v1C. markReviewDelivered(revision_required) marks delivered AND increments revision_count, cycle stays active', () => {
    const dbPath = tmpDbPath();
    const store = new DurableStore(dbPath);
    const { eventId } = store.recordDelivery({
      deliveryId: 'd-v1c-5',
      now: Date.now(),
      relevant: true,
      reason: 'accepted',
      issueIdentifier: 'DEMO-204',
      normalizedEvent: { ...NORMALIZED_EVENT, issueIdentifier: 'DEMO-204' },
      jobType: 'review',
    });
    store.markReviewDelivered({ eventId, issueIdentifier: 'DEMO-204', now: Date.now(), cycleOutcome: 'revision_required' });
    assert.equal(store.countPending(), 0);
    const cycle = store.getCycle('DEMO-204');
    assert.equal(cycle.status, 'active');
    assert.equal(cycle.revisionCount, 1);
    store.close();
  });

  // DEMO-65 v1C, requirement: "ensure reconciliation cannot re-open the same
  // exhausted cycle indefinitely" — an issue whose cycle already reached a
  // terminal status must not get a new active row, even if a fresh webhook
  // or reconciliation discovery arrives for it.
  test('v1C. an exhausted (done) cycle refuses a new active row for the same issue — no re-open', () => {
    const dbPath = tmpDbPath();
    const store = new DurableStore(dbPath);
    const { eventId } = store.recordDelivery({
      deliveryId: 'd-v1c-6a',
      now: Date.now(),
      relevant: true,
      reason: 'accepted',
      issueIdentifier: 'DEMO-205',
      normalizedEvent: { ...NORMALIZED_EVENT, issueIdentifier: 'DEMO-205' },
      jobType: 'review',
    });
    store.markReviewDelivered({ eventId, issueIdentifier: 'DEMO-205', now: Date.now(), cycleOutcome: 'pass' });

    // A brand-new, never-before-seen delivery id for the SAME issue arrives
    // (e.g. someone manually re-opened it in Linear back into Todo).
    const reopenAttempt = store.recordDelivery({
      deliveryId: 'd-v1c-6b',
      now: Date.now(),
      relevant: true,
      reason: 'accepted',
      issueIdentifier: 'DEMO-205',
      normalizedEvent: { ...NORMALIZED_EVENT, issueIdentifier: 'DEMO-205' },
      jobType: 'execute',
    });
    assert.equal(reopenAttempt.eventId, undefined, 'no new active row may be created for an exhausted cycle');
    assert.equal(reopenAttempt.skipReason, 'cycle_exhausted');
    assert.equal(store.countPending(), 0);
    store.close();
  });

  test('v1C. restart preserves job_type, cycle_id, and revision_count', () => {
    const dbPath = tmpDbPath();
    const first = new DurableStore(dbPath);
    const { eventId, cycleId } = first.recordDelivery({
      deliveryId: 'd-v1c-7',
      now: Date.now(),
      relevant: true,
      reason: 'accepted',
      issueIdentifier: 'DEMO-206',
      normalizedEvent: { ...NORMALIZED_EVENT, issueIdentifier: 'DEMO-206' },
      jobType: 'review',
    });
    first.markReviewDelivered({ eventId, issueIdentifier: 'DEMO-206', now: Date.now(), cycleOutcome: 'revision_required' });
    first.close();

    const second = new DurableStore(dbPath);
    const cycle = second.getCycle('DEMO-206');
    assert.equal(cycle.cycleId, cycleId);
    assert.equal(cycle.revisionCount, 1);
    assert.equal(cycle.status, 'active');
    second.close();
  });

  test('3b. two real OS processes racing a webhook and a reconciliation discovery for the same issue: at most one active row', async () => {
    const dbPath = tmpDbPath();
    // Pre-create the schema/file so both workers open an existing db and
    // race purely on recordDelivery()'s transaction, not table creation.
    new DurableStore(dbPath).close();

    const workerPath = fileURLToPath(new URL('../dev-workers/webhookReconcileRaceWorker.mjs', import.meta.url));

    function runWorker(mode) {
      return new Promise((resolveRun, rejectRun) => {
        const child = spawn(process.execPath, [workerPath, dbPath, mode, 'DEMO-100']);
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => {
          stdout += d;
        });
        child.stderr.on('data', (d) => {
          stderr += d;
        });
        child.on('exit', (code) => {
          if (code !== 0) {
            rejectRun(new Error(`worker (${mode}) exited ${code}: ${stderr}`));
          } else {
            resolveRun(JSON.parse(stdout));
          }
        });
      });
    }

    // Real cross-process race: a webhook-sourced recordDelivery() and a
    // reconciliation-sourced upsertReconciledIssue() for the SAME issue,
    // fired as close together as possible. Whichever wins, the loser must
    // observe "already active" — never both inserting their own row.
    const [webhookResult, reconcileResult] = await Promise.all([runWorker('webhook'), runWorker('reconcile')]);

    const check = new DurableStore(dbPath);
    assert.equal(
      check.countPending() + check.countNeedsReview(),
      1,
      'the race must never produce two active rows for the same issue',
    );
    check.close();

    // Exactly one side must have actually created the row; the other must
    // have deterministically observed it as already active — never both,
    // never neither.
    const created = [webhookResult, reconcileResult].filter((r) => r.eventId !== undefined && !r.duplicate);
    assert.equal(created.length, 1, 'exactly one of webhook/reconciliation must have created the active row');
  });
}
