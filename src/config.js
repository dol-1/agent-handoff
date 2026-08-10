// Central configuration. Deployment-specific routing is always explicit; the
// standalone package has no owner or project identifiers baked into source.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVICE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig(env = process.env) {
  const secret = env.LINEAR_WEBHOOK_SECRET || '';

  return {
    // Not configurable: AC-2 requires this receiver to stay localhost-only
    // for the entire v1A prototype, so the bind address is not an env knob.
    host: '127.0.0.1',
    port: Number(env.AGENT_HANDOFF_PORT || 8788),
    webhookSecret: secret,
    timestampWindowMs: Number(env.AGENT_HANDOFF_TIMESTAMP_WINDOW_MS || 60_000),
    dedupTtlMs: Number(env.AGENT_HANDOFF_DEDUP_TTL_MS || 10 * 60_000),
    dedupMaxEntries: Number(env.AGENT_HANDOFF_DEDUP_MAX_ENTRIES || 5_000),
    allowedTeamId: env.AGENT_HANDOFF_ALLOWED_TEAM_ID || '',
    allowedProjectId: env.AGENT_HANDOFF_ALLOWED_PROJECT_ID || '',
    allowedTargetStateName: env.AGENT_HANDOFF_ALLOWED_TARGET_STATE || 'Todo',

    // --- v1B additions below (unused by v1A server.js) ---

    // Gitignored runtime-data path, outside tracked source, per DEMO-62 section E.
    runtimeDataDir: env.AGENT_HANDOFF_RUNTIME_DIR || join(SERVICE_ROOT, '.runtime'),
    dbFileName: env.AGENT_HANDOFF_DB_FILE || 'queue.db',
    // Minimum supported Node version (exactly 22.5.0, for node:sqlite) is a
    // fact about the runtime, not a deployment knob — see
    // nodeVersionGuard.js's MIN_NODE_VERSION, which both v1B entrypoints
    // enforce before importing anything that touches node:sqlite.
    // How often the worker polls the durable store for newly eligible
    // (pending, past backoff) events.
    pollIntervalMs: Number(env.AGENT_HANDOFF_POLL_INTERVAL_MS || 2_000),

    // --- one-shot worker additions (DEMO-62 revision) ---

    projectRoot: env.AGENT_HANDOFF_WORKSPACE_DIR || SERVICE_ROOT,
    claudeBin: env.AGENT_HANDOFF_CLAUDE_BIN || 'claude',
    // Wall-clock budget for a single one-shot execution turn before
    // claudeInvoker.js SIGTERMs (then SIGKILLs) it and the worker treats
    // the attempt as a timeout — fails closed, retried with backoff.
    workerTurnTimeoutMs: Number(env.AGENT_HANDOFF_WORKER_TURN_TIMEOUT_MS || 15 * 60_000),
    // Shorter budget for the read-only reconciliation turn.
    reconcileTurnTimeoutMs: Number(env.AGENT_HANDOFF_RECONCILE_TURN_TIMEOUT_MS || 3 * 60_000),
    // DEMO-65 v1C: wall-clock budget for a single Opus review turn. Separate
    // from workerTurnTimeoutMs so the two can be tuned independently — a
    // review turn also does GitHub/PR/diff/test/CI inspection, not just a
    // code-change task.
    reviewTurnTimeoutMs: Number(env.AGENT_HANDOFF_REVIEW_TURN_TIMEOUT_MS || 15 * 60_000),
    // DEMO-65 v1C: maximum automatic execute<->review revision cycles before
    // a review outcome must become needs_human instead of revision_required
    // — see claudeInvoker.js's evaluateReviewResult() and worker.js's
    // processReviewEventInner(). Not part of the required-explicit v1B
    // routing set (team/project/state) — this is a loop-bound tuning knob,
    // not a scope-safety fact, so a sensible default is fine.
    maxRevisionCycles: Number(env.AGENT_HANDOFF_MAX_REVISION_CYCLES || 3),
    // How often the worker runs a periodic reconciliation pass, in addition
    // to the mandatory one at startup.
    reconcileIntervalMs: Number(env.AGENT_HANDOFF_RECONCILE_INTERVAL_MS || 10 * 60_000),
    // Exponential backoff (base * 2^attemptCount, capped) applied after a
    // non-terminal (blocked/failed/malformed/timeout/etc) attempt, so a
    // stuck item is retried with increasing patience rather than hot-looped
    // and burning Claude usage.
    workerBaseBackoffMs: Number(env.AGENT_HANDOFF_WORKER_BASE_BACKOFF_MS || 60_000),
    workerMaxBackoffMs: Number(env.AGENT_HANDOFF_WORKER_MAX_BACKOFF_MS || 60 * 60_000),
    // After this many failed attempts, an item moves to 'needs_review'
    // instead of continuing to retry — kept, never silently discarded, but
    // surfaced for human/reviewer attention rather than burning further
    // Claude usage indefinitely.
    workerMaxAttempts: Number(env.AGENT_HANDOFF_WORKER_MAX_ATTEMPTS || 5),
    // DEMO-62 revision, finding 5: on SIGTERM/SIGINT, worker.shutdown() gives
    // any in-flight turn this long to finish on its own before aborting its
    // Claude child (SIGTERM, then SIGKILL after claudeInvoker.js's own
    // escalation grace period) — a bounded, explicit shutdown rather than
    // "clear timers and hope".
    workerShutdownGraceMs: Number(env.AGENT_HANDOFF_WORKER_SHUTDOWN_GRACE_MS || 10_000),
  };
}

const REQUIRED_V1B_ROUTING_ENV_VARS = [
  'AGENT_HANDOFF_ALLOWED_TEAM_ID',
  'AGENT_HANDOFF_ALLOWED_PROJECT_ID',
  'AGENT_HANDOFF_ALLOWED_TARGET_STATE',
];

// Pure predicate — which of the three required v1B routing env vars are
// absent/blank in the given env. Empty array means routing was explicitly
// configured (regardless of what the values actually are).
export function missingV1BRoutingEnvVars(env = process.env) {
  return REQUIRED_V1B_ROUTING_ENV_VARS.filter((key) => !env[key] || !String(env[key]).trim());
}

// Fail-closed startup guard for v1B entrypoints only. Must run before any
// v1B process starts accepting/processing work — mirrors
// nodeVersionGuard.js's assertSupportedNode() shape (pure predicate +
// logging exit wrapper) for the same reason: a clear, deliberate refusal to
// start beats silently inheriting loadConfig()'s v1A-oriented default scope.
export function assertExplicitV1BRouting(env = process.env, log = (msg) => process.stderr.write(`${msg}\n`)) {
  const missing = missingV1BRoutingEnvVars(env);
  if (missing.length === 0) return;
  log(
    `[agent-handoff] fatal: v1B requires explicit routing config (missing: ${missing.join(', ')}) — ` +
      'refusing to start without an explicit scope. Copy .env.routing.example to .env.routing, ' +
      'replace every placeholder, and load it before starting ingress or worker.',
  );
  process.exit(1);
}
