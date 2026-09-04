// DEMO-62 one-shot-worker revision (replaces src/channelServer.js /
// channelRunnerEntry.js). Supervised local Node poller: watches the
// durable SQLite queue and, for each eligible job, launches exactly one
// non-interactive `claude -p --resume <dedicated-session-id>` turn, then
// exits that turn — no Channel, no PTY, no tmux, no persistently-open
// Claude session sitting idle between jobs.
//
//   verified Linear event -> durable SQLite queue -> this poller
//   -> claude -p --resume <exact-session-id> -> canonical Linear re-fetch
//   -> Sonnet executes task -> process exits
//
// A queue row is marked delivered only when evaluateCompletionResult()
// (src/claudeInvoker.js) returns ok:true — every other path (blocked,
// failed, malformed/missing structured output, session or issue mismatch,
// timeout, signal, nonzero exit) fails closed via
// store.recordAttemptFailure(), which schedules a bounded-backoff retry
// and, after config.workerMaxAttempts, moves the row to 'needs_review'
// instead of retrying forever — never silently discarded.
//
// Mandatory canonical reconciliation (startup + periodic) replaces the old
// Channel's startup_reconcile signal: transport/process success was never
// proof of execution, so every so often (and always once at startup) the
// worker asks Linear, via a separate read-only claude -p turn, which
// issues are CURRENTLY eligible for the configured team/project/state, and
// upserts any missing ones into the queue — protecting against missed
// webhooks, an over-optimistic completion report, or a crash/reboot gap.
//
// DEMO-62 revision (PR #9 HEAD f5a9a52 review, finding 1): every Claude
// invocation — execution turns from pollOnce() AND reconciliation turns
// from reconcileOnce() — funnels through ONE global exclusive queue
// (runExclusiveTurn/`chain` below), not just pollOnce()'s own single-flight
// guard. This is on top of, not instead of, pollOnce()'s single-flight
// (which still prevents a second overlapping *pass* from starting) —
// runExclusiveTurn is what guarantees at most one `claude` child process
// exists at any moment for this dedicated session, regardless of which
// caller (poll or reconcile, initial or periodic-timer-triggered) reaches
// it first.
//
// DEMO-62 revision (PR #9 HEAD 7c14e76 review, finding 5 residual): the
// exclusive queue wraps the ENTIRE processEvent()/reconcileOnce() body —
// the raw Claude turn AND the post-turn evaluate/persist step
// (store.markDelivered()/recordAttemptFailure()) — not merely the raw
// spawnClaudeTurnFn() call. This matters specifically for shutdown():
// `chain` only settles once the function passed to runExclusiveTurn
// returns, so `await chain` in shutdown() cannot resume until the durable
// persistence write has actually happened. Wrapping only the raw turn
// (the prior shape) let `chain` resolve as soon as the aborted Claude
// child exited — before evaluateCompletionResult()/store.recordAttemptFailure()
// ran — so shutdown() could return, and workerEntry.js could close the
// store and exit, before the fail-closed record was durably written.

import { spawnClaudeTurn, evaluateCompletionResult, evaluateReconciliationResult, evaluateReviewResult } from './claudeInvoker.js';
import { completionJsonSchema, reconciliationJsonSchema, reviewJsonSchema } from './completionSchema.js';
import { buildExecutionPrompt, buildReviewPrompt, buildReconciliationPrompt } from './prompts.js';
import { getOrCreateSessionId, sessionTranscriptExists, REVIEWER_SESSION_ID_FILE_NAME } from './sessionIdentity.js';
import { REVIEW_TARGET_STATE_NAME } from './webhookClassifier.js';

// DEMO-65 proof-derived correction: deterministic per-decision token closing
// the crash gap between Opus mutating Linear and this worker's local
// markReviewDelivered() commit. Deliberately a pure function of (cycleId,
// revisionCount) — the SAME two durable values every attempt of the SAME
// logical decision reads before spawning its turn — so it is stable across
// crash+retry without needing any new durable field of its own: a retry
// only ever sees a different revisionCount once markReviewDelivered() has
// already advanced it, i.e. once the PRIOR decision is already finalized.
// Exported for tests.
export function computeReviewActionToken(cycleId, revisionCount) {
  return `${cycleId}-r${revisionCount}`;
}

export function createWorker({
  config,
  store,
  log = () => {},
  spawnClaudeTurnFn = spawnClaudeTurn,
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  homeDir = process.env.HOME,
  sessionId = getOrCreateSessionId(config.runtimeDataDir),
  // DEMO-65 v1C: review jobs run as "a separate Opus reviewer, not as the
  // Sonnet execution context" — a second, independently stable session id,
  // never the executor's.
  reviewerSessionId = getOrCreateSessionId(config.runtimeDataDir, REVIEWER_SESSION_ID_FILE_NAME),
}) {
  let pollTimer;
  let reconcileTimer;
  let pollInFlight = null;
  // The exclusive-turn mutex: a promise chain every Claude invocation is
  // appended to, so only one is ever actually running. Also doubles as
  // "the current in-flight turn" for shutdown() to bound-wait on. DEMO-65:
  // shared unchanged by both the execute and the review leg, so at most one
  // Claude child (executor OR reviewer) ever runs at a time system-wide.
  let chain = Promise.resolve();
  let currentAbortController = null;

  function isFirstLaunchFor(id) {
    return !sessionTranscriptExists({ projectRoot: config.projectRoot, sessionId: id, homeDir });
  }

  function runExclusiveTurn(taskFn) {
    const run = chain.then(taskFn, taskFn);
    // Keep the chain alive regardless of outcome, without leaking this
    // internal continuation's rejection as an unhandled one — the real
    // result/rejection is still returned to the caller via `run`.
    chain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  // Only the raw Claude child spawn — no longer separately wrapped in
  // runExclusiveTurn (see the finding-5-residual comment above). Callers
  // (processEventInner/reconcileOnceInner) always run inside an
  // already-exclusive context, so this doesn't need its own exclusivity.
  //
  // DEMO-65 v1C: gained `turnSessionId`/`extraArgs` (default to the executor
  // session / no extra args, so every pre-v1C call site is unaffected) so
  // the SAME raw-spawn plumbing serves both the execute leg (executor
  // session) and the review leg (reviewer session, `--model opus`).
  async function runTurnRaw({ prompt, jsonSchema, timeoutMs, turnSessionId = sessionId, extraArgs = [] }) {
    const abortController = new AbortController();
    currentAbortController = abortController;
    try {
      return await spawnClaudeTurnFn({
        claudeBin: config.claudeBin,
        cwd: config.projectRoot,
        sessionId: turnSessionId,
        isFirstLaunch: isFirstLaunchFor(turnSessionId),
        prompt,
        jsonSchema,
        timeoutMs,
        extraArgs,
        signal: abortController.signal,
      });
    } finally {
      // Cleared as soon as the child itself is done — an abort() call after
      // this point would be a safe no-op (nothing left to kill), and
      // shutdown() only needs a few more synchronous/fast persistence
      // steps to complete, not another bounded wait.
      currentAbortController = null;
    }
  }

  async function processExecuteEventInner(event) {
    const prompt = buildExecutionPrompt({
      ...event.normalizedEvent,
      allowedTeamId: config.allowedTeamId,
      allowedProjectId: config.allowedProjectId,
      allowedTargetStateName: config.allowedTargetStateName,
    });
    const raw = await runTurnRaw({
      prompt,
      jsonSchema: completionJsonSchema,
      timeoutMs: config.workerTurnTimeoutMs,
    });
    const evaluation = evaluateCompletionResult({
      ...raw,
      expectedSessionId: sessionId,
      expectedIssueIdentifier: event.issueIdentifier,
      expectedTeamId: config.allowedTeamId,
      expectedProjectId: config.allowedProjectId,
      expectedTargetState: config.allowedTargetStateName,
    });

    if (evaluation.ok) {
      store.markDelivered(event.id, now());
      log(`delivered ${event.issueIdentifier} (${evaluation.reason})`);
      return { delivered: true, evaluation };
    }

    const backoffMs = Math.min(
      config.workerBaseBackoffMs * 2 ** event.attemptCount,
      config.workerMaxBackoffMs,
    );
    const record = store.recordAttemptFailure({
      eventId: event.id,
      now: now(),
      outcome: evaluation.reason,
      errorClass: evaluation.reason,
      backoffMs,
      maxAttempts: config.workerMaxAttempts,
    });
    log(
      `attempt failed for ${event.issueIdentifier}: ${evaluation.reason}` +
        (record ? ` (attempt ${record.attemptCount}, status ${record.status})` : ''),
    );
    return { delivered: false, evaluation, record };
  }

  // DEMO-65 v1C: the Opus review leg. Runs under the SEPARATE reviewer
  // session (`--model opus`), never the executor session — "review jobs
  // must run as a separate Opus reviewer, not as the Sonnet execution
  // context". trustedRevisionCount is read from the durable store's
  // issue_cycles table BEFORE spawning the turn — never from anything the
  // turn itself reports — and is what both the prompt (so a well-behaved
  // turn naturally stays within bounds) and evaluateReviewResult() (so the
  // bound holds even if it doesn't) key off.
  async function processReviewEventInner(event) {
    const cycle = store.getCycle(event.issueIdentifier);
    const trustedRevisionCount = cycle ? cycle.revisionCount : 0;
    // DEMO-65 proof-derived correction: computed from the event's own
    // durable cycle_id (not a fresh lookup) + the trusted revision count
    // read just above — identical across every retry of this same pending
    // row until it is actually finalized, so a turn that crashed after
    // mutating Linear but before local commit can be safely recovered on
    // retry via this same token (see buildReviewPrompt()/evaluateReviewResult()).
    const reviewActionToken = computeReviewActionToken(event.cycleId, trustedRevisionCount);
    const prompt = buildReviewPrompt({
      issueIdentifier: event.issueIdentifier,
      url: event.normalizedEvent.url,
      allowedTeamId: config.allowedTeamId,
      allowedProjectId: config.allowedProjectId,
      revisionCount: trustedRevisionCount,
      maxRevisionCycles: config.maxRevisionCycles,
      reviewActionToken,
    });
    const raw = await runTurnRaw({
      prompt,
      jsonSchema: reviewJsonSchema,
      timeoutMs: config.reviewTurnTimeoutMs,
      turnSessionId: reviewerSessionId,
      extraArgs: ['--model', 'opus'],
    });
    const evaluation = evaluateReviewResult({
      ...raw,
      expectedSessionId: reviewerSessionId,
      expectedIssueIdentifier: event.issueIdentifier,
      expectedTeamId: config.allowedTeamId,
      expectedProjectId: config.allowedProjectId,
      expectedTargetState: REVIEW_TARGET_STATE_NAME,
      trustedRevisionCount,
      maxRevisionCycles: config.maxRevisionCycles,
      expectedReviewActionToken: reviewActionToken,
    });

    if (evaluation.ok) {
      // Atomically marks this row delivered AND applies the cycle
      // bookkeeping the outcome implies (revision_count++ / status=done /
      // status=needs_human) — see durableStore.js's markReviewDelivered().
      store.markReviewDelivered({
        eventId: event.id,
        issueIdentifier: event.issueIdentifier,
        now: now(),
        cycleOutcome: evaluation.structured.outcome,
      });
      log(`review delivered ${event.issueIdentifier} (${evaluation.reason})`);
      return { delivered: true, evaluation };
    }

    const backoffMs = Math.min(
      config.workerBaseBackoffMs * 2 ** event.attemptCount,
      config.workerMaxBackoffMs,
    );
    const record = store.recordAttemptFailure({
      eventId: event.id,
      now: now(),
      outcome: evaluation.reason,
      errorClass: evaluation.reason,
      backoffMs,
      maxAttempts: config.workerMaxAttempts,
    });
    log(
      `review attempt failed for ${event.issueIdentifier}: ${evaluation.reason}` +
        (record ? ` (attempt ${record.attemptCount}, status ${record.status})` : ''),
    );
    return { delivered: false, evaluation, record };
  }

  // DEMO-65 v1C: dispatches by job_type. Both branches funnel through the
  // exact same runExclusiveTurn() boundary below (processEvent()), which is
  // what guarantees the execute and review legs share one global exclusive
  // Claude-operation lane — no separate plumbing needed for that guarantee.
  function processEventInner(event) {
    // External-review mode is a fail-safe boundary for projects where the
    // implementation worker must stop at In Review. Any stale review job
    // already present from an earlier configuration is acknowledged without
    // spawning Opus or mutating Linear review state.
    if (event.jobType === 'review' && config.reviewMode === 'external') {
      store.markDelivered(event.id, now());
      log(`review skipped for ${event.issueIdentifier} (external review mode)`);
      return { delivered: true, evaluation: { ok: true, reason: 'external_review' } };
    }
    return event.jobType === 'review' ? processReviewEventInner(event) : processExecuteEventInner(event);
  }

  // The exclusive queue boundary: wraps the FULL operation (turn +
  // evaluate + persist), not just the raw Claude spawn — see the
  // finding-5-residual comment at the top of this file for why that
  // distinction matters for shutdown().
  function processEvent(event) {
    return runExclusiveTurn(() => processEventInner(event));
  }

  // Single-flight: a poll tick that fires while a prior pass is still
  // running must not start a second overlapping pass. Note this alone does
  // NOT guarantee at most one Claude child overall — reconcileOnce() is a
  // separate entry point — that guarantee comes from runExclusiveTurn()
  // inside processEvent()/reconcileOnce(), which every call here also
  // goes through.
  function pollOnce() {
    if (pollInFlight) return pollInFlight;
    pollInFlight = (async () => {
      const eligible = store.listEligibleEvents(now());
      for (const event of eligible) {
        // eslint-disable-next-line no-await-in-loop -- intentionally serial
        await processEvent(event);
      }
    })().finally(() => {
      pollInFlight = null;
    });
    return pollInFlight;
  }

  // DEMO-65 v1C: reconciliation must recover BOTH missed Todo (execute) work
  // AND missed In Review (review) work. reconcileForState() is the single
  // generic mechanism, parametrized by which state/job_type it's
  // discovering for — buildReconciliationPrompt(), reconciliationJsonSchema,
  // and evaluateReconciliationResult() are all completely unchanged from
  // v1B, just invoked twice with different scope. Reconciliation discovery
  // always uses the EXECUTOR session (Sonnet) for both sub-calls — it is a
  // read-only "what's currently eligible" query, not the review DECISION
  // itself, so it does not need the separate Opus reviewer identity.
  async function reconcileForState({ targetStateName, jobType }) {
    const prompt = buildReconciliationPrompt({
      allowedTeamId: config.allowedTeamId,
      allowedProjectId: config.allowedProjectId,
      allowedTargetStateName: targetStateName,
    });
    const raw = await runTurnRaw({
      prompt,
      jsonSchema: reconciliationJsonSchema,
      timeoutMs: config.reconcileTurnTimeoutMs,
    });
    const evaluation = evaluateReconciliationResult({
      ...raw,
      expectedSessionId: sessionId,
      expectedTeamId: config.allowedTeamId,
      expectedProjectId: config.allowedProjectId,
      expectedTargetState: targetStateName,
    });

    if (!evaluation.ok) {
      log(`reconciliation (${jobType}) turn did not yield usable output: ${evaluation.reason}`);
      return { ok: false, evaluation, upserted: 0 };
    }

    let upserted = 0;
    for (const issue of evaluation.structured.eligibleIssues) {
      const result = store.upsertReconciledIssue({
        issueIdentifier: issue.issueIdentifier,
        issueId: issue.issueId,
        projectId: config.allowedProjectId,
        teamId: config.allowedTeamId,
        targetState: targetStateName,
        jobType,
        url: issue.url,
        now: now(),
      });
      if (!result.duplicate) upserted += 1;
    }
    log(
      `reconciliation (${jobType}) found ${evaluation.structured.eligibleIssues.length} eligible issue(s), ` +
        `upserted ${upserted} new`,
    );
    return { ok: true, evaluation, upserted };
  }

  // Sequential (not concurrent) sub-calls, both inside the SAME
  // runExclusiveTurn invocation via reconcileOnce() below — plain `await`
  // ordering already guarantees at most one Claude child at a time across
  // both, so no extra locking is needed for that guarantee.
  async function reconcileOnceInner() {
    const execute = await reconcileForState({ targetStateName: config.allowedTargetStateName, jobType: 'execute' });
    const review = config.reviewMode === 'external'
      ? { ok: true, skipped: true, reason: 'external_review' }
      : await reconcileForState({ targetStateName: REVIEW_TARGET_STATE_NAME, jobType: 'review' });
    return { execute, review };
  }

  function reconcileOnce() {
    return runExclusiveTurn(reconcileOnceInner);
  }

  function start() {
    // Startup sequencing (finding 1): the initial reconciliation always
    // completes (success or failure) before the initial poll pass starts,
    // rather than firing both immediately and relying only on
    // runExclusiveTurn's queuing order to keep them from racing at the
    // Claude-invocation level. Both are still fully serialized via
    // runExclusiveTurn regardless; this makes the intended order explicit
    // rather than incidental.
    reconcileOnce()
      .catch((err) => log(`initial reconciliation failed: ${err?.message ?? err}`))
      .finally(() => {
        pollOnce().catch((err) => log(`initial poll failed: ${err?.message ?? err}`));
      });
    pollTimer = setIntervalFn(() => {
      pollOnce().catch((err) => log(`poll failed: ${err?.message ?? err}`));
    }, config.pollIntervalMs);
    reconcileTimer = setIntervalFn(() => {
      reconcileOnce().catch((err) => log(`reconciliation failed: ${err?.message ?? err}`));
    }, config.reconcileIntervalMs);
  }

  function stop() {
    if (pollTimer) clearIntervalFn(pollTimer);
    if (reconcileTimer) clearIntervalFn(reconcileTimer);
  }

  // DEMO-62 revision, finding 5: a bounded, explicit shutdown — not "stop
  // timers and hope". Any turn currently in the exclusive queue is given
  // `gracefulTimeoutMs` to finish on its own; if it hasn't by then, its
  // Claude child is aborted (SIGTERM, then SIGKILL after
  // claudeInvoker.js's own escalation grace period). Either way this
  // function does not resolve until that turn's full processEvent()/
  // recordAttemptFailure() cycle has actually run — so the queue item is
  // provably left pending (never silently delivered) if completion was not
  // durably accepted before shutdown was requested. Safe to call even when
  // nothing is in flight (resolves immediately).
  async function shutdown({ gracefulTimeoutMs = config.workerShutdownGraceMs } = {}) {
    stop();
    const timer = setTimeout(() => currentAbortController?.abort(), gracefulTimeoutMs);
    timer.unref?.();
    try {
      await chain;
    } finally {
      clearTimeout(timer);
    }
  }

  return { sessionId, reviewerSessionId, pollOnce, reconcileOnce, processEvent, start, stop, shutdown };
}
