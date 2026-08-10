#!/usr/bin/env node
// Deterministic stand-in for the real `claude` CLI, used only by
// test/worker.test.js (DEMO-62 one-shot-worker revision). Never invoked in
// production — src/claudeInvoker.js always spawns the real binary path
// from config. This exists because the review explicitly requires worker
// unit tests not depend on live Claude calls.
//
// Understands enough of the real CLI's argv shape to be a faithful stand-in
// for claudeInvoker.js's spawnClaudeTurn(): `--session-id <id>` or
// `--resume <id>`, `-p <prompt>`, `--output-format json`,
// `--json-schema <schema>`. Behavior is controlled entirely by env vars so
// each test can deterministically choose a scenario:
//
//   FAKE_CLAUDE_MODE=success|not_eligible|blocked|failed|malformed|
//                    missing_structured|nonzero|hang|session_mismatch|
//                    crash|issue_mismatch|delayed
//   FAKE_CLAUDE_DELAY_MS     for MODE=delayed, how long to wait (a real
//                            timer) before completing successfully — used
//                            to deterministically create an overlap window
//                            for concurrency tests
//   FAKE_CLAUDE_STRUCTURED   JSON string merged onto the completion-shaped
//                            default's fields (e.g. to fix issueIdentifier)
//   FAKE_CLAUDE_RAW_STRUCTURED=1   use FAKE_CLAUDE_STRUCTURED verbatim
//                            instead of merging — required for
//                            reconciliation-turn tests, whose
//                            structured_output has a different shape
//   FAKE_CLAUDE_HOME         HOME to write a fake session transcript under,
//                            mirroring the real CLI's
//                            ~/.claude/projects/<encoded-cwd>/<id>.jsonl so
//                            create-vs-resume derivation is testable
//                            end-to-end without touching this host's real
//                            ~/.claude
//   FAKE_CLAUDE_IGNORE_SIGTERM=1   for MODE=hang, ignore SIGTERM so the
//                                  caller's SIGKILL escalation is exercised

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

function findFlagValue(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

const args = process.argv.slice(2);
const sessionId = findFlagValue(args, '--session-id') ?? findFlagValue(args, '--resume');
const isCreate = args.includes('--session-id');
const mode = process.env.FAKE_CLAUDE_MODE || 'success';

// Test-only diagnostic: when set, append this invocation's argv (as one
// JSON-array line) so a test can inspect exactly what flags a real caller
// (e.g. src/worker.js) built across multiple invocations — used to verify
// create-vs-resume selection end to end, not just in isolation.
if (process.env.FAKE_CLAUDE_ARGS_LOG) {
  writeFileSync(process.env.FAKE_CLAUDE_ARGS_LOG, `${JSON.stringify(args)}\n`, { flag: 'a' });
}

function writeFakeTranscript() {
  const home = process.env.FAKE_CLAUDE_HOME;
  if (!home || !sessionId) return;
  const encoded = process.cwd().replace(/\//g, '-');
  const dir = join(home, '.claude', 'projects', encoded);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), `{"type":"fake","isCreate":${isCreate}}\n`, { flag: 'a' });
}

function envelope({ resultObj, sessionIdOverride }) {
  return {
    is_error: false,
    session_id: sessionIdOverride ?? sessionId,
    subtype: 'success',
    permission_denials: [],
    result: JSON.stringify(resultObj),
    structured_output: resultObj,
    type: 'result',
  };
}

function defaultStructured(outcome) {
  const base = JSON.parse(process.env.FAKE_CLAUDE_STRUCTURED || '{}');
  return {
    protocolVersion: 1,
    issueIdentifier: 'DEMO-FAKE',
    outcome,
    canonicalStatus: outcome === 'completed' ? 'In Review' : 'Todo',
    resultPosted: outcome === 'completed',
    commitSha: outcome === 'completed' ? 'deadbeef' : null,
    // DEMO-62 revision, finding 2: default to the same team-1/project-1/Todo
    // scope test/worker.test.js's BASE_CONFIG uses, so existing tests that
    // don't care about finding 2 specifically keep passing without having
    // to override these on every call.
    verifiedTeamId: outcome === 'completed' ? 'team-1' : null,
    verifiedProjectId: outcome === 'completed' ? 'project-1' : null,
    verifiedPickupState: outcome === 'completed' ? 'Todo' : null,
    summary: `fake ${outcome}`,
    ...base,
  };
}

// FAKE_CLAUDE_RAW_STRUCTURED=1 uses FAKE_CLAUDE_STRUCTURED verbatim
// instead of merging it into the completion-shaped defaults above — needed
// for reconciliation-turn tests, whose structured_output has a completely
// different shape (teamId/projectId/targetState/eligibleIssues) that a
// completion-shaped merge would corrupt.
function resolveStructured(outcome) {
  if (process.env.FAKE_CLAUDE_RAW_STRUCTURED === '1') {
    return JSON.parse(process.env.FAKE_CLAUDE_STRUCTURED || '{}');
  }
  return defaultStructured(outcome);
}

switch (mode) {
  case 'success':
  case 'completed': {
    writeFakeTranscript();
    process.stdout.write(JSON.stringify(envelope({ resultObj: resolveStructured('completed') })));
    process.exit(0);
    break;
  }
  case 'not_eligible': {
    writeFakeTranscript();
    process.stdout.write(JSON.stringify(envelope({ resultObj: resolveStructured('not_eligible') })));
    process.exit(0);
    break;
  }
  case 'blocked': {
    writeFakeTranscript();
    process.stdout.write(JSON.stringify(envelope({ resultObj: resolveStructured('blocked') })));
    process.exit(0);
    break;
  }
  case 'failed': {
    writeFakeTranscript();
    process.stdout.write(JSON.stringify(envelope({ resultObj: resolveStructured('failed') })));
    process.exit(0);
    break;
  }
  case 'malformed': {
    writeFakeTranscript();
    process.stdout.write('{not valid json');
    process.exit(0);
    break;
  }
  case 'missing_structured': {
    writeFakeTranscript();
    const e = envelope({ resultObj: resolveStructured('completed') });
    delete e.structured_output;
    process.stdout.write(JSON.stringify(e));
    process.exit(0);
    break;
  }
  case 'issue_mismatch': {
    writeFakeTranscript();
    const structured = resolveStructured('completed');
    structured.issueIdentifier = 'DEMO-WRONG';
    process.stdout.write(JSON.stringify(envelope({ resultObj: structured })));
    process.exit(0);
    break;
  }
  case 'session_mismatch': {
    writeFakeTranscript();
    process.stdout.write(
      JSON.stringify(envelope({ resultObj: resolveStructured('completed'), sessionIdOverride: 'not-the-right-session-id' })),
    );
    process.exit(0);
    break;
  }
  case 'delayed': {
    const delayMs = Number(process.env.FAKE_CLAUDE_DELAY_MS || 500);
    setTimeout(() => {
      writeFakeTranscript();
      process.stdout.write(JSON.stringify(envelope({ resultObj: resolveStructured('completed') })));
      process.exit(0);
    }, delayMs);
    break;
  }
  case 'nonzero': {
    process.stderr.write('fake claude: simulated internal error\n');
    process.exit(1);
    break;
  }
  case 'crash': {
    process.kill(process.pid, 'SIGKILL');
    break;
  }
  case 'hang': {
    if (process.env.FAKE_CLAUDE_IGNORE_SIGTERM === '1') {
      process.on('SIGTERM', () => {});
    }
    setInterval(() => {}, 1000);
    break;
  }
  default: {
    process.stderr.write(`fake claude: unknown FAKE_CLAUDE_MODE ${mode}\n`);
    process.exit(1);
  }
}
