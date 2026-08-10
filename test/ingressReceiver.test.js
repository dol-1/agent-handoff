// Requires Node >=22.5 (built-in node:sqlite) — see durableStore.test.js for
// why this file self-skips under older Node instead of throwing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { isNodeSqliteSupported, MIN_NODE_VERSION } from '../src/nodeVersionGuard.js';

if (!isNodeSqliteSupported()) {
  test(
    `ingressReceiver tests require Node >=${MIN_NODE_VERSION.join('.')} (node:sqlite) — skipped under Node ${process.versions.node}`,
    { skip: true },
    () => {},
  );
} else {
  const { DurableStore } = await import('../src/durableStore.js');
  const { createIngressReceiver } = await import('../src/ingressReceiver.js');

  const SECRET = 'test-secret-value';

  function sign(rawBody) {
    return createHmac('sha256', SECRET).update(rawBody).digest('hex');
  }

  function basePayload(overrides = {}, config) {
    return {
      action: 'update',
      type: 'Issue',
      webhookTimestamp: Date.now(),
      updatedFrom: { stateId: 'previous-state-uuid' },
      data: {
        id: 'issue-uuid-1',
        identifier: 'DEMO-62',
        title: 'must-not-leak-title',
        description: 'must-not-leak-description',
        team: { id: config.allowedTeamId },
        project: { id: config.allowedProjectId },
        state: { name: 'Todo' },
        url: 'https://linear.app/example/issue/DEMO-62/example',
      },
      ...overrides,
    };
  }

  function startServer(storeOverride) {
    const config = { ...loadConfig({}), webhookSecret: SECRET };
    const dbPath = join(mkdtempSync(join(tmpdir(), 'agent-handoff-ingress-')), 'queue.db');
    const store = storeOverride ?? new DurableStore(dbPath);
    const accepted = [];
    const server = createIngressReceiver({
      config,
      store,
      onAccepted: (event) => accepted.push(event),
    });
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        resolve({ server, port, store, config, accepted, dbPath });
      });
    });
  }

  function stopServer({ server, store }) {
    return new Promise((resolve) => server.close(resolve)).then(() => store.close());
  }

  async function post(port, { body, deliveryId = 'delivery-1', badSignature = false }) {
    const rawBody = Buffer.from(JSON.stringify(body));
    const signature = badSignature ? '00'.repeat(32) : sign(rawBody);
    return fetch(`http://127.0.0.1:${port}/hooks/linear`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'linear-signature': signature,
        'linear-delivery': deliveryId,
      },
      body: rawBody,
    });
  }

  test('accepted + durably enqueued relevant event -> HTTP 200, no leakage', async () => {
    const ctx = await startServer();
    try {
      const res = await post(ctx.port, { body: basePayload({}, ctx.config) });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.ok, true);
      assert.equal(ctx.store.countPending(), 1);
      const [row] = ctx.store.listPendingEvents();
      assert.doesNotMatch(JSON.stringify(row.normalizedEvent), /must-not-leak/);
    } finally {
      await stopServer(ctx);
    }
  });

  test('5. verified but irrelevant (wrong project) event -> HTTP 200 ignored, not queued, no Channel nudge', async () => {
    const ctx = await startServer();
    try {
      const payload = basePayload({ data: { ...basePayload({}, ctx.config).data, project: { id: 'other' } } }, ctx.config);
      const res = await post(ctx.port, { body: payload });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.ignored, true);
      assert.equal(ctx.store.countPending(), 0);
      assert.equal(ctx.accepted.length, 0);
    } finally {
      await stopServer(ctx);
    }
  });

  test('duplicate Linear-Delivery -> deterministic HTTP 200, no second row', async () => {
    const ctx = await startServer();
    try {
      const payload = basePayload({}, ctx.config);
      const first = await post(ctx.port, { body: payload, deliveryId: 'dup-1' });
      assert.equal(first.status, 200);
      const second = await post(ctx.port, { body: payload, deliveryId: 'dup-1' });
      assert.equal(second.status, 200);
      const secondJson = await second.json();
      assert.equal(secondJson.duplicate, true);
      assert.equal(ctx.store.countPending(), 1);
      assert.equal(ctx.accepted.length, 1);
    } finally {
      await stopServer(ctx);
    }
  });

  test('4. invalid signature -> explicit non-200 rejection, never queued', async () => {
    const ctx = await startServer();
    try {
      const res = await post(ctx.port, { body: basePayload({}, ctx.config), badSignature: true });
      assert.equal(res.status, 401);
      assert.equal(ctx.store.countPending(), 0);
    } finally {
      await stopServer(ctx);
    }
  });

  test('6. malformed payload does not crash the service, returns 400', async () => {
    const ctx = await startServer();
    try {
      const rawBody = Buffer.from('{not json');
      const res = await fetch(`http://127.0.0.1:${ctx.port}/hooks/linear`, {
        method: 'POST',
        headers: { 'linear-signature': sign(rawBody), 'linear-delivery': 'd-malformed' },
        body: rawBody,
      });
      assert.equal(res.status, 400);
      // Server is still up and healthy afterward.
      const health = await fetch(`http://127.0.0.1:${ctx.port}/healthz`);
      assert.equal(health.status, 200);
    } finally {
      await stopServer(ctx);
    }
  });

  test('internal failure before durable commit -> HTTP 500 (retryable)', async () => {
    const ctx = await startServer();
    try {
      const originalRecord = ctx.store.recordDelivery.bind(ctx.store);
      ctx.store.recordDelivery = () => {
        throw new Error('simulated disk failure');
      };
      const res = await post(ctx.port, { body: basePayload({}, ctx.config) });
      assert.equal(res.status, 500);
      ctx.store.recordDelivery = originalRecord;
    } finally {
      await stopServer(ctx);
    }
  });

  test('12. GET /healthz reports queue state (pending count) accurately', async () => {
    const ctx = await startServer();
    try {
      const before = await (await fetch(`http://127.0.0.1:${ctx.port}/healthz`)).json();
      assert.equal(before.queue.ok, true);
      assert.equal(before.queue.pending, 0);
      assert.equal(before.queue.needsReview, 0);

      await post(ctx.port, { body: basePayload({}, ctx.config), deliveryId: 'health-1' });

      const after = await (await fetch(`http://127.0.0.1:${ctx.port}/healthz`)).json();
      assert.equal(after.queue.pending, 1);
    } finally {
      await stopServer(ctx);
    }
  });

  test('6. GET /healthz reports non-ready (503, ok:false) when the durable store is unreachable', async () => {
    const ctx = await startServer();
    try {
      const originalCountPending = ctx.store.countPending.bind(ctx.store);
      ctx.store.countPending = () => {
        throw new Error('simulated disk failure');
      };

      const res = await fetch(`http://127.0.0.1:${ctx.port}/healthz`);
      assert.equal(res.status, 503);
      const json = await res.json();
      assert.equal(json.ok, false);
      assert.equal(json.queue.ok, false);
      // No error message/stack leaks into the response body.
      assert.doesNotMatch(JSON.stringify(json), /simulated disk failure/);

      ctx.store.countPending = originalCountPending;
    } finally {
      await stopServer(ctx);
    }
  });
}
