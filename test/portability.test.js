import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('installer dry run is non-mutating and resolves portable dependencies', () => {
  const result = spawnSync('bash', [resolve(ROOT, 'install.sh'), '--dry-run', '--workspace', ROOT], { encoding: 'utf8', env: { ...process.env, AGENT_HANDOFF_NODE_BIN: process.execPath, AGENT_HANDOFF_CLAUDE_BIN: '/bin/true' } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /would prepare/);
  assert.match(result.stdout, /would render service units/);
});

test('staged no-start install renders units and preserves secret isolation', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'agent-handoff-install-'));
  const copy = join(scratch, 'agent-handoff');
  cpSync(ROOT, copy, { recursive: true, filter: (source) => !source.includes('node_modules') && !source.includes('/.runtime') });
  const unitDir = join(scratch, 'units');
  const result = spawnSync('bash', [join(copy, 'install.sh'), '--unit-dir', unitDir, '--workspace', copy, '--no-start'], { encoding: 'utf8', env: { ...process.env, AGENT_HANDOFF_NODE_BIN: process.execPath, AGENT_HANDOFF_CLAUDE_BIN: '/bin/true' } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(statSync(join(copy, '.env')).mode & 0o777, 0o600);
  assert.equal(statSync(join(copy, '.env.routing')).mode & 0o777, 0o600);
  const ingress = readFileSync(join(unitDir, 'agent-handoff-ingress.service'), 'utf8');
  const worker = readFileSync(join(unitDir, 'agent-handoff-worker.service'), 'utf8');
  assert.doesNotMatch(ingress + worker, /@[A-Z_]+@/);
  assert.match(ingress, /EnvironmentFile=.*\/\.env$/m);
  assert.doesNotMatch(worker, /EnvironmentFile=.*\/\.env$/m);
});

test('uninstall preserves durable data unless purge is explicit', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'agent-handoff-uninstall-'));
  const copy = join(scratch, 'agent-handoff');
  cpSync(ROOT, copy, { recursive: true, filter: (source) => !source.includes('node_modules') });
  const unitDir = join(scratch, 'units');
  let result = spawnSync('bash', [join(copy, 'install.sh'), '--unit-dir', unitDir, '--workspace', copy, '--no-start'], { encoding: 'utf8', env: { ...process.env, AGENT_HANDOFF_NODE_BIN: process.execPath, AGENT_HANDOFF_CLAUDE_BIN: '/bin/true' } });
  assert.equal(result.status, 0, result.stderr);
  result = spawnSync('bash', [join(copy, 'install.sh'), 'uninstall', '--unit-dir', unitDir, '--no-start'], { encoding: 'utf8', env: { ...process.env, AGENT_HANDOFF_NODE_BIN: process.execPath, AGENT_HANDOFF_CLAUDE_BIN: '/bin/true' } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /durable data preserved/);
  assert.ok(statSync(join(copy, '.runtime')).isDirectory());
});
