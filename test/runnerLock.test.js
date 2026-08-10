// Deterministic test of the exact singleton primitive
// bin/agent-handoff-worker.sh relies on (`flock -n`), per DEMO-62 reliability
// item 11 ("two attempted worker starts cannot produce two active pollers").
// This does not spawn Claude — it verifies the OS-level lock mechanism the
// launcher script depends on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function haveFlock() {
  const result = spawnSync('flock', ['--version']);
  return result.status === 0;
}

test('11. concurrent non-blocking flock attempts on the same lock file: exactly one succeeds', { skip: !haveFlock() && 'flock binary not available on this host' }, () => {
  const lockFile = join(mkdtempSync(join(tmpdir(), 'agent-handoff-lock-')), 'runner.lock');

  // Holder: acquires the lock and sleeps briefly, mirroring the launcher
  // script's `exec 9>"$LOCK_FILE"; flock -n 9 || exit 1` pattern, but as a
  // single flock invocation holding the lock for the duration of a child
  // command (`sleep`) so a concurrent second attempt overlaps it.
  const holder = spawnSync('flock', ['-n', lockFile, '--command', 'sleep 0.4'], {
    // Do not block this test process on the holder's completion.
    timeout: 0,
  });

  // Fire a second, competing non-blocking attempt while the first is
  // presumed to still be starting up. To make this deterministic rather
  // than racy, run both concurrently via background shell jobs and capture
  // both exit codes.
  const both = spawnSync(
    'bash',
    [
      '-c',
      `flock -n "$1" --command 'sleep 0.4' & p1=$!
       sleep 0.05
       flock -n "$1" --command 'true'; echo "second:$?"
       wait $p1; echo "first:$?"`,
      '--',
      lockFile,
    ],
    { encoding: 'utf8' },
  );

  const firstExit = /first:(\d+)/.exec(both.stdout)?.[1];
  const secondExit = /second:(\d+)/.exec(both.stdout)?.[1];

  assert.equal(firstExit, '0', 'the process that acquired the lock first must succeed');
  assert.notEqual(secondExit, '0', 'a concurrent competing attempt must fail fast (non-blocking -n)');
});

test('flock is released automatically once the holder exits, allowing a subsequent (non-concurrent) run', () => {
  const lockFile = join(mkdtempSync(join(tmpdir(), 'agent-handoff-lock-')), 'runner.lock');

  const first = spawnSync('flock', ['-n', lockFile, '--command', 'true']);
  assert.equal(first.status, 0);

  const second = spawnSync('flock', ['-n', lockFile, '--command', 'true']);
  assert.equal(second.status, 0, 'a later, non-overlapping run must be able to acquire the same lock file');
});
