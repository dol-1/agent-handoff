// v1B durable HTTP ingress (DEMO-62 sections A/B). Structurally identical
// endpoints to v1A's httpReceiver.js (GET /healthz, POST /hooks/linear), but:
//   - backed by DurableStore (SQLite) instead of the in-memory DedupStore;
//   - implements Linear's actual webhook contract: only a non-200 response
//     is treated as a failed delivery and retried, so every verified request
//     (including intentionally-ignored ones) returns 200, and only
//     signature/parse/freshness/protocol failures return non-200;
//   - never invokes the Channel push path itself (see channelServer.js) —
//     `onAccepted` here is an optional low-latency nudge only; the durable
//     queue plus the Channel runner's poll loop is the source of truth for
//     delivery, so a missed/slow nudge cannot lose an event.
//
// v1A's httpReceiver.js is left untouched and still backs the live
// registered MCP entrypoint (server.js).

import { createServer } from 'node:http';
import { classifyWebhook, UNVERIFIED_HTTP_STATUS } from './webhookClassifier.js';

const MAX_BODY_BYTES = 1_000_000;

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function lowercaseHeaders(rawHeaders) {
  const out = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

// onAccepted(normalizedEvent) is an optional latency optimization only —
// correctness never depends on it being called or succeeding.
export function createIngressReceiver({ config, store, onAccepted = () => {}, log = () => {} }) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/healthz') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      try {
        const pending = store.countPending();
        // DEMO-62 one-shot-worker revision: surface needsReview so an item
        // that exhausted its retry budget is visible here too, not just in
        // the worker's own logs — "never silently discard" applies to
        // observability, not only to the store itself.
        const needsReview = store.countNeedsReview();
        sendJson(res, 200, { ok: true, queue: { ok: true, pending, needsReview } });
      } catch (err) {
        // DEMO-62 revision item 6: a durable-queue service whose store is
        // unreachable is NOT ready — report it as such (503, top-level
        // ok:false) rather than a healthy 200. Detail is deliberately
        // generic (no error message/stack), matching the no-sensitive-data
        // logging rule elsewhere in this service.
        log(`healthz store check failed: ${err?.message ?? err}`);
        sendJson(res, 503, { ok: false, queue: { ok: false, error: 'store_unavailable' } });
      }
      return;
    }

    if (url.pathname === '/hooks/linear') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }

      let rawBody;
      try {
        rawBody = await readRawBody(req);
      } catch {
        sendJson(res, 413, { ok: false, error: 'body_too_large' });
        return;
      }

      const headers = lowercaseHeaders(req.headers);
      const classified = classifyWebhook({ rawBody, headers, config });

      if (!classified.verified) {
        log(`rejected webhook (unverified): ${classified.reason}`);
        sendJson(res, UNVERIFIED_HTTP_STATUS[classified.reason] ?? 400, {
          ok: false,
          reason: classified.reason,
        });
        return;
      }

      let recorded;
      try {
        recorded = store.recordDelivery({
          deliveryId: classified.deliveryId,
          now: Date.now(),
          relevant: classified.relevant,
          reason: classified.reason,
          issueIdentifier: classified.issueIdentifier,
          normalizedEvent: classified.normalizedEvent,
          // DEMO-65 v1C: routes to the execute or review leg depending on
          // which allowed state was entered — see webhookClassifier.js.
          jobType: classified.normalizedEvent?.jobType,
        });
      } catch (err) {
        // Internal failure before durable commit: non-200 so Linear retries.
        log(`durable enqueue failed: ${err?.message ?? err}`);
        sendJson(res, 500, { ok: false, reason: 'internal_error' });
        return;
      }

      if (recorded.duplicate) {
        log(`duplicate delivery ${classified.deliveryId}, outcome=${recorded.outcome}`);
        sendJson(res, 200, { ok: true, duplicate: true, outcome: recorded.outcome });
        return;
      }

      if (recorded.outcome === 'ignored') {
        log(`ignored webhook: ${classified.reason}`);
        sendJson(res, 200, { ok: true, ignored: true, reason: classified.reason });
        return;
      }

      log(`accepted webhook: ${classified.normalizedEvent.issueIdentifier} -> ${classified.normalizedEvent.targetState} (${classified.normalizedEvent.jobType})`);
      try {
        onAccepted(classified.normalizedEvent);
      } catch (err) {
        log(`onAccepted nudge failed (non-fatal, queue still durable): ${err?.message ?? err}`);
      }
      sendJson(res, 200, { ok: true, eventId: recorded.eventId });
      return;
    }

    sendJson(res, 404, { ok: false, error: 'not_found' });
  });
}
