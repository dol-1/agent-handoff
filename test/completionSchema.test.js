import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCompletionOutput, validateReconciliationOutput, validateReviewOutput } from '../src/completionSchema.js';

const validCompletion = {
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
};

test('validateCompletionOutput accepts a valid object', () => {
  const result = validateCompletionOutput(validCompletion);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('validateCompletionOutput accepts commitSha:null (non-completed outcomes)', () => {
  const result = validateCompletionOutput({ ...validCompletion, outcome: 'not_eligible', commitSha: null, resultPosted: false });
  assert.equal(result.valid, true);
});

// DEMO-62 proof-derived correction (1 of 2): completed_no_commit is a valid
// terminal outcome for a genuine no-tracked-repo-change completion.
test('validateCompletionOutput accepts completed_no_commit with commitSha:null', () => {
  const result = validateCompletionOutput({ ...validCompletion, outcome: 'completed_no_commit', commitSha: null });
  assert.equal(result.valid, true);
});

test('validateCompletionOutput rejects wrong protocolVersion', () => {
  const result = validateCompletionOutput({ ...validCompletion, protocolVersion: 2 });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /protocolVersion/);
});

test('validateCompletionOutput rejects an invalid outcome enum value', () => {
  const result = validateCompletionOutput({ ...validCompletion, outcome: 'done' });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /outcome/);
});

test('validateCompletionOutput rejects non-boolean resultPosted', () => {
  const result = validateCompletionOutput({ ...validCompletion, resultPosted: 'true' });
  assert.equal(result.valid, false);
});

test('validateCompletionOutput rejects a non-string/non-null commitSha', () => {
  const result = validateCompletionOutput({ ...validCompletion, commitSha: 123 });
  assert.equal(result.valid, false);
});

test('validateCompletionOutput rejects additional properties (schema drift)', () => {
  const result = validateCompletionOutput({ ...validCompletion, extraField: 'nope' });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /extraField/);
});

test('validateCompletionOutput rejects missing required fields', () => {
  const { summary, ...missingSummary } = validCompletion;
  const result = validateCompletionOutput(missingSummary);
  assert.equal(result.valid, false);
});

test('2. validateCompletionOutput accepts null verifiedTeamId/verifiedProjectId/verifiedPickupState (a turn that never got far enough to verify)', () => {
  const result = validateCompletionOutput({
    ...validCompletion,
    outcome: 'failed',
    resultPosted: false,
    commitSha: null,
    verifiedTeamId: null,
    verifiedProjectId: null,
    verifiedPickupState: null,
  });
  assert.equal(result.valid, true);
});

test('2. validateCompletionOutput rejects a missing verifiedTeamId key entirely (not just null)', () => {
  const { verifiedTeamId, ...missingVerifiedTeamId } = validCompletion;
  const result = validateCompletionOutput(missingVerifiedTeamId);
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /verifiedTeamId/);
});

test('validateCompletionOutput rejects non-object input without throwing', () => {
  assert.equal(validateCompletionOutput(null).valid, false);
  assert.equal(validateCompletionOutput('a string').valid, false);
  assert.equal(validateCompletionOutput([1, 2]).valid, false);
  assert.equal(validateCompletionOutput(undefined).valid, false);
});

// --- DEMO-65 v1C: review schema/validator ---

const validReview = {
  protocolVersion: 1,
  issueIdentifier: 'DEMO-65',
  outcome: 'pass',
  canonicalStatus: 'Done',
  resultPosted: true,
  verifiedTeamId: 'team-1',
  verifiedProjectId: 'project-1',
  verifiedPickupState: 'In Review',
  reviewActionToken: 'cycle-abc-r0',
  summary: 'reviewed',
};

test('9. validateReviewOutput accepts a valid pass object', () => {
  const result = validateReviewOutput(validReview);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('9. validateReviewOutput accepts a valid revision_required object', () => {
  const result = validateReviewOutput({ ...validReview, outcome: 'revision_required', canonicalStatus: 'Todo' });
  assert.equal(result.valid, true);
});

test('9. validateReviewOutput accepts a valid needs_human object', () => {
  const result = validateReviewOutput({ ...validReview, outcome: 'needs_human', canonicalStatus: 'Done' });
  assert.equal(result.valid, true);
});

test('9. validateReviewOutput accepts blocked/failed with resultPosted:false and null verified fields', () => {
  for (const outcome of ['blocked', 'failed']) {
    const result = validateReviewOutput({
      ...validReview,
      outcome,
      resultPosted: false,
      verifiedTeamId: null,
      verifiedProjectId: null,
      verifiedPickupState: null,
    });
    assert.equal(result.valid, true, `${outcome} must be valid`);
  }
});

test('9. validateReviewOutput rejects an invalid outcome enum value', () => {
  const result = validateReviewOutput({ ...validReview, outcome: 'approved' });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /outcome/);
});

test('9. validateReviewOutput rejects wrong protocolVersion', () => {
  const result = validateReviewOutput({ ...validReview, protocolVersion: 2 });
  assert.equal(result.valid, false);
});

test('9. validateReviewOutput rejects a missing verifiedTeamId key entirely (not just null)', () => {
  const { verifiedTeamId, ...missing } = validReview;
  const result = validateReviewOutput(missing);
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /verifiedTeamId/);
});

test('9. validateReviewOutput rejects a commitSha field (review never produces one — schema drift check)', () => {
  const result = validateReviewOutput({ ...validReview, commitSha: 'abc123' });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /commitSha/);
});

// DEMO-65 proof-derived correction: unlike verifiedTeamId/etc, reviewActionToken
// is never nullable — it's handed to the turn up front, so it must always
// be a non-empty string, even for blocked/failed.
test('9. validateReviewOutput rejects a missing reviewActionToken key entirely', () => {
  const { reviewActionToken, ...missing } = validReview;
  const result = validateReviewOutput(missing);
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /reviewActionToken/);
});

test('9. validateReviewOutput rejects a null or empty-string reviewActionToken', () => {
  assert.equal(validateReviewOutput({ ...validReview, reviewActionToken: null }).valid, false);
  assert.equal(validateReviewOutput({ ...validReview, reviewActionToken: '' }).valid, false);
});

test('9. validateReviewOutput rejects non-object input without throwing', () => {
  assert.equal(validateReviewOutput(null).valid, false);
  assert.equal(validateReviewOutput('x').valid, false);
  assert.equal(validateReviewOutput(undefined).valid, false);
});

const validReconciliation = {
  protocolVersion: 1,
  teamId: 'team-1',
  projectId: 'project-1',
  targetState: 'Todo',
  eligibleIssues: [{ issueIdentifier: 'DEMO-1', issueId: 'i1', url: 'https://linear.app/x' }],
};

test('10. validateReconciliationOutput accepts a valid object with only routing identifiers', () => {
  const result = validateReconciliationOutput(validReconciliation);
  assert.equal(result.valid, true);
});

test('10. validateReconciliationOutput accepts an empty eligibleIssues array', () => {
  const result = validateReconciliationOutput({ ...validReconciliation, eligibleIssues: [] });
  assert.equal(result.valid, true);
});

test('6. validateReconciliationOutput rejects an eligibleIssues entry missing the required url key entirely', () => {
  const result = validateReconciliationOutput({
    ...validReconciliation,
    eligibleIssues: [{ issueIdentifier: 'DEMO-1', issueId: 'i1' }], // no url key at all, not even undefined
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /url/);
});

test('10. validateReconciliationOutput rejects a free-text field smuggled onto an issue entry', () => {
  const result = validateReconciliationOutput({
    ...validReconciliation,
    eligibleIssues: [{ issueIdentifier: 'DEMO-1', issueId: 'i1', url: null, title: 'leaked title text' }],
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /title/);
});

test('10. validateReconciliationOutput rejects a free-text field at the top level', () => {
  const result = validateReconciliationOutput({ ...validReconciliation, description: 'leaked' });
  assert.equal(result.valid, false);
});

test('validateReconciliationOutput rejects missing required scope fields', () => {
  const { teamId, ...missingTeam } = validReconciliation;
  const result = validateReconciliationOutput(missingTeam);
  assert.equal(result.valid, false);
});

test('validateReconciliationOutput rejects a non-array eligibleIssues', () => {
  const result = validateReconciliationOutput({ ...validReconciliation, eligibleIssues: 'not-an-array' });
  assert.equal(result.valid, false);
});
