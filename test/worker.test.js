// End-to-end worker tests using dev-workers/fakeClaude.mjs as a real,
// separately-spawned OS process standing in for `claude` — per the Opus
// review, the worker unit tests must not depend on live Claude calls.
// Requires Node >=22.5 (built-in node:sqlite) — see durableStore.test.js
// for why this file self-skips under older Node instead of throwing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNodeSqliteSupported, MIN_NODE_VERSION } from '../src/nodeVersionGuard.js';

const FAKE_CLAUDE = resolve(dirname(fileURLToPath(import.meta.url)), '../dev-workers/fakeClaude.mjs');

if (!isNodeSqliteSupported()) {
  test(
    `worker tests require Node >=${MIN_NODE_VERSION.join('.')} (node:sqlite) — skipped under Node ${process.versions.node}`,
    { skip: true },
    () => {},
  );
} else {
  const { DurableStore } = await import('../src/durableStore.js');
  const { createWorker, computeReviewActionToken } = await import('../src/worker.js');
  const { spawnClaudeTurn: realSpawnClaudeTurn } = await import('../src/claudeInvoker.js');

  function scratch(prefix) {
    return mkdtempSync(join(tmpdir(), prefix));
  }

  // Used as the spawned fake-claude child's cwd (spawn() requires a real,
  // existing directory) and as the "project root" sessionTranscriptExists
  // encodes — consistent across a test run, distinct across separate
  // `node --test` runs.
  const FAKE_PROJECT_ROOT = scratch('agent-handoff-worker-projectroot-');

  const BASE_CONFIG = {
    projectRoot: FAKE_PROJECT_ROOT,
    claudeBin: 'unused-fake-claude-adapter-ignores-this',
    allowedTeamId: 'team-1',
    allowedProjectId: 'project-1',
    allowedTargetStateName: 'Todo',
    workerTurnTimeoutMs: 5000,
    reconcileTurnTimeoutMs: 5000,
    reviewTurnTimeoutMs: 5000,
    workerBaseBackoffMs: 1000,
    workerMaxBackoffMs: 60_000,
    workerMaxAttempts: 3,
    maxRevisionCycles: 3,
    pollIntervalMs: 1_000_000_000,
    reconcileIntervalMs: 1_000_000_000,
  };

  const REVIEW_NORMALIZED_EVENT = {
    event: 'issue_entered_review',
    issueIdentifier: 'DEMO-1',
    issueId: 'issue-uuid',
    projectId: 'project-1',
    teamId: 'team-1',
    targetState: 'In Review',
    jobType: 'review',
    url: 'https://linear.app/x/DEMO-1',
  };

  const NORMALIZED_EVENT = {
    event: 'issue_entered_todo',
    issueIdentifier: 'DEMO-1',
    issueId: 'issue-uuid',
    projectId: 'project-1',
    teamId: 'team-1',
    targetState: 'Todo',
    url: 'https://linear.app/x/DEMO-1',
  };

  // Builds a spawnClaudeTurnFn (matching src/claudeInvoker.js's
  // spawnClaudeTurn signature) that runs the REAL spawnClaudeTurn logic
  // (arg-building, timeout/kill handling) but executes dev-workers/
  // fakeClaude.mjs as a real child process instead of a live claude binary.
  function fakeSpawnClaudeTurnFn({ mode, homeDir, argsLog, structuredOverrides, rawStructured }) {
    return (params) =>
      realSpawnClaudeTurn({
        ...params,
        claudeBin: process.execPath,
        spawnFn: (bin, args, opts) =>
          spawn(bin, [FAKE_CLAUDE, ...args], {
            ...opts,
            env: {
              ...process.env,
              FAKE_CLAUDE_MODE: mode,
              FAKE_CLAUDE_HOME: homeDir,
              ...(argsLog ? { FAKE_CLAUDE_ARGS_LOG: argsLog } : {}),
              ...(structuredOverrides ? { FAKE_CLAUDE_STRUCTURED: JSON.stringify(structuredOverrides) } : {}),
              ...(rawStructured ? { FAKE_CLAUDE_RAW_STRUCTURED: '1' } : {}),
            },
          }),
      });
  }

  function makeWorker({ mode, structuredOverrides, dbPath, homeDir, argsLog, rawStructured } = {}) {
    const store = new DurableStore(dbPath ?? ':memory:');
    const worker = createWorker({
      config: BASE_CONFIG,
      store,
      log: () => {},
      spawnClaudeTurnFn: fakeSpawnClaudeTurnFn({ mode, homeDir, argsLog, structuredOverrides, rawStructured }),
      homeDir,
      sessionId: 'fixed-test-session-id',
      reviewerSessionId: 'fixed-test-reviewer-session-id',
    });
    return { store, worker };
  }

  function enqueue(store, overrides = {}) {
    const now = Date.now();
    const event = { ...NORMALIZED_EVENT, ...overrides.normalizedEvent };
    const result = store.recordDelivery({
      deliveryId: overrides.deliveryId ?? `delivery-${Math.random()}`,
      now,
      relevant: true,
      reason: 'accepted',
      issueIdentifier: event.issueIdentifier,
      normalizedEvent: event,
      jobType: overrides.jobType ?? 'execute',
    });
    return result.eventId;
  }

  // DEMO-65 v1C convenience wrapper: enqueues a review-type job.
  function enqueueReview(store, overrides = {}) {
    const now = Date.now();
    const event = { ...REVIEW_NORMALIZED_EVENT, ...overrides.normalizedEvent };
    const result = store.recordDelivery({
      deliveryId: overrides.deliveryId ?? `delivery-${Math.random()}`,
      now,
      relevant: true,
      reason: 'accepted',
      issueIdentifier: event.issueIdentifier,
      normalizedEvent: event,
      jobType: 'review',
    });
    return result.eventId;
  }

  test('3. valid completed structured output -> event marked delivered', async () => {
    const homeDir = scratch('agent-handoff-worker-home-');
    const { store, worker } = makeWorker({
      mode: 'success',
      structuredOverrides: { issueIdentifier: 'DEMO-1' },
      homeDir,
    });
    enqueue(store);
    await worker.pollOnce();
    assert.equal(store.countPending(), 0);
    assert.equal(store.countNeedsReview(), 0);
    store.close();
  });

  test('4. valid not_eligible structured output -> event marked delivered, no retry scheduled', async () => {
    const homeDir = scratch('agent-handoff-worker-home-');
    const { store, worker } = makeWorker({
      mode: 'not_eligible',
      structuredOverrides: { issueIdentifier: 'DEMO-1' },
      homeDir,
    });
    enqueue(store);
    await worker.pollOnce();
    assert.equal(store.countPending(), 0);
    assert.equal(store.countNeedsReview(), 0);
    store.close();
  });

  test('5. blocked outcome leaves the event pending with backoff scheduled, not delivered', async () => {
    const homeDir = scratch('agent-handoff-worker-home-');
    const { store, worker } = makeWorker({
      mode: 'blocked',
      structuredOverrides: { issueIdentifier: 'DEMO-1' },
      homeDir,
    });
    const eventId = enqueue(store);
    const before = Date.now();
    await worker.pollOnce();
    assert.equal(store.countPending(), 1, 'must remain pending, not delivered');
    const [row] = store.listPendingEvents();
    assert.equal(row.id, eventId);
    assert.equal(row.attemptCount, 1);
    assert.equal(row.lastOutcome, 'blocked');
    assert.ok(row.nextAttemptAt > before, 'backoff must push next_attempt_at into the future');
    // Not eligible again immediately (backoff not yet elapsed).
    assert.equal(store.listEligibleEvents(before + 1).length, 0);
    store.close();
  });

  test('5. failed outcome also leaves the event pending with backoff, and repeated failures move it to needs_review after the configured threshold', async () => {
    const homeDir = scratch('agent-handoff-worker-home-');
    const { store, worker } = makeWorker({
      mode: 'failed',
      structuredOverrides: { issueIdentifier: 'DEMO-1' },
      homeDir,
    });
    enqueue(store);

    // maxAttempts is 3 in BASE_CONFIG; drive 3 eligible attempts forward in
    // time past each backoff window.
    let cursor = Date.now();
    for (let i = 0; i < 3; i += 1) {
      const eligible = store.listEligibleEvents(cursor);
      assert.equal(eligible.length, 1, `attempt ${i + 1} should still be eligible`);
      // eslint-disable-next-line no-await-in-loop -- intentionally serial
      await worker.processEvent(eligible[0]);
      cursor += BASE_CONFIG.workerMaxBackoffMs + 1;
    }

    assert.equal(store.countPending(), 0);
    assert.equal(store.countNeedsReview(), 1, 'must be surfaced for review, never silently discarded');
    const [reviewRow] = store.listNeedsReview();
    assert.equal(reviewRow.attemptCount, 3);
    store.close();
  });

  test('6. malformed structured output leaves the event pending (fails closed)', async () => {
    const homeDir = scratch('agent-handoff-worker-home-');
    const { store, worker } = makeWorker({ mode: 'malformed', homeDir });
    enqueue(store);
    await worker.pollOnce();
    assert.equal(store.countPending(), 1);
    const [row] = store.listPendingEvents();
    assert.equal(row.lastOutcome, 'unparseable_envelope');
    store.close();
  });

  test('6. missing structured_output leaves the event pending (fails closed)', async () => {
    const homeDir = scratch('agent-handoff-worker-home-');
    const { store, worker } = makeWorker({ mode: 'missing_structured', homeDir });
    enqueue(store);
    await worker.pollOnce();
    assert.equal(store.countPending(), 1);
    const [row] = store.listPendingEvents();
    assert.equal(row.lastOutcome, 'missing_structured_output');
    store.close();
  });

  test('7. nonzero exit leaves the event pending (fails closed)', async () => {
    const homeDir = scratch('agent-handoff-worker-home-');
    const { store, worker } = makeWorker({ mode: 'nonzero', homeDir });
    enqueue(store);
    await worker.pollOnce();
    assert.equal(store.countPending(), 1);
    const [row] = store.listPendingEvents();
    assert.equal(row.lastOutcome, 'nonzero_exit');
    store.close();
  });

  test('7. a hung turn is killed and leaves the event pending as a timeout (fails closed)', async () => {
    const homeDir = scratch('agent-handoff-worker-home-');
    const store = new DurableStore(':memory:');
    const worker = createWorker({
      config: { ...BASE_CONFIG, workerTurnTimeoutMs: 300 },
      store,
      log: () => {},
      spawnClaudeTurnFn: fakeSpawnClaudeTurnFn({ mode: 'hang', homeDir }),
      homeDir,
      sessionId: 'fixed-test-session-id',
      reviewerSessionId: 'fixed-test-reviewer-session-id',
    });
    enqueue(store);
    await worker.pollOnce();
    assert.equal(store.countPending(), 1);
    const [row] = store.listPendingEvents();
    assert.equal(row.lastOutcome, 'timeout');
    store.close();
  });

  test('8. issue mismatch leaves the event pending (fails closed)', async () => {
    const homeDir = scratch('agent-handoff-worker-home-');
    // fakeClaude defaults to issueIdentifier "DEMO-FAKE"; the queued event
    // is "DEMO-1" — a genuine mismatch, not overridden here.
    const { store, worker } = makeWorker({ mode: 'success', homeDir });
    enqueue(store);
    await worker.pollOnce();
    assert.equal(store.countPending(), 1);
    const [row] = store.listPendingEvents();
    assert.equal(row.lastOutcome, 'issue_mismatch');
    store.close();
  });

  test('8. session mismatch leaves the event pending (fails closed)', async () => {
    const homeDir = scratch('agent-handoff-worker-home-');
    const { store, worker } = makeWorker({
      mode: 'session_mismatch',
      structuredOverrides: { issueIdentifier: 'DEMO-1' },
      homeDir,
    });
    enqueue(store);
    await worker.pollOnce();
    assert.equal(store.countPending(), 1);
    const [row] = store.listPendingEvents();
    assert.equal(row.lastOutcome, 'session_mismatch');
    store.close();
  });

  test('1/2. first turn uses --session-id, second turn (after transcript exists) uses --resume', async () => {
    const homeDir = scratch('agent-handoff-worker-home-');
    const argsLog = join(scratch('agent-handoff-worker-argslog-'), 'args.log');
    const { store, worker } = makeWorker({
      mode: 'success',
      structuredOverrides: { issueIdentifier: 'DEMO-1' },
      homeDir,
      argsLog,
    });
    enqueue(store, { deliveryId: 'd1', normalizedEvent: { issueIdentifier: 'DEMO-1' } });
    await worker.pollOnce();

    enqueue(store, { deliveryId: 'd2', normalizedEvent: { issueIdentifier: 'DEMO-1' } });
    await worker.pollOnce();

    const lines = readFileSync(argsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.ok(lines[0].includes('--session-id'), 'first invocation must create with --session-id');
    assert.ok(!lines[0].includes('--resume'));
    assert.ok(lines[1].includes('--resume'), 'second invocation must resume with --resume');
    assert.ok(!lines[1].includes('--session-id'));
    assert.equal(lines[0][lines[0].indexOf('--session-id') + 1], 'fixed-test-session-id');
    assert.equal(lines[1][lines[1].indexOf('--resume') + 1], 'fixed-test-session-id');
    store.close();
  });

  // DEMO-65 v1C: reconcileOnce() now runs TWO sub-calls per invocation — one
  // scoped to Todo/execute, one to In Review/review (see worker.js's
  // reconcileForState()) — returned as { execute, review } instead of a
  // flat result. This fixture's static fake response is Todo-shaped, so it
  // naturally satisfies the execute sub-call's expected scope and mismatches
  // the review sub-call's (expectedTargetState 'In Review') — a harmless,
  // expected scope_mismatch on that side, asserted explicitly below rather
  // than left unchecked.
  test('10/11. reconciliation upserts only routing identifiers and is idempotent for an already-pending issue', async () => {
    const homeDir = scratch('agent-handoff-worker-home-');
    const structured = {
      protocolVersion: 1,
      teamId: 'team-1',
      projectId: 'project-1',
      targetState: 'Todo',
      eligibleIssues: [{ issueIdentifier: 'DEMO-2', issueId: 'issue-2', url: 'https://linear.app/x/DEMO-2' }],
    };
    const { store, worker } = makeWorker({ mode: 'success', structuredOverrides: structured, homeDir, rawStructured: true });

    const first = await worker.reconcileOnce();
    assert.equal(first.execute.ok, true);
    assert.equal(first.execute.upserted, 1);
    assert.equal(first.review.ok, false, 'the Todo-shaped fixture must not satisfy the In-Review-scoped sub-call');
    assert.equal(first.review.upserted, 0);
    assert.equal(store.countPending(), 1);
    const [row] = store.listPendingEvents();
    assert.equal(row.issueIdentifier, 'DEMO-2');
    assert.equal(row.jobType, 'execute');
    assert.deepEqual(Object.keys(row.normalizedEvent).sort(), ['event', 'issueId', 'issueIdentifier', 'jobType', 'projectId', 'targetState', 'teamId', 'url']);

    // 11. Repeated reconciliation for the SAME still-eligible, still-pending issue must not duplicate it.
    const second = await worker.reconcileOnce();
    assert.equal(second.execute.ok, true);
    assert.equal(second.execute.upserted, 0, 'already-pending issue must not be upserted again');
    assert.equal(store.countPending(), 1);
    store.close();
  });

  test('10. reconciliation scope mismatch is not upserted (both sub-calls)', async () => {
    const homeDir = scratch('agent-handoff-worker-home-');
    const structured = {
      protocolVersion: 1,
      teamId: 'wrong-team',
      projectId: 'project-1',
      targetState: 'Todo',
      eligibleIssues: [{ issueIdentifier: 'DEMO-3', issueId: 'issue-3', url: null }],
    };
    const { store, worker } = makeWorker({ mode: 'success', structuredOverrides: structured, homeDir, rawStructured: true });
    const result = await worker.reconcileOnce();
    assert.equal(result.execute.ok, false);
    assert.equal(result.execute.evaluation.reason, 'scope_mismatch');
    assert.equal(result.review.ok, false);
    assert.equal(result.review.evaluation.reason, 'scope_mismatch');
    assert.equal(store.countPending(), 0);
    store.close();
  });

  // DEMO-65 v1C, requirement 6: reconciliation must recover missed In Review
  // (review) work too, not just Todo (execute) work, upserting it with the
  // correct job_type — and this issue's cycle must be freshly created since
  // no prior execute job for it exists in this test's store.
  test('v1C. reconciliation upserts a discovered In-Review-scoped issue as job_type=review', async () => {
    const homeDir = scratch('agent-handoff-worker-home-');
    const structured = {
      protocolVersion: 1,
      teamId: 'team-1',
      projectId: 'project-1',
      targetState: 'In Review',
      eligibleIssues: [{ issueIdentifier: 'DEMO-4', issueId: 'issue-4', url: 'https://linear.app/x/DEMO-4' }],
    };
    const { store, worker } = makeWorker({ mode: 'success', structuredOverrides: structured, homeDir, rawStructured: true });

    const result = await worker.reconcileOnce();
    assert.equal(result.execute.ok, false, 'the In-Review-shaped fixture must not satisfy the Todo-scoped sub-call');
    assert.equal(result.review.ok, true);
    assert.equal(result.review.upserted, 1);
    assert.equal(store.countPending(), 1);
    const [row] = store.listPendingEvents();
    assert.equal(row.issueIdentifier, 'DEMO-4');
    assert.equal(row.jobType, 'review');
    const cycle = store.getCycle('DEMO-4');
    assert.equal(cycle.status, 'active');
    assert.equal(cycle.revisionCount, 0);
    store.close();
  });

  test('9. two poller instances cannot both process the same eligible event (pollOnce is single-flight)', async () => {
    const homeDir = scratch('agent-handoff-worker-home-');
    let inFlightCount = 0;
    let maxConcurrent = 0;
    const store = new DurableStore(':memory:');
    const worker = createWorker({
      config: BASE_CONFIG,
      store,
      log: () => {},
      homeDir,
      sessionId: 'fixed-test-session-id',
      reviewerSessionId: 'fixed-test-reviewer-session-id',
      spawnClaudeTurnFn: async (params) => {
        inFlightCount += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlightCount);
        const result = await fakeSpawnClaudeTurnFn({
          mode: 'success',
          structuredOverrides: { issueIdentifier: 'DEMO-1' },
          homeDir,
        })(params);
        inFlightCount -= 1;
        return result;
      },
    });
    enqueue(store);

    const p1 = worker.pollOnce();
    const p2 = worker.pollOnce();
    await Promise.all([p1, p2]);
    assert.equal(maxConcurrent, 1, 'a second pollOnce call while one is in flight must not start concurrent processing');
    store.close();
  });

  test('12. restart preserves pending/retry state (fresh DurableStore instance against the same file)', async () => {
    const dir = scratch('agent-handoff-worker-restart-');
    const dbPath = join(dir, 'queue.db');
    const homeDir = scratch('agent-handoff-worker-home-');

    const first = makeWorker({ mode: 'blocked', structuredOverrides: { issueIdentifier: 'DEMO-1' }, dbPath, homeDir });
    enqueue(first.store);
    await first.worker.pollOnce();
    const beforeRestart = first.store.listPendingEvents()[0];
    assert.equal(beforeRestart.attemptCount, 1);
    first.store.close();

    // Simulate a full process restart: brand-new DurableStore + worker
    // instance against the same on-disk file.
    const second = makeWorker({ mode: 'blocked', structuredOverrides: { issueIdentifier: 'DEMO-1' }, dbPath, homeDir });
    const afterRestart = second.store.listPendingEvents()[0];
    assert.equal(afterRestart.id, beforeRestart.id);
    assert.equal(afterRestart.attemptCount, 1, 'attempt/backoff state must survive a restart');
    assert.equal(afterRestart.lastOutcome, 'blocked');
    second.store.close();
  });

  test('12. restart preserves the dedicated session id (via runtime dir, not in-memory state)', async () => {
    const { getOrCreateSessionId } = await import('../src/sessionIdentity.js');
    const runtimeDir = join(scratch('agent-handoff-worker-restart-sid-'), 'runtime');
    const before = getOrCreateSessionId(runtimeDir);
    const after = getOrCreateSessionId(runtimeDir); // simulates a fresh process reading the same dir
    assert.equal(before, after);
  });

  test('1. at most one Claude child runs at a time across pollOnce() and reconcileOnce() combined, and only the first turn creates the session', async () => {
    const homeDir = scratch('agent-handoff-worker-home-');
    const argsLog = join(scratch('agent-handoff-worker-argslog-'), 'args.log');
    let inFlightCount = 0;
    let maxConcurrent = 0;

    const store = new DurableStore(':memory:');
    enqueue(store, { deliveryId: 'd1', normalizedEvent: { issueIdentifier: 'DEMO-1' } });
    enqueue(store, { deliveryId: 'd2', normalizedEvent: { issueIdentifier: 'DEMO-2' } });

    // 'delayed' gives every turn a real, short pause before completing —
    // long enough that if pollOnce()'s and reconcileOnce()'s turns were NOT
    // serialized through one exclusive queue, firing them concurrently
    // (exactly as worker.start() and overlapping periodic timers do) would
    // very likely produce an observable overlap.
    const trackedSpawn = fakeSpawnClaudeTurnFn({ mode: 'delayed', homeDir, argsLog });
    const worker = createWorker({
      config: BASE_CONFIG,
      store,
      log: () => {},
      homeDir,
      sessionId: 'fixed-test-session-id',
      reviewerSessionId: 'fixed-test-reviewer-session-id',
      spawnClaudeTurnFn: async (params) => {
        inFlightCount += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlightCount);
        try {
          return await trackedSpawn(params);
        } finally {
          inFlightCount -= 1;
        }
      },
    });

    // Fire reconcileOnce() and pollOnce() concurrently, without awaiting
    // either first — the exact pattern the finding identified in
    // worker.js's start() and in overlapping periodic timers.
    await Promise.all([worker.reconcileOnce(), worker.pollOnce()]);

    assert.equal(maxConcurrent, 1, 'no two Claude children may ever run at the same time for this dedicated session');

    // DEMO-65 v1C: reconcileOnce() now performs TWO sub-turns (Todo/execute-
    // scoped, then In-Review/review-scoped — see worker.js's
    // reconcileOnceInner()), so the total is 2 reconciliation turns + 2
    // queued execute jobs = 4, not 3. The invariant this test exists to
    // prove — exactly one exclusive lane, correct create-then-resume
    // derivation — is unchanged; only the exact count reflects the
    // intentionally widened reconciliation scope.
    const lines = readFileSync(argsLog, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.equal(lines.length, 4, 'reconciliation (execute-scoped + review-scoped) + 2 queued jobs = 4 turns total');
    const createCalls = lines.filter((l) => l.includes('--session-id'));
    const resumeCalls = lines.filter((l) => l.includes('--resume'));
    assert.equal(createCalls.length, 1, 'exactly one turn may create the session with --session-id');
    assert.equal(resumeCalls.length, 3, 'every other turn must --resume, never create again');
    store.close();
  });

  test('5. shutdown() waits for the FULL operation (turn + evaluate + persist) to settle before it resolves, not just the raw Claude child', async () => {
    const homeDir = scratch('agent-handoff-worker-home-');
    const store = new DurableStore(':memory:');
    const worker = createWorker({
      config: { ...BASE_CONFIG, workerShutdownGraceMs: 200 },
      store,
      log: () => {},
      homeDir,
      sessionId: 'fixed-test-session-id',
      reviewerSessionId: 'fixed-test-reviewer-session-id',
      spawnClaudeTurnFn: fakeSpawnClaudeTurnFn({ mode: 'hang', homeDir }),
    });
    enqueue(store);

    const pollPromise = worker.pollOnce(); // starts a turn that hangs forever unless aborted
    await new Promise((r) => setTimeout(r, 50)); // let the real child actually start hanging

    const start = Date.now();
    await worker.shutdown({ gracefulTimeoutMs: 200 });
    const elapsed = Date.now() - start;

    // The critical assertion (per the finding this test previously failed to
    // prove): checked IMMEDIATELY after `await worker.shutdown()` returns,
    // BEFORE separately awaiting `pollPromise` at all. If shutdown() only
    // waited for the raw Claude child (the prior, insufficient shape) and
    // not the subsequent evaluateCompletionResult()/store.recordAttemptFailure()
    // step inside processEvent(), this durable state would not reliably be
    // present yet at this exact point — workerEntry.js would be free to
    // close the store and exit before the fail-closed record was written.
    assert.ok(elapsed < 6000, `shutdown must resolve promptly (bounded), not hang forever (took ${elapsed}ms)`);
    assert.equal(
      store.countPending(),
      1,
      'the event must already be recorded as pending (never delivered) the instant shutdown() returns',
    );
    const [row] = store.listPendingEvents();
    assert.equal(
      row.lastOutcome,
      'signal',
      'the aborted child must already be recorded as a failed (fail-closed) attempt the instant shutdown() returns',
    );
    assert.equal(row.attemptCount, 1, 'the failed attempt must already be counted the instant shutdown() returns');

    // Secondary, best-effort check (per the review: "ideally also assert
    // the active poll/work promise is already settled when shutdown
    // returns"): the primary assertions above do not depend on this at
    // all — they hold regardless of whether pollPromise's own outer
    // wrapper promise has been flushed to a listener yet — but a single
    // microtask-queue flush is enough to observe it too, since
    // processEvent()'s settlement (which the primary assertions already
    // prove happened before shutdown() returned) is what pollOnce()'s loop
    // was itself awaiting.
    let pollSettled = false;
    pollPromise.then(
      () => {
        pollSettled = true;
      },
      () => {
        pollSettled = true;
      },
    );
    // Drain the full microtask queue (setImmediate only runs after all
    // pending microtasks/promise continuations have flushed) rather than a
    // single `await Promise.resolve()` — pollOnce()'s outer wrapper promise
    // settles a few microtask hops after processEvent() itself settles
    // (loop continuation, async-function return, then its own .finally()),
    // so a single hop is not always enough to observe it, even though it
    // was already unavoidably scheduled by the time shutdown() returned.
    await new Promise((r) => setImmediate(r));
    assert.equal(pollSettled, true, 'the active poll operation must already be settled by the time shutdown() has returned');

    store.close();
  });

  // --- DEMO-65 v1C: Opus review leg integration tests ---

  // Builds a spawnClaudeTurnFn like fakeSpawnClaudeTurnFn(), but returns a
  // REVIEW-shaped structured_output (rawStructured) regardless of which
  // job_type the worker is actually processing — sufficient for tests that
  // only ever enqueue review jobs against this worker instance.
  function fakeReviewSpawnClaudeTurnFn({ homeDir, argsLog, reviewStructured, mode = 'success' }) {
    return fakeSpawnClaudeTurnFn({ mode, homeDir, argsLog, structuredOverrides: reviewStructured, rawStructured: true });
  }

  function validReviewStructured(overrides = {}) {
    return {
      protocolVersion: 1,
      issueIdentifier: 'DEMO-1',
      outcome: 'pass',
      canonicalStatus: 'Done',
      resultPosted: true,
      verifiedTeamId: 'team-1',
      verifiedProjectId: 'project-1',
      verifiedPickupState: 'In Review',
      reviewActionToken: 'placeholder-must-be-overridden',
      summary: 'reviewed',
      ...overrides,
    };
  }

  // The token the NEXT attempt against this issue will be evaluated
  // against — computed the exact same way worker.js's processReviewEventInner()
  // does, from the issue's current durable cycle_id + trusted revision_count.
  // Must be called AFTER the event whose attempt it's for is already
  // enqueued (so the cycle exists) and BEFORE that attempt's pollOnce().
  function currentReviewToken(store, issueIdentifier) {
    const cycle = store.getCycle(issueIdentifier);
    return computeReviewActionToken(cycle.cycleId, cycle.revisionCount);
  }

  test('v1C. valid pass review outcome -> event delivered, cycle status=done', async () => {
    const homeDir = scratch('agent-handoff-worker-home-');
    const store = new DurableStore(':memory:');
    enqueueReview(store);
    const token = currentReviewToken(store, 'DEMO-1');
    const worker = createWorker({
      config: BASE_CONFIG,
      store,
      log: () => {},
      homeDir,
      sessionId: 'fixed-test-session-id',
      reviewerSessionId: 'fixed-test-reviewer-session-id',
      spawnClaudeTurnFn: fakeReviewSpawnClaudeTurnFn({ homeDir, reviewStructured: validReviewStructured({ reviewActionToken: token }) }),
    });
    await worker.pollOnce();
    assert.equal(store.countPending(), 0);
    assert.equal(store.countNeedsReview(), 0);
    assert.equal(store.getCycle('DEMO-1').status, 'done');
    store.close();
  });

  // DEMO-65 requirement 10: `REVISION REQUIRED` increments revision count
  // exactly once and transitions the cycle back to Todo territory (stays
  // 'active' so the re-entered Todo issue can be picked up by the execute
  // leg again — see durableStore.js's markReviewDelivered()).
  test('10. valid revision_required review outcome -> event delivered, revision_count incremented exactly once, cycle stays active', async () => {
    const homeDir = scratch('agent-handoff-worker-home-');
    const store = new DurableStore(':memory:');
    enqueueReview(store);
    const token = currentReviewToken(store, 'DEMO-1');
    const worker = createWorker({
      config: BASE_CONFIG,
      store,
      log: () => {},
      homeDir,
      sessionId: 'fixed-test-session-id',
      reviewerSessionId: 'fixed-test-reviewer-session-id',
      spawnClaudeTurnFn: fakeReviewSpawnClaudeTurnFn({
        homeDir,
        reviewStructured: validReviewStructured({ outcome: 'revision_required', canonicalStatus: 'Todo', reviewActionToken: token }),
      }),
    });
    await worker.pollOnce();
    assert.equal(store.countPending(), 0, 'delivered, not left pending — the review itself succeeded');
    const cycle = store.getCycle('DEMO-1');
    assert.equal(cycle.status, 'active');
    assert.equal(cycle.revisionCount, 1);
    store.close();
  });

  // DEMO-65 requirement 11: after REVISION REQUIRED moves the cycle back to
  // Todo territory, the execute leg can pick the SAME issue/cycle up again
  // (a fresh Todo-transition event, same cycle_id), and a subsequent review
  // can run again — proving the loop, not just one round of it.
  test('11. the revision loop can execute then review again after Todo re-entry, reusing the same cycle', async () => {
    const homeDir = scratch('agent-handoff-worker-home-');
    const store = new DurableStore(':memory:');

    // Round 1: an execute job for DEMO-1 completes (real completed outcome),
    // creating the initial cycle.
    const execWorker = createWorker({
      config: BASE_CONFIG,
      store,
      log: () => {},
      homeDir,
      sessionId: 'fixed-test-session-id',
      reviewerSessionId: 'fixed-test-reviewer-session-id',
      spawnClaudeTurnFn: fakeSpawnClaudeTurnFn({ mode: 'success', structuredOverrides: { issueIdentifier: 'DEMO-1' }, homeDir }),
    });
    enqueue(store, { deliveryId: 'r1-exec' });
    await execWorker.pollOnce();
    const cycleAfterExecute = store.getCycle('DEMO-1');
    assert.equal(cycleAfterExecute.status, 'active');

    // Round 1's review: revision_required.
    enqueueReview(store, { deliveryId: 'r1-review' });
    const round1Token = currentReviewToken(store, 'DEMO-1');
    const reviewWorker1 = createWorker({
      config: BASE_CONFIG,
      store,
      log: () => {},
      homeDir,
      sessionId: 'fixed-test-session-id',
      reviewerSessionId: 'fixed-test-reviewer-session-id',
      spawnClaudeTurnFn: fakeReviewSpawnClaudeTurnFn({
        homeDir,
        reviewStructured: validReviewStructured({ outcome: 'revision_required', canonicalStatus: 'Todo', reviewActionToken: round1Token }),
      }),
    });
    await reviewWorker1.pollOnce();
    assert.equal(store.getCycle('DEMO-1').revisionCount, 1);

    // Round 2: a fresh Todo-transition event for the SAME issue must be
    // acceptable (cycle is still 'active') and reuse the SAME cycle_id.
    const secondExecEventId = enqueue(store, { deliveryId: 'r2-exec' });
    assert.ok(secondExecEventId, 'a fresh execute job must be enqueueable for the re-opened issue');
    const [pendingRow] = store.listPendingEvents();
    assert.equal(pendingRow.cycleId, cycleAfterExecute.cycleId, 'round 2 must reuse the SAME cycle, not start a new one');

    const execWorker2 = createWorker({
      config: BASE_CONFIG,
      store,
      log: () => {},
      homeDir,
      sessionId: 'fixed-test-session-id',
      reviewerSessionId: 'fixed-test-reviewer-session-id',
      spawnClaudeTurnFn: fakeSpawnClaudeTurnFn({ mode: 'success', structuredOverrides: { issueIdentifier: 'DEMO-1' }, homeDir }),
    });
    await execWorker2.pollOnce();
    assert.equal(store.countPending(), 0);

    // Round 2's review: pass this time. Token must reflect revisionCount=1 now.
    enqueueReview(store, { deliveryId: 'r2-review' });
    const round2Token = currentReviewToken(store, 'DEMO-1');
    assert.notEqual(round2Token, round1Token, 'round 2 token must differ from round 1 (revision_count advanced)');
    const reviewWorker2 = createWorker({
      config: BASE_CONFIG,
      store,
      log: () => {},
      homeDir,
      sessionId: 'fixed-test-session-id',
      reviewerSessionId: 'fixed-test-reviewer-session-id',
      spawnClaudeTurnFn: fakeReviewSpawnClaudeTurnFn({ homeDir, reviewStructured: validReviewStructured({ reviewActionToken: round2Token }) }),
    });
    await reviewWorker2.pollOnce();

    const finalCycle = store.getCycle('DEMO-1');
    assert.equal(finalCycle.status, 'done');
    assert.equal(finalCycle.revisionCount, 1, 'only round 1 incremented it; round 2 passed');
    assert.equal(finalCycle.cycleId, cycleAfterExecute.cycleId, 'the whole loop stayed one cycle');
    store.close();
  });

  // DEMO-65 requirement 12: after the max (3) automatic revision cycles, the
  // next revision_required request must fail closed rather than be
  // silently accepted — proving the loop cannot exceed its bound even
  // against a misbehaving/miscounting turn.
  test('12. a 4th revision_required attempt at the revision limit fails closed, not delivered', async () => {
    const homeDir = scratch('agent-handoff-worker-home-');
    const store = new DurableStore(':memory:');

    // Seed a cycle already at the max via 3 real revision_required rounds.
    // Each round's token must be recomputed fresh (revision_count advances
    // each time), so the worker is rebuilt per round with a token matching
    // that round's actual trusted count.
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- intentionally serial seeding
      enqueueReview(store, { deliveryId: `seed-${i}` });
      const roundToken = currentReviewToken(store, 'DEMO-1');
      const seedWorker = createWorker({
        config: BASE_CONFIG,
        store,
        log: () => {},
        homeDir,
        sessionId: 'fixed-test-session-id',
        reviewerSessionId: 'fixed-test-reviewer-session-id',
        spawnClaudeTurnFn: fakeReviewSpawnClaudeTurnFn({
          homeDir,
          reviewStructured: validReviewStructured({ outcome: 'revision_required', canonicalStatus: 'Todo', reviewActionToken: roundToken }),
        }),
      });
      // eslint-disable-next-line no-await-in-loop -- intentionally serial seeding
      await seedWorker.pollOnce();
    }
    assert.equal(store.getCycle('DEMO-1').revisionCount, 3);

    // A 4th review turn STILL claims revision_required (a misbehaving/
    // confused turn that ignored the prompt's limit wording), reporting the
    // CORRECT token for this attempt — the worker's own trusted revision
    // count must reject this regardless of the token being right.
    enqueueReview(store, { deliveryId: 'over-limit' });
    const overLimitToken = currentReviewToken(store, 'DEMO-1');
    const worker = createWorker({
      config: BASE_CONFIG,
      store,
      log: () => {},
      homeDir,
      sessionId: 'fixed-test-session-id',
      reviewerSessionId: 'fixed-test-reviewer-session-id',
      spawnClaudeTurnFn: fakeReviewSpawnClaudeTurnFn({
        homeDir,
        reviewStructured: validReviewStructured({ outcome: 'revision_required', canonicalStatus: 'Todo', reviewActionToken: overLimitToken }),
      }),
    });
    await worker.pollOnce();

    assert.equal(store.countPending(), 1, 'must fail closed, never delivered');
    const [row] = store.listPendingEvents();
    assert.equal(row.lastOutcome, 'revision_limit_exceeded_must_be_needs_human');
    assert.equal(store.getCycle('DEMO-1').revisionCount, 3, 'the rejected attempt must not further increment the trusted count');
    store.close();
  });

  // DEMO-65 requirement 7: review turns must use the separate reviewer
  // session identity (never the executor's) and explicit Opus model
  // selection.
  test('7. review turns use --model opus and the separate reviewer session id, never the executor session id', async () => {
    const homeDir = scratch('agent-handoff-worker-home-');
    const argsLog = join(scratch('agent-handoff-worker-argslog-'), 'args.log');
    const store = new DurableStore(':memory:');
    enqueueReview(store);
    const token = currentReviewToken(store, 'DEMO-1');
    const worker = createWorker({
      config: BASE_CONFIG,
      store,
      log: () => {},
      homeDir,
      sessionId: 'fixed-test-session-id',
      reviewerSessionId: 'fixed-test-reviewer-session-id',
      spawnClaudeTurnFn: fakeReviewSpawnClaudeTurnFn({ homeDir, argsLog, reviewStructured: validReviewStructured({ reviewActionToken: token }) }),
    });
    await worker.pollOnce();

    const [line] = readFileSync(argsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(line.includes('--model'), 'review turn must pass --model');
    assert.equal(line[line.indexOf('--model') + 1], 'opus', 'review turn must request the opus model exactly');
    assert.ok(line.includes('--session-id'), 'first-ever turn for the reviewer session must create it');
    assert.equal(line[line.indexOf('--session-id') + 1], 'fixed-test-reviewer-session-id');
    assert.ok(!line.includes('fixed-test-session-id'), 'the executor session id must never appear on a review turn');
    store.close();
  });

  // DEMO-65 requirement 8: execute and review jobs still share exactly one
  // global exclusive Claude-operation lane — max concurrent children = 1,
  // even when both job types are queued together.
  test('8. execute and review jobs share one exclusive lane: max concurrent children = 1', async () => {
    const homeDir = scratch('agent-handoff-worker-home-');
    let inFlightCount = 0;
    let maxConcurrent = 0;
    const store = new DurableStore(':memory:');
    enqueue(store, { deliveryId: 'mix-exec' });
    enqueueReview(store, { deliveryId: 'mix-review', normalizedEvent: { issueIdentifier: 'DEMO-2' } });
    const reviewToken = currentReviewToken(store, 'DEMO-2');

    const trackedExecSpawn = fakeSpawnClaudeTurnFn({ mode: 'delayed', homeDir, structuredOverrides: { issueIdentifier: 'DEMO-1' } });
    const trackedReviewSpawn = fakeReviewSpawnClaudeTurnFn({
      homeDir,
      reviewStructured: validReviewStructured({ issueIdentifier: 'DEMO-2', reviewActionToken: reviewToken }),
    });
    const worker = createWorker({
      config: BASE_CONFIG,
      store,
      log: () => {},
      homeDir,
      sessionId: 'fixed-test-session-id',
      reviewerSessionId: 'fixed-test-reviewer-session-id',
      spawnClaudeTurnFn: async (params) => {
        inFlightCount += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlightCount);
        try {
          // Route by which session id this particular turn is using —
          // exactly how the real worker distinguishes execute vs review
          // turns at spawn time.
          const spawnFn = params.sessionId === 'fixed-test-reviewer-session-id' ? trackedReviewSpawn : trackedExecSpawn;
          return await spawnFn(params);
        } finally {
          inFlightCount -= 1;
        }
      },
    });

    await worker.pollOnce();
    assert.equal(maxConcurrent, 1, 'an execute and a review job must never run concurrently');
    assert.equal(store.countPending(), 0);
    store.close();
  });

  // DEMO-65 requirement 15: restart preserves job_type/cycle/revision state
  // and does not replay a completed review cycle — exercised end-to-end
  // through the worker + a fresh DurableStore instance against the same file.
  test('15. restart does not replay a completed review cycle (exhausted cycle stays refused after restart)', async () => {
    const dir = scratch('agent-handoff-worker-restart-review-');
    const dbPath = join(dir, 'queue.db');
    const homeDir = scratch('agent-handoff-worker-home-');

    const first = new DurableStore(dbPath);
    enqueueReview(first);
    const token = currentReviewToken(first, 'DEMO-1');
    const firstWorker = createWorker({
      config: BASE_CONFIG,
      store: first,
      log: () => {},
      homeDir,
      sessionId: 'fixed-test-session-id',
      reviewerSessionId: 'fixed-test-reviewer-session-id',
      spawnClaudeTurnFn: fakeReviewSpawnClaudeTurnFn({ homeDir, reviewStructured: validReviewStructured({ reviewActionToken: token }) }),
    });
    await firstWorker.pollOnce();
    assert.equal(first.getCycle('DEMO-1').status, 'done');
    first.close();

    // Simulate a full process restart against the same on-disk file.
    const second = new DurableStore(dbPath);
    assert.equal(second.getCycle('DEMO-1').status, 'done', 'terminal cycle status must survive a restart');
    const reopenAttempt = second.recordDelivery({
      deliveryId: 'post-restart-reopen',
      now: Date.now(),
      relevant: true,
      reason: 'accepted',
      issueIdentifier: 'DEMO-1',
      normalizedEvent: { ...NORMALIZED_EVENT, issueIdentifier: 'DEMO-1' },
      jobType: 'execute',
    });
    assert.equal(reopenAttempt.eventId, undefined, 'an exhausted cycle must not be reopened even after a restart');
    assert.equal(reopenAttempt.skipReason, 'cycle_exhausted');
    second.close();
  });

  // --- DEMO-65 proof-derived correction: crash-safety recovery across the
  // external-Linear-mutation / local-durable-commit gap. Opus's turn mutates
  // Linear (posts its comment, transitions state) INSIDE the spawned child;
  // only after that turn exits does the worker evaluate+persist. If the
  // process crashes in between, the local row stays pending while Linear has
  // already moved. Because the review action token is deterministic from
  // (cycle_id, trustedRevisionCount) — unchanged by a crash, since nothing
  // was persisted — a RETRY of the very same pending row computes the exact
  // SAME token, so a turn that recognizes its (or a crashed predecessor's)
  // already-posted matching-token comment can safely report the same
  // outcome again and the worker finalizes it exactly once. ---

  // Attempt 1: the whole child process is lost (mode='crash' -> real
  // SIGKILL, no stdout at all — the closest this local harness can get to
  // "Opus already mutated Linear for real, but the host died before this
  // process could receive/persist its own turn's output"). Asserts the row
  // stayed pending and the trusted revision_count is untouched, then
  // returns the token the NEXT attempt will need to match to recover.
  async function crashOnce(store, homeDir) {
    const tokenBeforeCrash = currentReviewToken(store, 'DEMO-1');
    const crashWorker = createWorker({
      config: BASE_CONFIG,
      store,
      log: () => {},
      homeDir,
      sessionId: 'fixed-test-session-id',
      reviewerSessionId: 'fixed-test-reviewer-session-id',
      spawnClaudeTurnFn: fakeReviewSpawnClaudeTurnFn({ homeDir, mode: 'crash' }),
    });
    await crashWorker.pollOnce();
    assert.equal(store.countPending(), 1, 'crashed attempt must leave the row pending, not delivered');
    const tokenAfterCrash = currentReviewToken(store, 'DEMO-1');
    assert.equal(tokenAfterCrash, tokenBeforeCrash, 'the token must be IDENTICAL across the crash boundary — nothing was persisted to change it');
    return tokenAfterCrash;
  }

  // DEMO-65 requirement 1 (revision_required crash window): simulate Opus
  // comment + Linear state already changed to Todo, but local
  // markReviewDelivered() not committed (the crash); after retry, the same
  // review decision is finalized exactly once and revision_count increments
  // exactly once — not twice, proving the crash didn't cause the retry to
  // be treated as a brand-new, additional revision round.
  test('1. revision_required crash window: retry reporting the same deterministic token finalizes exactly once, revision_count increments exactly once', async () => {
    const homeDir = scratch('agent-handoff-worker-home-');
    const store = new DurableStore(':memory:');
    enqueueReview(store);
    const recoveredToken = await crashOnce(store, homeDir);

    // Retry: a turn that (per the corrected prompt) recognized its own
    // already-posted [OPUS REVIEW #<token>] comment and reports the SAME
    // outcome + token again, without taking a new Linear action.
    const recoveryWorker = createWorker({
      config: BASE_CONFIG,
      store,
      log: () => {},
      homeDir,
      sessionId: 'fixed-test-session-id',
      reviewerSessionId: 'fixed-test-reviewer-session-id',
      now: () => Date.now() + 10_000, // past the crashed attempt's backoff window
      spawnClaudeTurnFn: fakeReviewSpawnClaudeTurnFn({
        homeDir,
        reviewStructured: validReviewStructured({ outcome: 'revision_required', canonicalStatus: 'Todo', reviewActionToken: recoveredToken }),
      }),
    });
    await recoveryWorker.pollOnce();

    assert.equal(store.countPending(), 0, 'must finalize on the recovery retry');
    const cycle = store.getCycle('DEMO-1');
    assert.equal(cycle.status, 'active');
    assert.equal(cycle.revisionCount, 1, 'exactly once — the crashed attempt must not have counted, and recovery must not double-count');
    store.close();
  });

  // DEMO-65 requirement 2 (pass crash window): Linear already Done + matching
  // correlated PASS action exists, local review row still pending; restart
  // finalizes cycle done, clears the pending review row, and does not
  // re-run review as a fresh decision.
  test('2. pass crash window: retry reporting the same deterministic token finalizes cycle=done exactly once', async () => {
    const homeDir = scratch('agent-handoff-worker-home-');
    const store = new DurableStore(':memory:');
    enqueueReview(store);
    const recoveredToken = await crashOnce(store, homeDir);

    const recoveryWorker = createWorker({
      config: BASE_CONFIG,
      store,
      log: () => {},
      homeDir,
      sessionId: 'fixed-test-session-id',
      reviewerSessionId: 'fixed-test-reviewer-session-id',
      now: () => Date.now() + 10_000, // past the crashed attempt's backoff window
      spawnClaudeTurnFn: fakeReviewSpawnClaudeTurnFn({
        homeDir,
        reviewStructured: validReviewStructured({ reviewActionToken: recoveredToken }),
      }),
    });
    await recoveryWorker.pollOnce();

    assert.equal(store.countPending(), 0);
    assert.equal(store.getCycle('DEMO-1').status, 'done');
    store.close();
  });

  // DEMO-65 requirement 3 (needs_human equivalent): same guarantee with
  // terminal cycle needs_human.
  test('3. needs_human crash window: retry reporting the same deterministic token finalizes cycle=needs_human exactly once', async () => {
    const homeDir = scratch('agent-handoff-worker-home-');
    const store = new DurableStore(':memory:');
    enqueueReview(store);
    const recoveredToken = await crashOnce(store, homeDir);

    const recoveryWorker = createWorker({
      config: BASE_CONFIG,
      store,
      log: () => {},
      homeDir,
      sessionId: 'fixed-test-session-id',
      reviewerSessionId: 'fixed-test-reviewer-session-id',
      now: () => Date.now() + 10_000, // past the crashed attempt's backoff window
      spawnClaudeTurnFn: fakeReviewSpawnClaudeTurnFn({
        homeDir,
        reviewStructured: validReviewStructured({ outcome: 'needs_human', reviewActionToken: recoveredToken }),
      }),
    });
    await recoveryWorker.pollOnce();

    assert.equal(store.countPending(), 0);
    assert.equal(store.getCycle('DEMO-1').status, 'needs_human');
    store.close();
  });

  // DEMO-65 requirement 4: a stale/mismatched prior review comment/action
  // must NOT satisfy recovery for the current cycle/review event — a token
  // that merely looks plausible (e.g. belongs to an earlier or later
  // revision round) must fail closed, not be silently accepted as
  // finalizing this decision.
  test('4. a stale/mismatched token after a crash must NOT satisfy recovery — fails closed, no finalization', async () => {
    const homeDir = scratch('agent-handoff-worker-home-');
    const store = new DurableStore(':memory:');
    enqueueReview(store);
    await crashOnce(store, homeDir);

    const staleToken = 'some-other-cycle-id-r7'; // plausible-looking, but wrong
    const recoveryWorker = createWorker({
      config: BASE_CONFIG,
      store,
      log: () => {},
      homeDir,
      sessionId: 'fixed-test-session-id',
      reviewerSessionId: 'fixed-test-reviewer-session-id',
      now: () => Date.now() + 10_000, // past the crashed attempt's backoff window
      spawnClaudeTurnFn: fakeReviewSpawnClaudeTurnFn({
        homeDir,
        reviewStructured: validReviewStructured({ reviewActionToken: staleToken }),
      }),
    });
    await recoveryWorker.pollOnce();

    assert.equal(store.countPending(), 1, 'must remain pending — a stale token must never finalize the decision');
    const [row] = store.listPendingEvents();
    assert.equal(row.lastOutcome, 'review_action_token_mismatch');
    const cycle = store.getCycle('DEMO-1');
    assert.equal(cycle.status, 'active');
    assert.equal(cycle.revisionCount, 0, 'a stale-token attempt must not mutate the cycle at all');
    store.close();
  });
}
