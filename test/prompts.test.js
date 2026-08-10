import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExecutionPrompt, buildReviewPrompt, buildReconciliationPrompt } from '../src/prompts.js';

const SCOPE = { allowedTeamId: 'team-1', allowedProjectId: 'project-1', allowedTargetStateName: 'Todo' };

test('buildExecutionPrompt references the issue identifier and instructs canonical re-verification', () => {
  const prompt = buildExecutionPrompt({ issueIdentifier: 'DEMO-62', url: 'https://linear.app/x/DEMO-62', ...SCOPE });
  assert.match(prompt, /DEMO-62/);
  assert.match(prompt, /independently verify/i);
  assert.match(prompt, /structured JSON output/i);
});

test('2. buildExecutionPrompt states the exact configured scope to verify against, not just "verify"', () => {
  const prompt = buildExecutionPrompt({
    issueIdentifier: 'DEMO-62',
    url: null,
    allowedTeamId: 'team-abc',
    allowedProjectId: 'project-xyz',
    allowedTargetStateName: 'Todo',
  });
  assert.match(prompt, /team-abc/);
  assert.match(prompt, /project-xyz/);
  assert.match(prompt, /verifiedTeamId/);
  assert.match(prompt, /verifiedProjectId/);
  assert.match(prompt, /verifiedPickupState/);
});

// DEMO-62 proof-derived correction (1 of 2): the prompt must distinguish
// code-change completion from a legitimate no-tracked-repo-change one.
test('buildExecutionPrompt distinguishes completed (commit required) from completed_no_commit (commitSha null)', () => {
  const prompt = buildExecutionPrompt({ issueIdentifier: 'DEMO-62', url: null, ...SCOPE });
  assert.match(prompt, /completed_no_commit/);
  assert.match(prompt, /commitSha MUST be the real, non-null/);
  assert.match(prompt, /commitSha MUST be exactly null/);
});

test('buildExecutionPrompt never receives (and cannot leak) title/description/comment fields', () => {
  // Only issueIdentifier/url/scope are accepted — passing extra fields has
  // no effect on the output, proving the function structurally cannot emit
  // free text it was never given.
  const prompt = buildExecutionPrompt({
    issueIdentifier: 'DEMO-62',
    url: null,
    title: 'should never appear',
    description: 'should never appear either',
    ...SCOPE,
  });
  assert.doesNotMatch(prompt, /should never appear/);
});

// --- DEMO-65 v1C: buildReviewPrompt ---

test('buildReviewPrompt references the issue, instructs independent canonical + GitHub/PR evidence inspection', () => {
  const prompt = buildReviewPrompt({ issueIdentifier: 'DEMO-65', url: 'https://linear.app/x/DEMO-65', ...SCOPE, revisionCount: 0, maxRevisionCycles: 3, reviewActionToken: 'cycle-1-r0' });
  assert.match(prompt, /DEMO-65/);
  assert.match(prompt, /independently verify/i);
  assert.match(prompt, /PR HEAD/);
  assert.match(prompt, /diff/);
  assert.match(prompt, /CI\/check status/);
  assert.match(prompt, /never proof/);
  assert.match(prompt, /structured JSON output/i);
});

test('buildReviewPrompt states the exact configured team/project scope to verify, and the exact revision count/max', () => {
  const prompt = buildReviewPrompt({ issueIdentifier: 'DEMO-65', url: null, allowedTeamId: 'team-abc', allowedProjectId: 'project-xyz', revisionCount: 1, maxRevisionCycles: 3, reviewActionToken: 'cycle-1-r1' });
  assert.match(prompt, /team-abc/);
  assert.match(prompt, /project-xyz/);
  assert.match(prompt, /revision cycle 1 of a maximum 3/);
  assert.match(prompt, /verifiedTeamId/);
  assert.match(prompt, /verifiedProjectId/);
  assert.match(prompt, /verifiedPickupState/);
});

test('buildReviewPrompt distinguishes pass/revision_required/needs_human and their required Linear actions, below the limit', () => {
  const prompt = buildReviewPrompt({ issueIdentifier: 'DEMO-65', url: null, ...SCOPE, revisionCount: 1, maxRevisionCycles: 3, reviewActionToken: 'cycle-1-r1' });
  assert.match(prompt, /"pass"/);
  assert.match(prompt, /\[OPUS REVIEW #<token>\] PASS — HUMAN GATE/);
  assert.match(prompt, /"revision_required"/);
  assert.match(prompt, /\[OPUS REVIEW #<token>\] REVISION REQUIRED/);
  assert.match(prompt, /"needs_human"/);
  assert.match(prompt, /\[OPUS REVIEW #<token>\] NEEDS HUMAN — HUMAN GATE/);
  assert.match(prompt, /Never merge, deploy/);
  assert.doesNotMatch(prompt, /NOT available/);
});

// DEMO-65 v1C, requirement: max 3 automatic revision cycles — at the limit,
// the prompt must explicitly forbid requesting another revision_required
// round and require needs_human instead.
test('buildReviewPrompt forbids revision_required and requires needs_human once the revision limit is reached', () => {
  const prompt = buildReviewPrompt({ issueIdentifier: 'DEMO-65', url: null, ...SCOPE, revisionCount: 3, maxRevisionCycles: 3, reviewActionToken: 'cycle-1-r3' });
  assert.match(prompt, /"revision_required" is NOT available/);
  assert.match(prompt, /maximum of 3 automatic revision cycles/);
  assert.match(prompt, /must report "needs_human" instead/i);
});

// DEMO-65 proof-derived correction: the prompt must state the exact token
// verbatim, instruct a recovery check for an existing matching-token
// comment BEFORE deciding fresh, and require the token to be echoed back
// regardless of outcome — closing the crash gap between Opus mutating
// Linear and the local durable commit.
test('buildReviewPrompt states the exact reviewActionToken, instructs a recovery check, and requires the marker on the posted comment', () => {
  const prompt = buildReviewPrompt({ issueIdentifier: 'DEMO-65', url: null, ...SCOPE, revisionCount: 0, maxRevisionCycles: 3, reviewActionToken: 'my-unique-token-123' });
  assert.match(prompt, /action token for this exact decision is: my-unique-token-123/);
  assert.match(prompt, /Recovery check FIRST/);
  assert.match(prompt, /\[OPUS REVIEW #my-unique-token-123\]/);
  assert.match(prompt, /not a similar-looking one from an earlier or later revision round/);
  assert.match(prompt, /do NOT post a new comment or take a new Linear state action/);
  assert.match(prompt, /Always report reviewActionToken exactly as given above/);
});

test('buildReviewPrompt never receives (and cannot leak) title/description/comment fields', () => {
  const prompt = buildReviewPrompt({
    issueIdentifier: 'DEMO-65',
    url: null,
    title: 'should never appear',
    description: 'should never appear either',
    revisionCount: 0,
    maxRevisionCycles: 3,
    reviewActionToken: 'cycle-1-r0',
    ...SCOPE,
  });
  assert.doesNotMatch(prompt, /should never appear/);
});

test('buildReconciliationPrompt scopes strictly to the configured team/project/state', () => {
  const prompt = buildReconciliationPrompt({
    allowedTeamId: 'team-1',
    allowedProjectId: 'project-1',
    allowedTargetStateName: 'Todo',
  });
  assert.match(prompt, /team-1/);
  assert.match(prompt, /project-1/);
  assert.match(prompt, /Todo/);
  assert.match(prompt, /no titles, descriptions, comments/i);
});
