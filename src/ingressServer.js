import { join } from 'node:path';
import { loadConfig, assertExplicitV1BRouting } from './config.js';
import { assertSupportedNode } from './nodeVersionGuard.js';

// v1B durable ingress entrypoint (DEMO-62 section A). Standalone process —
// no MCP/stdio role, safe to run/restart independently of any Claude
// session. Intended to be launched only via systemd/agent-handoff-ingress.service
// (a template in this repo; NOT installed/enabled by this change) under the
// pinned Node 24 binary, never the system-default `node`.

function log(message) {
  process.stderr.write(`[agent-handoff-ingress] ${message}\n`);
}

// DEMO-62 proof-derived correction (2 of 2): v1B must never silently launch
// on loadConfig()'s v1A-oriented default routing scope — see config.js.
assertExplicitV1BRouting(process.env, log);

const config = loadConfig();
// Must run before any import that touches node:sqlite (durableStore.js) —
// that import is a top-level `import { DatabaseSync } from 'node:sqlite'`,
// which Node evaluates eagerly and would otherwise crash with a raw
// ERR_UNKNOWN_BUILTIN_MODULE before this guard's clear message could print.
assertSupportedNode(log);

const { DurableStore } = await import('./durableStore.js');
const { createIngressReceiver } = await import('./ingressReceiver.js');

if (!config.webhookSecret) {
  log('LINEAR_WEBHOOK_SECRET is not set; every webhook will be rejected until it is.');
}

const dbPath = join(config.runtimeDataDir, config.dbFileName);
const store = new DurableStore(dbPath);
log(`durable store ready at ${dbPath} (pending=${store.countPending()})`);

const httpServer = createIngressReceiver({ config, store, log });

httpServer.listen(config.port, config.host, () => {
  log(`listening on http://${config.host}:${config.port} (healthz + POST /hooks/linear)`);
});

httpServer.on('error', (err) => {
  log(`HTTP receiver error: ${err.message}`);
});

function shutdown(signal) {
  log(`received ${signal}, closing`);
  httpServer.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
