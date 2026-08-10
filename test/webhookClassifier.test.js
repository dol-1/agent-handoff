// Pure-logic tests for the v1B classifier (no SQLite, runs under any
// supported Node). Complements test/webhook.test.js, which continues to
// cover the untouched v1A evaluateWebhook().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { classifyWebhook, UNVERIFIED_HTTP_STATUS, REVIEW_TARGET_STATE_NAME, DONE_STATE_NAME } from '../src/webhookClassifier.js';

const SECRET = 'test-secret';
const CONFIG = {
  webhookSecret: SECRET,
  timestampWindowMs: 60_000,
  allowedTeamId: 'team-1',
  allowedProjectId: 'project-1',
  allowedTargetStateName: 'Todo',
};

function sign(body) {
  return createHmac('sha256', SECRET).update(body).digest('hex');
}

function makeRequest(payloadObj, { deliveryId = 'delivery-1', badSignature = false } = {}) {
  const rawBody = Buffer.from(JSON.stringify(payloadObj));
  const signature = badSignature ? '00'.repeat(32) : sign(rawBody);
  return {
    rawBody,
    headers: {
      'linear-signature': signature,
      'linear-delivery': deliveryId,
    },
  };
}

function basePayload(overrides = {}) {
  return {
    action: 'update',
    type: 'Issue',
    webhookTimestamp: Date.now(),
    updatedFrom: { stateId: 'old-state' },
    data: {
      id: 'issue-uuid',
      identifier: 'DEMO-62',
      team: { id: 'team-1' },
      project: { id: 'project-1' },
      state: { name: 'Todo' },
      url: 'https://linear.app/example/issue/DEMO-62/example',
    },
    ...overrides,
  };
}

test('accepted: verified + relevant, normalized event has no free text, jobType=execute for Todo', () => {
  const payload = {
    ...basePayload(),
    data: {
      ...basePayload().data,
      title: 'secret plan',
      description: 'do not leak this',
    },
  };
  const { rawBody, headers } = makeRequest(payload);
  const result = classifyWebhook({ rawBody, headers, config: CONFIG });

  assert.equal(result.verified, true);
  assert.equal(result.relevant, true);
  assert.equal(result.normalizedEvent.issueIdentifier, 'DEMO-62');
  assert.equal(result.normalizedEvent.jobType, 'execute');
  const serialized = JSON.stringify(result.normalizedEvent);
  assert.ok(!serialized.includes('secret plan'));
  assert.ok(!serialized.includes('do not leak'));
  assert.deepEqual(Object.keys(result.normalizedEvent).sort(), [
    'event',
    'issueId',
    'issueIdentifier',
    'jobType',
    'projectId',
    'targetState',
    'teamId',
    'url',
  ]);
});

// DEMO-65 v1C, requirement 2: a verified transition into In Review creates
// job_type=review.
test('2. In Review transition: verified + relevant, jobType=review', () => {
  const payload = basePayload({ data: { ...basePayload().data, state: { name: REVIEW_TARGET_STATE_NAME } } });
  const { rawBody, headers } = makeRequest(payload);
  const result = classifyWebhook({ rawBody, headers, config: CONFIG });
  assert.equal(result.verified, true);
  assert.equal(result.relevant, true);
  assert.equal(result.normalizedEvent.jobType, 'review');
  assert.equal(result.normalizedEvent.targetState, REVIEW_TARGET_STATE_NAME);
  assert.equal(result.normalizedEvent.event, 'issue_entered_review');
});

// DEMO-65 v1C, requirement 3: a comment-only webhook (not an Issue state
// transition) must never create a job of either type.
test('3. comment-type webhook payload -> not relevant, no job', () => {
  const payload = { action: 'create', type: 'Comment', webhookTimestamp: Date.now(), data: { id: 'comment-1', issue: { identifier: 'DEMO-62' } } };
  const { rawBody, headers } = makeRequest(payload);
  const result = classifyWebhook({ rawBody, headers, config: CONFIG });
  assert.equal(result.verified, true);
  assert.equal(result.relevant, false);
});

// DEMO-65 v1C, requirement 14: Done is terminal for automation and must
// never enqueue work — a transition into Done is simply not one of the two
// allowed target states, so it is rejected the same way any other
// non-Todo/non-In-Review state is.
test('14. Done transition -> not relevant, no job (Done is terminal, never enqueues work)', () => {
  const payload = basePayload({ data: { ...basePayload().data, state: { name: DONE_STATE_NAME } } });
  const { rawBody, headers } = makeRequest(payload);
  const result = classifyWebhook({ rawBody, headers, config: CONFIG });
  assert.equal(result.relevant, false);
  assert.equal(result.reason, 'wrong_target_state');
});

test('invalid signature: never verified, generic non-200 reason', () => {
  const { rawBody, headers } = makeRequest(basePayload(), { badSignature: true });
  const result = classifyWebhook({ rawBody, headers, config: CONFIG });
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'invalid_signature');
  assert.equal(UNVERIFIED_HTTP_STATUS[result.reason], 401);
});

test('stale timestamp is unverified, not queued', () => {
  const payload = basePayload({ webhookTimestamp: Date.now() - 10 * 60_000 });
  const { rawBody, headers } = makeRequest(payload);
  const result = classifyWebhook({ rawBody, headers, config: CONFIG });
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'stale_timestamp');
});

test('malformed JSON with a valid signature does not throw', () => {
  const rawBody = Buffer.from('{not json');
  const headers = { 'linear-signature': sign(rawBody), 'linear-delivery': 'd1' };
  const result = classifyWebhook({ rawBody, headers, config: CONFIG });
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'malformed_payload');
});

test('missing Linear-Delivery header is unverified', () => {
  const rawBody = Buffer.from(JSON.stringify(basePayload()));
  const headers = { 'linear-signature': sign(rawBody) };
  const result = classifyWebhook({ rawBody, headers, config: CONFIG });
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'missing_delivery_id');
});

test('wrong team: verified but not relevant', () => {
  const payload = basePayload({ data: { ...basePayload().data, team: { id: 'other-team' } } });
  const { rawBody, headers } = makeRequest(payload);
  const result = classifyWebhook({ rawBody, headers, config: CONFIG });
  assert.equal(result.verified, true);
  assert.equal(result.relevant, false);
  assert.equal(result.reason, 'wrong_team');
});

test('wrong project: verified but not relevant', () => {
  const payload = basePayload({ data: { ...basePayload().data, project: { id: 'other-project' } } });
  const { rawBody, headers } = makeRequest(payload);
  const result = classifyWebhook({ rawBody, headers, config: CONFIG });
  assert.equal(result.relevant, false);
  assert.equal(result.reason, 'wrong_project');
});

test('non-Todo state: verified but not relevant', () => {
  const payload = basePayload({ data: { ...basePayload().data, state: { name: 'In Progress' } } });
  const { rawBody, headers } = makeRequest(payload);
  const result = classifyWebhook({ rawBody, headers, config: CONFIG });
  assert.equal(result.relevant, false);
  assert.equal(result.reason, 'wrong_target_state');
});

test('already-Todo issue edited without a state change is not a transition', () => {
  const payload = basePayload({ updatedFrom: { title: 'old title' } });
  const { rawBody, headers } = makeRequest(payload);
  const result = classifyWebhook({ rawBody, headers, config: CONFIG });
  assert.equal(result.relevant, false);
  assert.equal(result.reason, 'not_a_state_transition');
});

test('create directly into Todo is accepted as a transition', () => {
  const payload = basePayload({ action: 'create', updatedFrom: undefined });
  const { rawBody, headers } = makeRequest(payload);
  const result = classifyWebhook({ rawBody, headers, config: CONFIG });
  assert.equal(result.relevant, true);
});
