import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ingress = readFileSync(resolve(ROOT, 'systemd/agent-handoff-ingress.service.in'), 'utf8');
const worker = readFileSync(resolve(ROOT, 'systemd/agent-handoff-worker.service.in'), 'utf8');
const envFiles = (text) => [...text.matchAll(/^EnvironmentFile=(.+)$/gm)].map((match) => match[1]);

test('service templates contain machine-rendered placeholders, not owner paths', () => {
  for (const text of [ingress, worker]) {
    assert.match(text, /User=@USER@/);
    assert.match(text, /@ROOT@/);
    assert.doesNotMatch(text, /\/home\//);
  }
});
test('both templates share the routing file and only ingress loads the secret file', () => {
  assert.ok(envFiles(ingress).includes('@ROOT@/.env.routing'));
  assert.ok(envFiles(worker).includes('@ROOT@/.env.routing'));
  assert.ok(envFiles(ingress).includes('@ROOT@/.env'));
  assert.ok(!envFiles(worker).includes('@ROOT@/.env'));
});
test('worker directives never expose the webhook secret', () => {
  const directives = worker.split('\n').filter((line) => /^(EnvironmentFile|Environment)=/.test(line));
  directives.forEach((line) => assert.doesNotMatch(line, /LINEAR_WEBHOOK_SECRET/));
});
