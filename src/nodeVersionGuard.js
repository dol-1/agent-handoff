// Fails fast and clearly (DEMO-62 Opus review item A / revision item 8) if a
// v1B process is started under a Node binary too old to have built-in
// `node:sqlite`. That module (`DatabaseSync`) landed in Node **22.5.0**
// specifically — not merely "major version 22" (22.0.0–22.4.x lack it) — so
// the check below compares the full version tuple, not just the major.
//
// Callers (ingressServer.js, channelRunnerEntry.js) MUST call
// assertSupportedNode() and let it exit the process BEFORE statically or
// dynamically importing durableStore.js. durableStore.js itself has a
// top-level `import { DatabaseSync } from 'node:sqlite'`, which Node
// evaluates eagerly — importing it before this guard has run would crash
// with a raw ERR_UNKNOWN_BUILTIN_MODULE stack instead of this module's
// clear message.

export const MIN_NODE_VERSION = [22, 5, 0];

function currentVersionTuple() {
  return process.versions.node.split('.').map(Number);
}

function versionAtLeast(current, minimum) {
  for (let i = 0; i < minimum.length; i += 1) {
    if (current[i] > minimum[i]) return true;
    if (current[i] < minimum[i]) return false;
  }
  return true; // equal
}

// Pure predicate, safe to import from any Node version (this module itself
// never imports node:sqlite) — used by both the runtime guard below and
// tests that need to skip node:sqlite-dependent suites under an older Node.
export function isNodeSqliteSupported(current = currentVersionTuple()) {
  return versionAtLeast(current, MIN_NODE_VERSION);
}

export function assertSupportedNode(log = (msg) => process.stderr.write(`${msg}\n`)) {
  if (isNodeSqliteSupported()) return;
  const required = MIN_NODE_VERSION.join('.');
  log(
    `[agent-handoff] fatal: this v1B process requires Node >=${required} for ` +
      `built-in node:sqlite, but is running under Node ${process.versions.node} ` +
      `(). Install a supported Node release and rerun ./install.sh.`,
  );
  process.exit(1);
}
