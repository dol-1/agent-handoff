import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { evaluateWebhook } from '../src/webhook.js';
import { DedupStore } from '../src/dedupStore.js';
import { loadConfig } from '../src/config.js';

const SECRET = 'test-secret-value';
const NOW = 1_700_000_000_000;

function baseConfig(overrides = {}) {
  return {
    ...loadConfig({}),
    webhookSecret: SECRET,
    ...overrides,
  };
}

function freshDedupStore() {
  return new DedupStore({ ttlMs: 60_000, maxEntries: 100 });
}

function issuePayload(overrides = {}) {
  const config = baseConfig();
  return {
    action: 'update',
    type: 'Issue',
    webhookTimestamp: NOW,
    url: 'https://linear.app/example/issue/DEMO-60/example',
    // Linear only includes a field in updatedFrom when it changed, so this
    // marks the payload as a real transition into the current state.
    updatedFrom: { stateId: 'previous-state-uuid' },
    data: {
      id: 'issue-uuid-1',
      identifier: 'DEMO-60',
      title: 'Sensitive title text that must never leak',
      description: 'Sensitive description body that must never leak',
      url: 'https://linear.app/example/issue/DEMO-60/example',
      team: { id: config.allowedTeamId },
      project: { id: config.allowedProjectId },
      state: { id: 'state-uuid', name: 'Todo', type: 'unstarted' },
    },
    ...overrides,
  };
}

function sign(rawBody, secret = SECRET) {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

function makeRequest({ payload, secret = SECRET, deliveryId = 'delivery-1', signatureOverride } = {}) {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const signature = signatureOverride ?? sign(rawBody, secret);
  return {
    rawBody,
    headers: {
      'linear-signature': signature,
      'linear-delivery': deliveryId,
    },
  };
}

test('1. valid signature is accepted end to end', () => {
  const req = makeRequest({ payload: issuePayload() });
  const result = evaluateWebhook({
    rawBody: req.rawBody,
    headers: req.headers,
    config: baseConfig(),
    dedupStore: freshDedupStore(),
    now: NOW,
  });
  assert.equal(result.accepted, true);
});

test('2. invalid signature is rejected', () => {
  const req = makeRequest({ payload: issuePayload(), signatureOverride: sign(Buffer.from('tampered')) });
  const result = evaluateWebhook({
    rawBody: req.rawBody,
    headers: req.headers,
    config: baseConfig(),
    dedupStore: freshDedupStore(),
    now: NOW,
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'invalid_signature');
});

test('3. stale timestamp outside the 60s window is rejected', () => {
  const payload = issuePayload({ webhookTimestamp: NOW - 61_000 });
  const req = makeRequest({ payload });
  const result = evaluateWebhook({
    rawBody: req.rawBody,
    headers: req.headers,
    config: baseConfig(),
    dedupStore: freshDedupStore(),
    now: NOW,
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'stale_timestamp');
});

test('4. duplicate Linear-Delivery is rejected deterministically', () => {
  const dedupStore = freshDedupStore();
  const config = baseConfig();
  const req = makeRequest({ payload: issuePayload(), deliveryId: 'delivery-dup' });

  const first = evaluateWebhook({ rawBody: req.rawBody, headers: req.headers, config, dedupStore, now: NOW });
  const second = evaluateWebhook({ rawBody: req.rawBody, headers: req.headers, config, dedupStore, now: NOW });

  assert.equal(first.accepted, true);
  assert.equal(second.accepted, false);
  assert.equal(second.reason, 'duplicate_delivery');
});

test('5. wrong team is rejected', () => {
  const payload = issuePayload({ data: { ...issuePayload().data, team: { id: 'some-other-team' } } });
  const req = makeRequest({ payload });
  const result = evaluateWebhook({
    rawBody: req.rawBody,
    headers: req.headers,
    config: baseConfig(),
    dedupStore: freshDedupStore(),
    now: NOW,
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'wrong_team');
});

test('6. wrong project is rejected', () => {
  const payload = issuePayload({ data: { ...issuePayload().data, project: { id: 'some-other-project' } } });
  const req = makeRequest({ payload });
  const result = evaluateWebhook({
    rawBody: req.rawBody,
    headers: req.headers,
    config: baseConfig(),
    dedupStore: freshDedupStore(),
    now: NOW,
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'wrong_project');
});

test('7. non-Todo target state is rejected', () => {
  const payload = issuePayload({ data: { ...issuePayload().data, state: { id: 's', name: 'In Progress', type: 'started' } } });
  const req = makeRequest({ payload });
  const result = evaluateWebhook({
    rawBody: req.rawBody,
    headers: req.headers,
    config: baseConfig(),
    dedupStore: freshDedupStore(),
    now: NOW,
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'wrong_target_state');
});

test('8. accepted payload normalizes with no title/description/body leakage', () => {
  const req = makeRequest({ payload: issuePayload() });
  const result = evaluateWebhook({
    rawBody: req.rawBody,
    headers: req.headers,
    config: baseConfig(),
    dedupStore: freshDedupStore(),
    now: NOW,
  });

  assert.equal(result.accepted, true);
  const serialized = JSON.stringify(result.normalizedEvent);

  assert.deepEqual(Object.keys(result.normalizedEvent).sort(), [
    'event',
    'issueId',
    'issueIdentifier',
    'projectId',
    'targetState',
    'teamId',
    'url',
  ]);
  assert.equal(result.normalizedEvent.issueIdentifier, 'DEMO-60');
  assert.equal(result.normalizedEvent.event, 'issue_entered_todo');
  assert.doesNotMatch(serialized, /Sensitive/);
  assert.ok(!('title' in result.normalizedEvent));
  assert.ok(!('description' in result.normalizedEvent));
});

test('11. issue created directly in Todo is accepted as a transition', () => {
  const payload = issuePayload({ action: 'create', updatedFrom: undefined });
  const req = makeRequest({ payload });
  const result = evaluateWebhook({
    rawBody: req.rawBody,
    headers: req.headers,
    config: baseConfig(),
    dedupStore: freshDedupStore(),
    now: NOW,
  });
  assert.equal(result.accepted, true);
});

test('12. unrelated update to an issue that was already Todo is rejected', () => {
  // updatedFrom present (something changed) but without stateId: the
  // state itself did not change in this delivery, e.g. only the title
  // was edited on an issue that was already Todo.
  const payload = issuePayload({ updatedFrom: { title: 'previous title' } });
  const req = makeRequest({ payload });
  const result = evaluateWebhook({
    rawBody: req.rawBody,
    headers: req.headers,
    config: baseConfig(),
    dedupStore: freshDedupStore(),
    now: NOW,
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'not_a_state_transition');
});

test('malformed JSON body with a valid signature is rejected, not crashed on', () => {
  const rawBody = Buffer.from('not json');
  const signature = sign(rawBody);
  const result = evaluateWebhook({
    rawBody,
    headers: { 'linear-signature': signature, 'linear-delivery': 'd-1' },
    config: baseConfig(),
    dedupStore: freshDedupStore(),
    now: NOW,
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'malformed_payload');
});

test('missing Linear-Delivery header is rejected', () => {
  const payload = issuePayload();
  const rawBody = Buffer.from(JSON.stringify(payload));
  const result = evaluateWebhook({
    rawBody,
    headers: { 'linear-signature': sign(rawBody) },
    config: baseConfig(),
    dedupStore: freshDedupStore(),
    now: NOW,
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'missing_delivery_id');
});
