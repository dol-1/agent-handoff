import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/agent-handoff-worker.sh');
const SERVICE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function env() { return { ...process.env, AGENT_HANDOFF_DRY_RUN: '1', AGENT_HANDOFF_RUNTIME_DIR: join(mkdtempSync(join(tmpdir(), 'handoff-')), 'runtime') }; }
function dry(extra = {}) { const result = spawnSync('bash', [SCRIPT], { env: { ...env(), ...extra }, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); }

test('launcher discovers Node from PATH and defaults workspace to service root', () => {
  const plan = dry();
  assert.ok(plan.nodeBin.endsWith("/node"));
  assert.equal(plan.projectRoot, SERVICE_ROOT);
  assert.equal(plan.cwd, SERVICE_ROOT);
});
test('launcher respects explicit Node and workspace paths', () => {
  const plan = dry({ AGENT_HANDOFF_NODE_BIN: process.execPath, AGENT_HANDOFF_WORKSPACE_DIR: tmpdir() });
  assert.equal(plan.nodeBin, process.execPath);
  assert.equal(plan.projectRoot, tmpdir());
});
test('launcher points at the extracted worker entrypoint', () => { assert.equal(dry().workerEntry, resolve(SERVICE_ROOT, 'src/workerEntry.js')); });
test('singleton lock rejects a concurrent launch', async () => {
  const testEnv = env(); mkdirSync(testEnv.AGENT_HANDOFF_RUNTIME_DIR, { recursive: true });
  const lock = join(testEnv.AGENT_HANDOFF_RUNTIME_DIR, 'worker.lock');
  const bg = spawn('bash', ['-c', 'exec 9>"$1"; flock -n 9 || exit 1; sleep 0.4', '--', lock]);
  await new Promise((r) => setTimeout(r, 50));
  const second = spawnSync('bash', [SCRIPT], { env: testEnv, encoding: 'utf8' });
  await new Promise((r) => bg.on('exit', r));
  assert.notEqual(second.status, 0); assert.match(second.stderr, /already holds/);
});
