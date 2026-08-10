import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import {
  spawnClaudeTurn,
  evaluateCompletionResult,
  evaluateReconciliationResult,
  evaluateReviewResult,
} from '../src/claudeInvoker.js';

const FAKE_CLAUDE = resolve(dirname(fileURLToPath(import.meta.url)), '../dev-workers/fakeClaude.mjs');

// Configured allowed scope, shared by every test in this file — matches
// what a worker configured with these values would pass as
// expectedTeamId/expectedProjectId/expectedTargetState (DEMO-62 revision,
// finding 2).
const SCOPE = { expectedTeamId: 'team-1', expectedProjectId: 'project-1', expectedTargetState: 'Todo' };

function validCompletedStructured(overrides = {}) {
  return {
    protocolVersion: 1,
    issueIdentifier: 'DEMO-1',
    outcome: 'completed',
    canonicalStatus: 'In Review',
    resultPosted: true,
    commitSha: 'abc123',
    verifiedTeamId: 'team-1',
    verifiedProjectId: 'project-1',
    verifiedPickupState: 'Todo',
    summary: 'done',
    ...overrides,
  };
}

function completedEnvelope(overrides = {}) {
  return {
    code: 0,
    signal: null,
    timedOut: false,
    spawnError: undefined,
    stdout: JSON.stringify({
      session_id: 'sid-1',
      structured_output: validCompletedStructured(),
      ...overrides.envelopeOverrides,
    }),
    expectedSessionId: 'sid-1',
    expectedIssueIdentifier: 'DEMO-1',
    ...SCOPE,
    ...overrides,
  };
}

function envelopeWithStructured(structured, extra = {}) {
  return completedEnvelope({
    stdout: JSON.stringify({ session_id: 'sid-1', structured_output: structured }),
    ...extra,
  });
}

// --- 3. valid completed -> ok (deliverable) ---
test('3. valid completed structured output -> ok, deliverable', () => {
  const result = evaluateCompletionResult(completedEnvelope());
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'completed');
});

// --- 4. valid not_eligible -> ok, no execution required ---
test('4. valid not_eligible structured output -> ok, deliverable, no extra checks', () => {
  const result = evaluateCompletionResult(
    envelopeWithStructured({
      protocolVersion: 1,
      issueIdentifier: 'DEMO-1',
      outcome: 'not_eligible',
      canonicalStatus: 'Todo',
      resultPosted: false,
      commitSha: null,
      verifiedTeamId: null,
      verifiedProjectId: null,
      verifiedPickupState: null,
      summary: 'not eligible',
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'not_eligible');
});

// --- 5. blocked/failed -> fail closed ---
test('5. blocked outcome fails closed', () => {
  const result = evaluateCompletionResult(
    envelopeWithStructured({
      protocolVersion: 1,
      issueIdentifier: 'DEMO-1',
      outcome: 'blocked',
      canonicalStatus: 'Todo',
      resultPosted: false,
      commitSha: null,
      verifiedTeamId: null,
      verifiedProjectId: null,
      verifiedPickupState: null,
      summary: 'blocked on X',
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'blocked');
});

test('5. failed outcome fails closed', () => {
  const result = evaluateCompletionResult(
    envelopeWithStructured({
      protocolVersion: 1,
      issueIdentifier: 'DEMO-1',
      outcome: 'failed',
      canonicalStatus: 'Todo',
      resultPosted: false,
      commitSha: null,
      verifiedTeamId: null,
      verifiedProjectId: null,
      verifiedPickupState: null,
      summary: 'error',
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'failed');
});

// --- 6. exit 0 but malformed/missing schema -> fail closed ---
test('6. malformed (unparseable) JSON envelope fails closed', () => {
  const result = evaluateCompletionResult(completedEnvelope({ stdout: '{not valid json' }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unparseable_envelope');
});

test('6. missing structured_output fails closed', () => {
  const result = evaluateCompletionResult(
    completedEnvelope({ stdout: JSON.stringify({ session_id: 'sid-1' }) }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_structured_output');
});

test('6. structured_output failing schema validation fails closed', () => {
  const result = evaluateCompletionResult(
    envelopeWithStructured({ protocolVersion: 1, outcome: 'completed' }), // missing required fields
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'schema_invalid');
  assert.ok(result.details.length > 0);
});

// --- 7. nonzero/timeout/signal -> fail closed ---
test('7. nonzero exit code fails closed', () => {
  const result = evaluateCompletionResult(completedEnvelope({ code: 1 }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'nonzero_exit');
});

test('7. timeout fails closed', () => {
  const result = evaluateCompletionResult(completedEnvelope({ timedOut: true, code: null }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
});

test('7. signal fails closed', () => {
  const result = evaluateCompletionResult(completedEnvelope({ signal: 'SIGKILL', code: null }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'signal');
});

test('7. spawn error fails closed', () => {
  const result = evaluateCompletionResult(completedEnvelope({ spawnError: new Error('ENOENT'), code: null }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'spawn_error');
});

// --- 8. issue/session mismatch -> fail closed ---
test('8. session_id mismatch fails closed', () => {
  const result = evaluateCompletionResult(completedEnvelope({ expectedSessionId: 'sid-DIFFERENT' }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'session_mismatch');
});

test('8. issueIdentifier mismatch fails closed', () => {
  const result = evaluateCompletionResult(completedEnvelope({ expectedIssueIdentifier: 'DEMO-DIFFERENT' }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'issue_mismatch');
});

// --- extra gate-7 checks for a "completed" outcome ---
test('completed with wrong canonicalStatus fails closed', () => {
  const result = evaluateCompletionResult(
    envelopeWithStructured(validCompletedStructured({ canonicalStatus: 'Todo' })), // wrong — should be In Review
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unexpected_canonical_status');
});

test('completed with resultPosted:false fails closed', () => {
  const result = evaluateCompletionResult(evaluateFixture({ resultPosted: false }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'result_not_posted');
});

function evaluateFixture(overrides) {
  return envelopeWithStructured(validCompletedStructured(overrides));
}

test('completed with missing commitSha fails closed', () => {
  const result = evaluateCompletionResult(evaluateFixture({ commitSha: null }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_commit_sha');
});

// --- 2. completed must carry the canonical scope actually verified,
// matching the worker's configured allowed scope, or fail closed ---
test('2. completed with wrong verifiedTeamId fails closed', () => {
  const result = evaluateCompletionResult(evaluateFixture({ verifiedTeamId: 'some-other-team' }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'wrong_verified_team');
});

test('2. completed with wrong verifiedProjectId fails closed', () => {
  const result = evaluateCompletionResult(evaluateFixture({ verifiedProjectId: 'some-other-project' }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'wrong_verified_project');
});

test('2. completed with wrong verifiedPickupState fails closed', () => {
  const result = evaluateCompletionResult(evaluateFixture({ verifiedPickupState: 'In Progress' }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'wrong_verified_pickup_state');
});

test('2. completed with null verifiedTeamId/verifiedProjectId/verifiedPickupState (never verified) fails closed', () => {
  const result = evaluateCompletionResult(
    evaluateFixture({ verifiedTeamId: null, verifiedProjectId: null, verifiedPickupState: null }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'wrong_verified_team');
});

// --- DEMO-62 proof-derived correction (1 of 2): completed_no_commit ---
// A genuine no-tracked-repo-change completion (e.g. a PR-description-only
// fix, the exact shape the DEMO-63 live proof produced) must be deliverable
// without a commit SHA, while the code-change `completed` gate stays strict.
function noCommitEvaluateFixture(overrides) {
  return envelopeWithStructured(
    validCompletedStructured({ outcome: 'completed_no_commit', commitSha: null, ...overrides }),
  );
}

test('completed_no_commit with null commitSha and matching verified scope -> ok, deliverable', () => {
  const result = evaluateCompletionResult(noCommitEvaluateFixture());
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'completed_no_commit');
});

test('completed_no_commit with a non-null commitSha fails closed (cannot dodge the code-change gate)', () => {
  const result = evaluateCompletionResult(noCommitEvaluateFixture({ commitSha: 'abc123' }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unexpected_commit_sha_for_no_commit_completion');
});

test('completed (code-change) with null commitSha still fails closed after the split-gate change (no weakening)', () => {
  const result = evaluateCompletionResult(evaluateFixture({ commitSha: null }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_commit_sha');
});

test('completed_no_commit with wrong canonicalStatus fails closed', () => {
  const result = evaluateCompletionResult(noCommitEvaluateFixture({ canonicalStatus: 'Todo' }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unexpected_canonical_status');
});

test('completed_no_commit with resultPosted:false fails closed', () => {
  const result = evaluateCompletionResult(noCommitEvaluateFixture({ resultPosted: false }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'result_not_posted');
});

test('completed_no_commit with wrong verifiedProjectId fails closed (shared verified-scope gate not bypassed)', () => {
  const result = evaluateCompletionResult(noCommitEvaluateFixture({ verifiedProjectId: 'some-other-project' }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'wrong_verified_project');
});

test('not_eligible is unaffected by verified-scope fields being null (no completed-only gates apply)', () => {
  const result = evaluateCompletionResult(
    envelopeWithStructured({
      protocolVersion: 1,
      issueIdentifier: 'DEMO-1',
      outcome: 'not_eligible',
      canonicalStatus: 'Todo',
      resultPosted: false,
      commitSha: null,
      verifiedTeamId: 'team-1',
      verifiedProjectId: 'wrong-project', // deliberately wrong — must not matter for a non-completed outcome
      verifiedPickupState: 'Todo',
      summary: 'not eligible: wrong project',
    }),
  );
  assert.equal(result.ok, true);
});

// --- reconciliation gates ---
test('10. valid reconciliation output -> ok, scope matches', () => {
  const result = evaluateReconciliationResult({
    code: 0,
    signal: null,
    timedOut: false,
    stdout: JSON.stringify({
      session_id: 'sid-1',
      structured_output: {
        protocolVersion: 1,
        teamId: 'team-1',
        projectId: 'project-1',
        targetState: 'Todo',
        eligibleIssues: [{ issueIdentifier: 'DEMO-1', issueId: 'i1', url: 'https://x' }],
      },
    }),
    expectedSessionId: 'sid-1',
    expectedTeamId: 'team-1',
    expectedProjectId: 'project-1',
    expectedTargetState: 'Todo',
  });
  assert.equal(result.ok, true);
  assert.equal(result.structured.eligibleIssues.length, 1);
});

test('reconciliation scope mismatch fails closed', () => {
  const result = evaluateReconciliationResult({
    code: 0,
    signal: null,
    timedOut: false,
    stdout: JSON.stringify({
      session_id: 'sid-1',
      structured_output: {
        protocolVersion: 1,
        teamId: 'wrong-team',
        projectId: 'project-1',
        targetState: 'Todo',
        eligibleIssues: [],
      },
    }),
    expectedSessionId: 'sid-1',
    expectedTeamId: 'team-1',
    expectedProjectId: 'project-1',
    expectedTargetState: 'Todo',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'scope_mismatch');
});

// --- 1. exact CLI args (no Channel/bypass flags), via a stub spawnFn ---
function makeStubChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  return child;
}

test('1. spawnClaudeTurn builds exact CLI args for a first launch (--session-id)', async () => {
  let seen;
  const stubSpawn = (cmd, args) => {
    seen = { cmd, args };
    const child = makeStubChild();
    setImmediate(() => {
      child.stdout.end(JSON.stringify({ session_id: 'sid-1', structured_output: {} }));
      child.emit('close', 0, null);
    });
    return child;
  };

  await spawnClaudeTurn({
    claudeBin: '/fake/claude',
    cwd: '/srv/example-workspace',
    sessionId: 'sid-1',
    isFirstLaunch: true,
    prompt: 'do the thing',
    jsonSchema: { type: 'object' },
    timeoutMs: 5000,
    spawnFn: stubSpawn,
  });

  assert.equal(seen.cmd, '/fake/claude');
  assert.deepEqual(seen.args, [
    '--session-id',
    'sid-1',
    '--permission-mode',
    'auto',
    '-p',
    'do the thing',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify({ type: 'object' }),
  ]);
  assert.ok(!seen.args.includes('--dangerously-load-development-channels'));
  assert.ok(!seen.args.includes('--dangerously-skip-permissions'));
  assert.ok(!seen.args.includes('--continue'));
  assert.ok(!seen.args.join(' ').includes('bypassPermissions'));
});

test('2. spawnClaudeTurn uses --resume (never --continue) when not the first launch', async () => {
  let seen;
  const stubSpawn = (cmd, args) => {
    seen = args;
    const child = makeStubChild();
    setImmediate(() => {
      child.stdout.end(JSON.stringify({ session_id: 'sid-1', structured_output: {} }));
      child.emit('close', 0, null);
    });
    return child;
  };

  await spawnClaudeTurn({
    claudeBin: '/fake/claude',
    cwd: '/srv/example-workspace',
    sessionId: 'sid-1',
    isFirstLaunch: false,
    prompt: 'continue the thing',
    jsonSchema: { type: 'object' },
    timeoutMs: 5000,
    spawnFn: stubSpawn,
  });

  assert.deepEqual(seen.slice(0, 2), ['--resume', 'sid-1']);
  assert.ok(!seen.includes('--session-id'));
  assert.ok(!seen.includes('--continue'));
});

// --- 4. the spawned Claude child must never inherit LINEAR_WEBHOOK_SECRET ---
test('4. spawnClaudeTurn strips LINEAR_WEBHOOK_SECRET from the spawned child env, even if present in the worker process env', async () => {
  const originalSecret = process.env.LINEAR_WEBHOOK_SECRET;
  process.env.LINEAR_WEBHOOK_SECRET = 'super-secret-value-must-not-leak';
  try {
    let seenEnv;
    const stubSpawn = (cmd, args, opts) => {
      seenEnv = opts.env;
      const child = makeStubChild();
      setImmediate(() => {
        child.stdout.end(JSON.stringify({ session_id: 'sid-1', structured_output: {} }));
        child.emit('close', 0, null);
      });
      return child;
    };

    await spawnClaudeTurn({
      claudeBin: '/fake/claude',
      cwd: '/srv/example-workspace',
      sessionId: 'sid-1',
      isFirstLaunch: true,
      prompt: 'x',
      jsonSchema: { type: 'object' },
      timeoutMs: 5000,
      spawnFn: stubSpawn,
    });

    assert.ok(seenEnv, 'spawnFn must receive an explicit env option');
    assert.ok(
      !Object.prototype.hasOwnProperty.call(seenEnv, 'LINEAR_WEBHOOK_SECRET'),
      'the spawned child env must not contain LINEAR_WEBHOOK_SECRET',
    );
    // Sanity check the sanitization isn't just "pass an empty env" — other
    // inherited vars must still be present.
    assert.ok(Object.keys(seenEnv).length > 0);
  } finally {
    if (originalSecret === undefined) delete process.env.LINEAR_WEBHOOK_SECRET;
    else process.env.LINEAR_WEBHOOK_SECRET = originalSecret;
  }
});

// --- 5. an external AbortSignal cancels an in-flight turn the same way a timeout does ---
test('5. spawnClaudeTurn aborts the child and reports a signal when the passed AbortSignal fires', async () => {
  const controller = new AbortController();
  const resultPromise = spawnClaudeTurn({
    claudeBin: process.execPath,
    cwd: process.cwd(),
    sessionId: 'sid-1',
    isFirstLaunch: true,
    prompt: 'x',
    jsonSchema: { type: 'object' },
    timeoutMs: 60_000, // long enough that only the abort, not the timeout, triggers the kill
    signal: controller.signal,
    spawnFn: (bin, args, opts) =>
      spawn(bin, [FAKE_CLAUDE, ...args], { ...opts, env: { ...process.env, FAKE_CLAUDE_MODE: 'hang' } }),
  });
  await new Promise((r) => setTimeout(r, 100)); // let the child actually start hanging
  controller.abort();
  const result = await resultPromise;
  assert.equal(result.aborted, true);
  assert.ok(result.signal, 'an aborted child must report a kill signal, same fail-closed shape as a timeout');
  const evaluation = evaluateCompletionResult({ ...result, expectedSessionId: 'sid-1', expectedIssueIdentifier: 'DEMO-1', ...SCOPE });
  assert.equal(evaluation.ok, false);
  assert.equal(evaluation.reason, 'signal');
});

// --- 7. real-process nonzero exit / timeout / signal, via dev-workers/fakeClaude.mjs ---
test('7. real subprocess: nonzero exit surfaces code, no structured_output needed to fail closed', async () => {
  const result = await spawnClaudeTurn({
    claudeBin: process.execPath,
    cwd: process.cwd(),
    sessionId: 'sid-1',
    isFirstLaunch: true,
    prompt: 'x',
    jsonSchema: { type: 'object' },
    timeoutMs: 5000,
    extraArgs: [],
    spawnFn: (bin, args, opts) =>
      spawn(bin, [FAKE_CLAUDE, ...args], { ...opts, env: { ...process.env, FAKE_CLAUDE_MODE: 'nonzero' } }),
  });
  assert.equal(result.code, 1);
  const evaluation = evaluateCompletionResult({ ...result, expectedSessionId: 'sid-1', expectedIssueIdentifier: 'DEMO-1', ...SCOPE });
  assert.equal(evaluation.ok, false);
  assert.equal(evaluation.reason, 'nonzero_exit');
});

test('7. real subprocess: hang is killed via SIGTERM within timeout and reported as timedOut', async () => {
  const start = Date.now();
  const result = await spawnClaudeTurn({
    claudeBin: process.execPath,
    cwd: process.cwd(),
    sessionId: 'sid-1',
    isFirstLaunch: true,
    prompt: 'x',
    jsonSchema: { type: 'object' },
    timeoutMs: 300,
    spawnFn: (bin, args, opts) =>
      spawn(bin, [FAKE_CLAUDE, ...args], { ...opts, env: { ...process.env, FAKE_CLAUDE_MODE: 'hang' } }),
  });
  const elapsed = Date.now() - start;
  assert.equal(result.timedOut, true);
  assert.ok(elapsed < 6000, `should not wait for the full 5s SIGKILL escalation when SIGTERM works (took ${elapsed}ms)`);
});

test('7. real subprocess: signal (self-crash) fails closed', async () => {
  const result = await spawnClaudeTurn({
    claudeBin: process.execPath,
    cwd: process.cwd(),
    sessionId: 'sid-1',
    isFirstLaunch: true,
    prompt: 'x',
    jsonSchema: { type: 'object' },
    timeoutMs: 5000,
    spawnFn: (bin, args, opts) =>
      spawn(bin, [FAKE_CLAUDE, ...args], { ...opts, env: { ...process.env, FAKE_CLAUDE_MODE: 'crash' } }),
  });
  assert.equal(result.signal, 'SIGKILL');
  const evaluation = evaluateCompletionResult({ ...result, expectedSessionId: 'sid-1', expectedIssueIdentifier: 'DEMO-1', ...SCOPE });
  assert.equal(evaluation.ok, false);
  assert.equal(evaluation.reason, 'signal');
});

// --- DEMO-65 v1C: evaluateReviewResult ---

const REVIEW_SCOPE = { expectedTeamId: 'team-1', expectedProjectId: 'project-1', expectedTargetState: 'In Review' };

const DEFAULT_REVIEW_ACTION_TOKEN = 'cycle-fixture-r0';

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
    reviewActionToken: DEFAULT_REVIEW_ACTION_TOKEN,
    summary: 'reviewed',
    ...overrides,
  };
}

function reviewEnvelope(overrides = {}) {
  return {
    code: 0,
    signal: null,
    timedOut: false,
    spawnError: undefined,
    stdout: JSON.stringify({
      session_id: 'sid-1',
      structured_output: validReviewStructured(),
      ...overrides.envelopeOverrides,
    }),
    expectedSessionId: 'sid-1',
    expectedIssueIdentifier: 'DEMO-1',
    trustedRevisionCount: 0,
    maxRevisionCycles: 3,
    expectedReviewActionToken: DEFAULT_REVIEW_ACTION_TOKEN,
    ...REVIEW_SCOPE,
    ...overrides,
  };
}

function reviewEnvelopeWithStructured(structured, extra = {}) {
  return reviewEnvelope({
    stdout: JSON.stringify({ session_id: 'sid-1', structured_output: structured }),
    ...extra,
  });
}

// structuredOverrides merge into the structured_output; envelopeOverrides
// merge into the top-level evaluateReviewResult() params (e.g.
// trustedRevisionCount/maxRevisionCycles, which are NOT part of the
// structured output schema at all — keeping them separate avoids leaking
// them into structured_output and tripping the additionalProperties gate.
function reviewFixture(structuredOverrides, envelopeOverrides = {}) {
  return reviewEnvelopeWithStructured(validReviewStructured(structuredOverrides), envelopeOverrides);
}

test('v1C. valid pass structured output -> ok, deliverable', () => {
  const result = evaluateReviewResult(reviewEnvelope());
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'pass');
});

test('v1C. valid revision_required (canonicalStatus Todo, under the limit) -> ok, deliverable', () => {
  const result = evaluateReviewResult(reviewFixture({ outcome: 'revision_required', canonicalStatus: 'Todo' }));
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'revision_required');
});

test('v1C. valid needs_human (canonicalStatus Done) -> ok, deliverable', () => {
  const result = evaluateReviewResult(reviewFixture({ outcome: 'needs_human' }));
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'needs_human');
});

test('v1C. blocked/failed fail closed (retryable, not delivered)', () => {
  for (const outcome of ['blocked', 'failed']) {
    const result = evaluateReviewResult(
      reviewFixture({ outcome, canonicalStatus: 'Todo', resultPosted: false, verifiedTeamId: null, verifiedProjectId: null, verifiedPickupState: null }),
    );
    assert.equal(result.ok, false, `${outcome} must not be delivered`);
    assert.equal(result.reason, outcome);
  }
});

// DEMO-65 requirement 12: max 3 automatic revision cycles — a revision_required
// outcome is only valid while the worker's OWN trusted count is under the
// max; at/above the max it must fail closed regardless of what the turn
// itself claims, so the loop cannot exceed its bound even if Opus misbehaves.
test('12. revision_required at the trusted revision limit fails closed (must be needs_human instead)', () => {
  const result = evaluateReviewResult(
    reviewFixture({ outcome: 'revision_required', canonicalStatus: 'Todo' }, { trustedRevisionCount: 3, maxRevisionCycles: 3 }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'revision_limit_exceeded_must_be_needs_human');
});

test('12. revision_required just under the trusted revision limit still succeeds', () => {
  const result = evaluateReviewResult(
    reviewFixture({ outcome: 'revision_required', canonicalStatus: 'Todo' }, { trustedRevisionCount: 2, maxRevisionCycles: 3 }),
  );
  assert.equal(result.ok, true);
});

test('v1C. revision_required with wrong canonicalStatus (not Todo) fails closed', () => {
  const result = evaluateReviewResult(reviewFixture({ outcome: 'revision_required', canonicalStatus: 'In Review' }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unexpected_canonical_status');
});

test('v1C. pass with wrong canonicalStatus (not Done) fails closed', () => {
  const result = evaluateReviewResult(reviewFixture({ outcome: 'pass', canonicalStatus: 'In Review' }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unexpected_canonical_status');
});

test('v1C. needs_human with wrong canonicalStatus (not Done) fails closed', () => {
  const result = evaluateReviewResult(reviewFixture({ outcome: 'needs_human', canonicalStatus: 'Todo' }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unexpected_canonical_status');
});

test('v1C. resultPosted:false on a terminal outcome fails closed', () => {
  const result = evaluateReviewResult(reviewFixture({ resultPosted: false }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'result_not_posted');
});

test('v1C. wrong verifiedTeamId/verifiedProjectId/verifiedPickupState each fail closed', () => {
  assert.equal(evaluateReviewResult(reviewFixture({ verifiedTeamId: 'other-team' })).reason, 'wrong_verified_team');
  assert.equal(evaluateReviewResult(reviewFixture({ verifiedProjectId: 'other-project' })).reason, 'wrong_verified_project');
  assert.equal(evaluateReviewResult(reviewFixture({ verifiedPickupState: 'Todo' })).reason, 'wrong_verified_pickup_state');
});

// DEMO-65 proof-derived correction: crash-recovery review-action-token gate.
// The token is deterministic per (cycle_id, trustedRevisionCount) — a
// retried turn reporting the SAME token as a prior crashed attempt must be
// accepted (this is exactly the recovery path), but a turn reporting ANY
// other token — belonging to a different cycle or a different revision
// round — must never be accepted as finalizing the current decision.
test('12. a matching reviewActionToken (crash-recovery retry reporting the same deterministic token) is accepted', () => {
  const result = evaluateReviewResult(reviewFixture({ reviewActionToken: DEFAULT_REVIEW_ACTION_TOKEN }));
  assert.equal(result.ok, true);
});

test('12. a stale/mismatched reviewActionToken fails closed on every terminal outcome (pass, revision_required, needs_human)', () => {
  const staleToken = 'cycle-fixture-r99'; // looks plausible but belongs to a different round
  const pass = evaluateReviewResult(reviewFixture({ reviewActionToken: staleToken }));
  assert.equal(pass.ok, false);
  assert.equal(pass.reason, 'review_action_token_mismatch');

  const revisionRequired = evaluateReviewResult(
    reviewFixture({ outcome: 'revision_required', canonicalStatus: 'Todo', reviewActionToken: staleToken }),
  );
  assert.equal(revisionRequired.ok, false);
  assert.equal(revisionRequired.reason, 'review_action_token_mismatch');

  const needsHuman = evaluateReviewResult(reviewFixture({ outcome: 'needs_human', reviewActionToken: staleToken }));
  assert.equal(needsHuman.ok, false);
  assert.equal(needsHuman.reason, 'review_action_token_mismatch');
});

test('12. a missing/empty reviewActionToken fails closed (schema_invalid, before the token-match gate even runs)', () => {
  const result = evaluateReviewResult(reviewEnvelopeWithStructured({ ...validReviewStructured(), reviewActionToken: '' }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'schema_invalid');
});

test('v1C. issueIdentifier mismatch fails closed', () => {
  const result = evaluateReviewResult(reviewEnvelope({ expectedIssueIdentifier: 'DEMO-DIFFERENT' }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'issue_mismatch');
});

test('v1C. session mismatch fails closed', () => {
  const result = evaluateReviewResult(reviewEnvelope({ expectedSessionId: 'sid-DIFFERENT' }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'session_mismatch');
});

test('v1C. schema-invalid structured output (e.g. a commitSha field) fails closed', () => {
  const result = evaluateReviewResult(reviewEnvelopeWithStructured({ ...validReviewStructured(), commitSha: 'abc123' }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'schema_invalid');
});

test('v1C. malformed envelope / nonzero exit / timeout / signal / spawn error all fail closed', () => {
  assert.equal(evaluateReviewResult(reviewEnvelope({ stdout: '{not valid json' })).reason, 'unparseable_envelope');
  assert.equal(evaluateReviewResult(reviewEnvelope({ code: 1 })).reason, 'nonzero_exit');
  assert.equal(evaluateReviewResult(reviewEnvelope({ timedOut: true, code: null })).reason, 'timeout');
  assert.equal(evaluateReviewResult(reviewEnvelope({ signal: 'SIGKILL', code: null })).reason, 'signal');
  assert.equal(evaluateReviewResult(reviewEnvelope({ spawnError: new Error('ENOENT'), code: null })).reason, 'spawn_error');
});
