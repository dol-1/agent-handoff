import { join } from 'node:path';
import { loadConfig, assertExplicitV1BRouting } from './config.js';
import { assertSupportedNode } from './nodeVersionGuard.js';

// DEMO-62 one-shot-worker entrypoint (replaces channelRunnerEntry.js).
// Standalone Node process — no MCP/stdio role, no Channel. Intended to be
// launched only via bin/agent-handoff-worker.sh under systemd/
// agent-handoff-worker.service (a template in this repo; NOT installed by
// this change) under the pinned Node 24 binary.

function log(message) {
  process.stderr.write(`[agent-handoff-worker] ${message}\n`);
}

// DEMO-62 proof-derived correction (2 of 2): v1B must never silently launch
// on loadConfig()'s v1A-oriented default routing scope — see config.js.
assertExplicitV1BRouting(process.env, log);

const config = loadConfig();
// Must run before any import that touches node:sqlite (durableStore.js) —
// see the matching comment in ingressServer.js.
assertSupportedNode(log);

const { DurableStore } = await import('./durableStore.js');
const { createWorker } = await import('./worker.js');

const dbPath = join(config.runtimeDataDir, config.dbFileName);
const store = new DurableStore(dbPath);
log(
  `durable store opened at ${dbPath} ` +
    `(pending=${store.countPending()}, needs_review=${store.countNeedsReview()})`,
);

const worker = createWorker({ config, store, log });
log(`dedicated worker session id: ${worker.sessionId}`);
// DEMO-65 v1C: the Opus review leg runs under this separate session id.
log(`dedicated reviewer session id: ${worker.reviewerSessionId}`);
worker.start();

// DEMO-62 revision, finding 5: bounded, explicit shutdown — worker.shutdown()
// stops new scheduling, then waits (up to config.workerShutdownGraceMs) for
// any in-flight turn to finish before aborting its Claude child, so the
// queue item is provably left pending (never silently delivered) if
// completion was not durably accepted before the signal arrived. Both
// handlers await this before closing the store and exiting — a plain
// synchronous exit here would race the in-flight turn's own fail-closed
// persistence path.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`received ${signal}, stopping scheduling and bounded-waiting for any in-flight turn`);
  try {
    await worker.shutdown();
  } catch (err) {
    log(`shutdown wait failed: ${err?.message ?? err}`);
  } finally {
    store.close();
    process.exit(0);
  }
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch(() => process.exit(1));
});
process.on('SIGINT', () => {
  shutdown('SIGINT').catch(() => process.exit(1));
});
