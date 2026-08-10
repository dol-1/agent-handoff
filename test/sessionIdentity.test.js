import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getOrCreateSessionId, sessionTranscriptExists, REVIEWER_SESSION_ID_FILE_NAME } from '../src/sessionIdentity.js';

function scratchDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('getOrCreateSessionId creates a stable id the first time, reuses it after', () => {
  const runtimeDir = join(scratchDir('agent-handoff-sid-'), 'runtime');
  const first = getOrCreateSessionId(runtimeDir);
  const second = getOrCreateSessionId(runtimeDir);
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f-]{36}$/);
});

test('getOrCreateSessionId across two independent calls against the same dir (simulated restart) is stable', () => {
  const runtimeDir = join(scratchDir('agent-handoff-sid-'), 'runtime');
  const beforeRestart = getOrCreateSessionId(runtimeDir);
  // Simulate a worker process restart: nothing in-memory carries over,
  // only the runtime dir on disk.
  const afterRestart = getOrCreateSessionId(runtimeDir);
  assert.equal(beforeRestart, afterRestart);
});

// DEMO-65 v1C, requirement: review jobs must run under "a separate reviewer
// session identity from the executor session".
test('7. getOrCreateSessionId(dir, REVIEWER_SESSION_ID_FILE_NAME) yields a stable id independent of and different from the default executor session id', () => {
  const runtimeDir = join(scratchDir('agent-handoff-sid-'), 'runtime');
  const executorId = getOrCreateSessionId(runtimeDir);
  const reviewerId = getOrCreateSessionId(runtimeDir, REVIEWER_SESSION_ID_FILE_NAME);
  assert.notEqual(executorId, reviewerId, 'reviewer and executor must be distinct sessions');
  assert.match(reviewerId, /^[0-9a-f-]{36}$/);

  // Both must independently survive a simulated restart (fresh calls
  // against the same runtime dir).
  assert.equal(getOrCreateSessionId(runtimeDir), executorId);
  assert.equal(getOrCreateSessionId(runtimeDir, REVIEWER_SESSION_ID_FILE_NAME), reviewerId);
});

test('2. sessionTranscriptExists is false before creation, true once Claude Code writes a transcript', () => {
  const homeDir = scratchDir('agent-handoff-home-');
  const projectRoot = '/srv/example-workspace';
  const sessionId = '11111111-1111-1111-1111-111111111111';

  assert.equal(sessionTranscriptExists({ projectRoot, sessionId, homeDir }), false);

  const encoded = projectRoot.replace(/\//g, '-');
  const dir = join(homeDir, '.claude', 'projects', encoded);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), '{}\n');

  assert.equal(sessionTranscriptExists({ projectRoot, sessionId, homeDir }), true);
});

test('sessionTranscriptExists is keyed to the exact project root, not a substring/prefix match', () => {
  const homeDir = scratchDir('agent-handoff-home-');
  const sessionId = '22222222-2222-2222-2222-222222222222';
  const encoded = '/srv/example-workspace/services/agent-handoff'.replace(/\//g, '-');
  const dir = join(homeDir, '.claude', 'projects', encoded);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), '{}\n');

  // A transcript exists for the SERVICE subdirectory's encoded path, but
  // not for the exact required project root — must not be found.
  assert.equal(
    sessionTranscriptExists({ projectRoot: '/srv/example-workspace', sessionId, homeDir }),
    false,
  );
});
