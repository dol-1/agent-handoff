import { createServer } from 'node:http';
import { evaluateWebhook } from './webhook.js';

const MAX_BODY_BYTES = 1_000_000; // 1MB is generous for a Linear issue webhook

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

// onAccepted(normalizedEvent) is called only for gate-passing events.
// It is expected to be the only path that pushes anything into the
// Claude Code channel.
export function createHttpReceiver({ config, dedupStore, onAccepted, log = () => {} }) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/healthz') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'application/json' }).end(
          JSON.stringify({ ok: false, error: 'method_not_allowed' }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === '/hooks/linear') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'application/json' }).end(
          JSON.stringify({ ok: false, error: 'method_not_allowed' }),
        );
        return;
      }

      let rawBody;
      try {
        rawBody = await readRawBody(req);
      } catch {
        res.writeHead(413, { 'content-type': 'application/json' }).end(
          JSON.stringify({ ok: false, error: 'body_too_large' }),
        );
        return;
      }

      const result = evaluateWebhook({
        rawBody,
        headers: lowercaseHeaders(req.headers),
        config,
        dedupStore,
      });

      if (!result.accepted) {
        log(`rejected webhook: ${result.reason}`);
        // Deliberately generic status/body: don't help a probing client
        // distinguish "bad signature" from "wrong project" etc.
        res.writeHead(202, { 'content-type': 'application/json' }).end(
          JSON.stringify({ ok: false, reason: result.reason }),
        );
        return;
      }

      log(`accepted webhook: ${result.normalizedEvent.issueIdentifier} -> ${result.normalizedEvent.targetState}`);
      onAccepted(result.normalizedEvent);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'not_found' }));
  });
}
