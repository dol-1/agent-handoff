// DEMO-62 one-shot-worker revision. Session identity for the dedicated
// worker session — same lessons as the removed bin/agent-handoff-runner.sh:
// never write a "session created" marker before creation is actually
// proven, and never generate a new id on every restart (that would break
// `--resume` continuity and the completion contract's session_id match
// gate). getOrCreateSessionId() persists a STABLE id the first time it's
// needed; sessionTranscriptExists() independently, freshly checks proof of
// actual creation (Claude Code's own session transcript file) before every
// single turn, so create-vs-resume is derived from live evidence, not from
// whether we intended to create it.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const SESSION_ID_FILE_NAME = 'worker-session-id';
// DEMO-65 v1C: the Opus review leg must run as "a separate reviewer session
// identity from the executor session" — a second stable id, persisted in
// its own file, created/resumed with the exact same never-mark-before-proven
// discipline as the executor's.
export const REVIEWER_SESSION_ID_FILE_NAME = 'reviewer-session-id';

export function getOrCreateSessionId(runtimeDataDir, idFileName = SESSION_ID_FILE_NAME) {
  const idFile = join(runtimeDataDir, idFileName);
  if (existsSync(idFile)) {
    const existing = readFileSync(idFile, 'utf8').trim();
    if (existing) return existing;
  }
  mkdirSync(runtimeDataDir, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  writeFileSync(idFile, `${id}\n`);
  return id;
}

export function sessionTranscriptExists({ projectRoot, sessionId, homeDir = process.env.HOME }) {
  const encoded = projectRoot.replace(/\//g, '-');
  const path = join(homeDir, '.claude', 'projects', encoded, `${sessionId}.jsonl`);
  return existsSync(path);
}
