import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { loadConfig, missingV1BRoutingEnvVars, assertExplicitV1BRouting } from '../src/config.js';

const ROUTING_EXAMPLE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../.env.routing.example');
const EXPLICIT = {
  AGENT_HANDOFF_ALLOWED_TEAM_ID: 'team-x',
  AGENT_HANDOFF_ALLOWED_PROJECT_ID: 'project-x',
  AGENT_HANDOFF_ALLOWED_TARGET_STATE: 'Todo',
};

test('standalone config has no private routing or Claude path defaults', () => {
  const config = loadConfig({});
  assert.equal(config.allowedTeamId, '');
  assert.equal(config.allowedProjectId, '');
  assert.equal(config.allowedTargetStateName, 'Todo');
  assert.equal(config.reviewMode, 'opus');
  assert.equal(config.claudeBin, 'claude');
  assert.ok(config.projectRoot.endsWith('agent-handoff'));
});

test('workspace and executable paths are configurable', () => {
  const config = loadConfig({ AGENT_HANDOFF_WORKSPACE_DIR: '/work/repo', AGENT_HANDOFF_CLAUDE_BIN: '/opt/bin/claude' });
  assert.equal(config.projectRoot, '/work/repo');
  assert.equal(config.claudeBin, '/opt/bin/claude');
});

test('routing guard reports missing and blank keys', () => {
  assert.deepEqual(missingV1BRoutingEnvVars({}).sort(), [
    'AGENT_HANDOFF_ALLOWED_PROJECT_ID',
    'AGENT_HANDOFF_ALLOWED_TARGET_STATE',
    'AGENT_HANDOFF_ALLOWED_TEAM_ID',
  ]);
  assert.deepEqual(missingV1BRoutingEnvVars(EXPLICIT), []);
  assert.deepEqual(missingV1BRoutingEnvVars({ ...EXPLICIT, AGENT_HANDOFF_ALLOWED_PROJECT_ID: '  ' }), ['AGENT_HANDOFF_ALLOWED_PROJECT_ID']);
});

test('routing guard fails closed with a clear message', () => {
  let message = '';
  const originalExit = process.exit;
  process.exit = (code) => { throw new Error(`exit-${code}`); };
  try {
    assert.throws(() => assertExplicitV1BRouting({}, (value) => { message = value; }), /exit-1/);
  } finally {
    process.exit = originalExit;
  }
  assert.match(message, /requires explicit routing config/);
});

test('sanitized routing template contains placeholders, not real identifiers', () => {
  const contents = readFileSync(ROUTING_EXAMPLE_PATH, 'utf8');
  assert.match(contents, /REPLACE_WITH_LINEAR_TEAM_ID/);
  assert.match(contents, /REPLACE_WITH_LINEAR_PROJECT_ID/);
  assert.match(contents, /AGENT_HANDOFF_RUNTIME_DIR=@ROOT@\/\.runtime/);
  assert.doesNotMatch(contents, /[0-9a-f]{8}-[0-9a-f-]{27,}/i);
});


test('external review mode is configurable and invalid modes fail closed', () => {
  const external = loadConfig({ ...EXPLICIT, AGENT_HANDOFF_REVIEW_MODE: 'external' });
  assert.equal(external.reviewMode, 'external');

  let message = '';
  const originalExit = process.exit;
  process.exit = (code) => { throw new Error(`exit-${code}`); };
  try {
    assert.throws(
      () => assertExplicitV1BRouting({ ...EXPLICIT, AGENT_HANDOFF_REVIEW_MODE: 'unexpected' }, (value) => { message = value; }),
      /exit-1/,
    );
  } finally {
    process.exit = originalExit;
  }
  assert.match(message, /invalid AGENT_HANDOFF_REVIEW_MODE/);
});
