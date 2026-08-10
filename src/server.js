import { loadConfig } from './config.js';
import { DedupStore } from './dedupStore.js';
import { startMcpChannelServer } from './mcpChannel.js';
import { createHttpReceiver } from './httpReceiver.js';

// Entry point Claude Code spawns as the MCP server (stdio). It also opens
// the localhost HTTP receiver in the same process so an accepted webhook
// can be pushed straight into the stdio channel without an extra hop.
// Never write anything but MCP JSON-RPC to stdout — logs go to stderr.

function log(message) {
  process.stderr.write(`[agent-handoff] ${message}\n`);
}

const config = loadConfig();

if (!config.webhookSecret) {
  log('LINEAR_WEBHOOK_SECRET is not set; every webhook will be rejected until it is.');
}

const dedupStore = new DedupStore({
  ttlMs: config.dedupTtlMs,
  maxEntries: config.dedupMaxEntries,
});

const channel = startMcpChannelServer({ log });

const httpServer = createHttpReceiver({
  config,
  dedupStore,
  onAccepted: (normalizedEvent) => {
    channel.sendChannelEvent(normalizedEvent).catch((err) => {
      log(`failed to deliver channel event: ${err?.message ?? err}`);
    });
  },
  log,
});

httpServer.listen(config.port, config.host, () => {
  log(`listening on http://${config.host}:${config.port} (healthz + POST /hooks/linear)`);
});

httpServer.on('error', (err) => {
  log(`HTTP receiver error: ${err.message}`);
});
