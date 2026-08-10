// DEMO-62 one-shot-worker revision. Spawns exactly one non-interactive
// `claude -p` turn and evaluates the result against the completion
// contract's fail-closed gates. No Channel flag, no PTY, no tmux —
// `--permission-mode auto`, never `bypassPermissions` /
// `--dangerously-skip-permissions`. (Re-confirmed correct per the latest
// Opus review: `auto` mode is not gated off this account/plan — the prior
// concern about Pro-plan availability was based on stale contract text and
// is superseded. No change needed here for that point.)
//
// evaluateCompletionResult()/evaluateReconciliationResult() are pure (no
// IO) and deliberately separate from spawnClaudeTurn() so the fail-closed
// gate logic is unit-testable without spawning any process at all.

import { spawn } from 'node:child_process';
import { validateCompletionOutput, validateReconciliationOutput, validateReviewOutput } from './completionSchema.js';

// DEMO-62 proof-derived correction (1 of 2): `completed_no_commit` is a second
// terminal, deliverable outcome alongside `completed` — see the split gate
// in evaluateCompletionResult() below.
const TERMINAL_OUTCOMES = new Set(['completed', 'completed_no_commit', 'not_eligible']);
const RETRYABLE_OUTCOMES = new Set(['blocked', 'failed']);

// Escalation delay before SIGKILL if a SIGTERM'd process doesn't exit —
// bounds worst-case shutdown time for a genuinely hung turn, and for an
// externally-aborted one (see `signal` param / worker.js's shutdown()).
const KILL_ESCALATION_MS = 5000;

// DEMO-62 revision, finding 4: the worker process must never let the
// Linear webhook secret reach a spawned Claude child, even if it were
// ever (mis)present in the worker's own process env (e.g. a future
// deployment mistake pointing the worker at the ingress-only .env). This
// is deliberately a spawn-time filter, not just "don't configure it there"
// — Node's child_process inherits the full parent env by default when no
// `env` override is given, so the filter has to be explicit.
function sanitizedChildEnv(sourceEnv = process.env) {
  const { LINEAR_WEBHOOK_SECRET, ...rest } = sourceEnv;
  return rest;
}

export function spawnClaudeTurn({
  claudeBin,
  cwd,
  sessionId,
  isFirstLaunch,
  prompt,
  jsonSchema,
  timeoutMs,
  extraArgs = [],
  spawnFn = spawn,
  signal,
}) {
  return new Promise((resolve) => {
    const args = [
      isFirstLaunch ? '--session-id' : '--resume',
      sessionId,
      '--permission-mode',
      'auto',
      '-p',
      prompt,
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(jsonSchema),
      ...extraArgs,
    ];

    let settled = false;
    let child;
    try {
      child = spawnFn(claudeBin, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: sanitizedChildEnv(),
      });
    } catch (spawnError) {
      resolve({ code: null, signal: null, timedOut: false, aborted: false, stdout: '', stderr: '', spawnError });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;

    function killChild() {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      const escalate = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, KILL_ESCALATION_MS);
      escalate.unref?.();
    }

    const killTimer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, timeoutMs);
    killTimer.unref?.();

    // DEMO-62 revision, finding 5: an external caller (worker.js's
    // shutdown()) can abort an in-flight turn — same kill path as a
    // timeout, so the caller gets the same fail-closed `signal` result and
    // the queue item is left pending for retry, never silently dropped.
    let onAbort;
    if (signal) {
      onAbort = () => {
        aborted = true;
        killChild();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    function cleanupAbortListener() {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }

    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      cleanupAbortListener();
      resolve({ code: null, signal: null, timedOut, aborted, stdout, stderr, spawnError });
    });
    child.on('close', (code, closeSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      cleanupAbortListener();
      resolve({ code, signal: closeSignal, timedOut, aborted, stdout, stderr });
    });
  });
}

// The fail-closed completion gate (DEMO-62 revision): a queue row may be
// marked delivered only when ok:true. Every other path — including a
// successfully-parsed, schema-valid, but non-terminal outcome
// (blocked/failed) — returns ok:false and must leave the row pending for
// retry per the caller's backoff policy. `code !== 0`, a timeout, a
// signal, unparseable/missing structured output, a session or issue
// mismatch, or an unexpected outcome value all fail closed the same way.
//
// DEMO-62 revision, finding 2: queue admission (team/project/state already
// gated at webhook/reconciliation ingestion) is not a substitute for the
// standing canonical-re-fetch rule. For a `completed` outcome specifically,
// the agent's *own reported verification* (verifiedTeamId/verifiedProjectId/
// verifiedPickupState — populated from what it actually found on Linear,
// per buildExecutionPrompt()) must match the worker's configured allowed
// scope, or the result fails closed. This catches a turn that fabricates
// success without genuinely re-verifying, or drifts onto the wrong issue.
export function evaluateCompletionResult({
  code,
  signal,
  timedOut,
  stdout,
  spawnError,
  expectedSessionId,
  expectedIssueIdentifier,
  expectedTeamId,
  expectedProjectId,
  expectedTargetState,
}) {
  if (spawnError) return { ok: false, reason: 'spawn_error' };
  if (timedOut) return { ok: false, reason: 'timeout' };
  if (signal) return { ok: false, reason: 'signal' };
  if (code !== 0) return { ok: false, reason: 'nonzero_exit' };

  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: 'unparseable_envelope' };
  }

  if (envelope.session_id !== expectedSessionId) {
    return { ok: false, reason: 'session_mismatch' };
  }

  const structured = envelope.structured_output;
  if (structured === undefined || structured === null) {
    return { ok: false, reason: 'missing_structured_output' };
  }

  const validation = validateCompletionOutput(structured);
  if (!validation.valid) {
    return { ok: false, reason: 'schema_invalid', details: validation.errors, structured };
  }

  if (structured.issueIdentifier !== expectedIssueIdentifier) {
    return { ok: false, reason: 'issue_mismatch', structured };
  }

  if (RETRYABLE_OUTCOMES.has(structured.outcome)) {
    return { ok: false, reason: structured.outcome, structured };
  }

  if (!TERMINAL_OUTCOMES.has(structured.outcome)) {
    // Unreachable given the enum check inside validateCompletionOutput,
    // but the gate stays explicit and fails closed regardless.
    return { ok: false, reason: 'unexpected_outcome', structured };
  }

  // DEMO-62 proof-derived correction (1 of 2): the DEMO-63 live proof produced
  // a genuine no-tracked-repo-change completion (a PR-description-only fix)
  // that the original single `completed` gate rejected as `missing_commit_sha`
  // even though the task was legitimately done. `completed` and
  // `completed_no_commit` share every gate below except the commitSha
  // check, which is inverted rather than relaxed: `completed` still
  // requires a real task-specific SHA (the code-change gate is NOT
  // weakened); `completed_no_commit` requires commitSha to be exactly
  // `null`, so a turn cannot use this outcome to silently omit a commit a
  // task genuinely required — it must explicitly claim there was nothing to
  // commit, or the schema/gate rejects the mismatch.
  if (structured.outcome === 'completed' || structured.outcome === 'completed_no_commit') {
    if (structured.canonicalStatus !== 'In Review') {
      return { ok: false, reason: 'unexpected_canonical_status', structured };
    }
    if (structured.resultPosted !== true) {
      return { ok: false, reason: 'result_not_posted', structured };
    }
    if (structured.outcome === 'completed') {
      if (!structured.commitSha) {
        return { ok: false, reason: 'missing_commit_sha', structured };
      }
    } else if (structured.commitSha !== null) {
      return { ok: false, reason: 'unexpected_commit_sha_for_no_commit_completion', structured };
    }
    if (structured.verifiedTeamId !== expectedTeamId) {
      return { ok: false, reason: 'wrong_verified_team', structured };
    }
    if (structured.verifiedProjectId !== expectedProjectId) {
      return { ok: false, reason: 'wrong_verified_project', structured };
    }
    if (structured.verifiedPickupState !== expectedTargetState) {
      return { ok: false, reason: 'wrong_verified_pickup_state', structured };
    }
  }

  return { ok: true, reason: structured.outcome, structured };
}

export function evaluateReconciliationResult({
  code,
  signal,
  timedOut,
  stdout,
  spawnError,
  expectedSessionId,
  expectedTeamId,
  expectedProjectId,
  expectedTargetState,
}) {
  if (spawnError) return { ok: false, reason: 'spawn_error' };
  if (timedOut) return { ok: false, reason: 'timeout' };
  if (signal) return { ok: false, reason: 'signal' };
  if (code !== 0) return { ok: false, reason: 'nonzero_exit' };

  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: 'unparseable_envelope' };
  }

  if (envelope.session_id !== expectedSessionId) {
    return { ok: false, reason: 'session_mismatch' };
  }

  const structured = envelope.structured_output;
  if (structured === undefined || structured === null) {
    return { ok: false, reason: 'missing_structured_output' };
  }

  const validation = validateReconciliationOutput(structured);
  if (!validation.valid) {
    return { ok: false, reason: 'schema_invalid', details: validation.errors };
  }

  if (
    structured.teamId !== expectedTeamId ||
    structured.projectId !== expectedProjectId ||
    structured.targetState !== expectedTargetState
  ) {
    return { ok: false, reason: 'scope_mismatch', structured };
  }

  return { ok: true, structured };
}

// DEMO-65 v1C. Fail-closed gate for the Opus review turn, structurally
// parallel to evaluateCompletionResult() above: a review event may be
// marked delivered only when ok:true. Every envelope/session/schema/issue
// check is identical in spirit to the execute leg's; what's new is the
// bounded-revision-loop enforcement at the bottom.
const REVIEW_TERMINAL_OUTCOMES = new Set(['pass', 'revision_required', 'needs_human']);
const REVIEW_RETRYABLE_OUTCOMES = new Set(['blocked', 'failed']);

export function evaluateReviewResult({
  code,
  signal,
  timedOut,
  stdout,
  spawnError,
  expectedSessionId,
  expectedIssueIdentifier,
  expectedTeamId,
  expectedProjectId,
  expectedTargetState,
  // The worker's OWN durably-persisted revision_count (from
  // durableStore.js's issue_cycles table) for this issue, read BEFORE this
  // turn was spawned — never a value the turn itself reported. This is what
  // makes the revision-limit enforcement below trustworthy even if a
  // misbehaving/confused turn reports revision_required past the limit.
  trustedRevisionCount,
  maxRevisionCycles,
  // DEMO-65 proof-derived correction: the exact token the worker computed
  // and handed to the prompt (see worker.js's computeReviewActionToken()),
  // deterministic from (cycle_id, trustedRevisionCount) — NOT from
  // anything the turn discovered on its own. A mismatch means the turn
  // reported an action belonging to a different (stale, earlier, or
  // unrelated) decision and must never be accepted as finalizing THIS one.
  expectedReviewActionToken,
}) {
  if (spawnError) return { ok: false, reason: 'spawn_error' };
  if (timedOut) return { ok: false, reason: 'timeout' };
  if (signal) return { ok: false, reason: 'signal' };
  if (code !== 0) return { ok: false, reason: 'nonzero_exit' };

  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: 'unparseable_envelope' };
  }

  if (envelope.session_id !== expectedSessionId) {
    return { ok: false, reason: 'session_mismatch' };
  }

  const structured = envelope.structured_output;
  if (structured === undefined || structured === null) {
    return { ok: false, reason: 'missing_structured_output' };
  }

  const validation = validateReviewOutput(structured);
  if (!validation.valid) {
    return { ok: false, reason: 'schema_invalid', details: validation.errors, structured };
  }

  if (structured.issueIdentifier !== expectedIssueIdentifier) {
    return { ok: false, reason: 'issue_mismatch', structured };
  }

  if (REVIEW_RETRYABLE_OUTCOMES.has(structured.outcome)) {
    return { ok: false, reason: structured.outcome, structured };
  }

  if (!REVIEW_TERMINAL_OUTCOMES.has(structured.outcome)) {
    // Unreachable given the enum check inside validateReviewOutput, but the
    // gate stays explicit and fails closed regardless.
    return { ok: false, reason: 'unexpected_outcome', structured };
  }

  // Shared gates across all three terminal review outcomes: the turn must
  // have posted its required Linear comment and genuinely re-verified the
  // configured team/project/pickup-state via canonical Linear data — not
  // this notification's claims (mirrors evaluateCompletionResult()'s
  // finding-2 gate).
  if (structured.resultPosted !== true) {
    return { ok: false, reason: 'result_not_posted', structured };
  }
  if (structured.verifiedTeamId !== expectedTeamId) {
    return { ok: false, reason: 'wrong_verified_team', structured };
  }
  if (structured.verifiedProjectId !== expectedProjectId) {
    return { ok: false, reason: 'wrong_verified_project', structured };
  }
  if (structured.verifiedPickupState !== expectedTargetState) {
    return { ok: false, reason: 'wrong_verified_pickup_state', structured };
  }
  // DEMO-65 proof-derived correction: a terminal outcome may only finalize
  // THIS exact decision — a stale/mismatched token means the turn found (or
  // fabricated) evidence belonging to a different cycle/revision round and
  // must fail closed rather than silently finalize the wrong action.
  if (structured.reviewActionToken !== expectedReviewActionToken) {
    return { ok: false, reason: 'review_action_token_mismatch', structured };
  }

  if (structured.outcome === 'revision_required') {
    if (structured.canonicalStatus !== 'Todo') {
      return { ok: false, reason: 'unexpected_canonical_status', structured };
    }
    // DEMO-65's bounded revision loop: a revision_required outcome is only
    // ever valid while the worker's own trusted count is still under the
    // max — enforced here independently of whatever the prompt asked for,
    // so the loop cannot exceed its bound even if the agent misbehaves or
    // miscounts. This fails closed (retried with backoff, NOT silently
    // accepted and NOT silently reinterpreted as needs_human) — the
    // corrected prompt should make this practically unreachable, but the
    // guarantee must not depend solely on the prompt being obeyed.
    if (trustedRevisionCount >= maxRevisionCycles) {
      return { ok: false, reason: 'revision_limit_exceeded_must_be_needs_human', structured };
    }
  } else {
    // pass | needs_human — both are terminal-for-automation and must have
    // moved the issue to Done themselves.
    if (structured.canonicalStatus !== 'Done') {
      return { ok: false, reason: 'unexpected_canonical_status', structured };
    }
  }

  return { ok: true, reason: structured.outcome, structured };
}
