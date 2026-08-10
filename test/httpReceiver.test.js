import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createHttpReceiver } from '../src/httpReceiver.js';
import { DedupStore } from '../src/dedupStore.js';
import { loadConfig } from '../src/config.js';

const SECRET = 'test-secret-value';

function startServer(overrides = {}) {
  const config = { ...loadConfig({}), webhookSecret: SECRET, ...overrides };
  const dedupStore = new DedupStore({ ttlMs: 60_000, maxEntries: 100 });
  const received = [];
  const server = createHttpReceiver({
    config,
    dedupStore,
    onAccepted: (event) => received.push(event),
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, received, config });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('9. GET /healthz returns 200 ok', async () => {
  const { server, port } = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  } finally {
    await stopServer(server);
  }
});

test('10. non-POST /hooks/linear is rejected', async () => {
  const { server, port } = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/hooks/linear`, { method: 'GET' });
    assert.equal(res.status, 405);
  } finally {
    await stopServer(server);
  }
});

test('accepted webhook reaches onAccepted callback with a normalized event only', async () => {
  const { server, port, received, config } = await startServer();
  try {
    const payload = {
      action: 'update',
      type: 'Issue',
      webhookTimestamp: Date.now(),
      updatedFrom: { stateId: 'previous-state-uuid' },
      data: {
        id: 'issue-uuid-1',
        identifier: 'DEMO-60',
        title: 'must-not-leak',
        team: { id: config.allowedTeamId },
        project: { id: config.allowedProjectId },
        state: { name: 'Todo' },
        url: 'https://linear.app/example/issue/DEMO-60/example',
      },
    };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const signature = createHmac('sha256', SECRET).update(rawBody).digest('hex');

    const res = await fetch(`http://127.0.0.1:${port}/hooks/linear`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'linear-signature': signature,
        'linear-delivery': 'delivery-http-1',
      },
      body: rawBody,
    });

    assert.equal(res.status, 200);
    assert.equal(received.length, 1);
    assert.equal(received[0].issueIdentifier, 'DEMO-60');
    assert.doesNotMatch(JSON.stringify(received[0]), /must-not-leak/);
  } finally {
    await stopServer(server);
  }
});
