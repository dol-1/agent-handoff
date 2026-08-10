#!/usr/bin/env bash
# Portable singleton launcher for the Agent Handoff worker.
set -euo pipefail

SERVICE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_ROOT="${AGENT_HANDOFF_WORKSPACE_DIR:-$SERVICE_ROOT}"
RUNTIME_DIR="${AGENT_HANDOFF_RUNTIME_DIR:-$SERVICE_ROOT/.runtime}"
LOCK_FILE="$RUNTIME_DIR/worker.lock"
NODE_BIN="${AGENT_HANDOFF_NODE_BIN:-$(command -v node || true)}"

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "[agent-handoff-worker] Node executable not found; set AGENT_HANDOFF_NODE_BIN" >&2
  exit 1
fi
if [[ ! -d "$PROJECT_ROOT" ]]; then
  echo "[agent-handoff-worker] workspace does not exist: $PROJECT_ROOT" >&2
  exit 1
fi

mkdir -p "$RUNTIME_DIR"
chmod 700 "$RUNTIME_DIR"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[agent-handoff-worker] another worker instance already holds $LOCK_FILE; exiting" >&2
  exit 1
fi
echo $$ >&9
cd "$PROJECT_ROOT"

if [[ "${AGENT_HANDOFF_DRY_RUN:-0}" == "1" ]]; then
  printf '{"nodeBin":"%s","projectRoot":"%s","cwd":"%s","workerEntry":"%s"}\n' \
    "$NODE_BIN" "$PROJECT_ROOT" "$(pwd)" "$SERVICE_ROOT/src/workerEntry.js"
  exit 0
fi

echo "[agent-handoff-worker] launching worker (cwd $(pwd))" >&2
exec "$NODE_BIN" "$SERVICE_ROOT/src/workerEntry.js"
