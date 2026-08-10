#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACTION=install
DRY_RUN=0
NO_START=0
PURGE_DATA=0
UNIT_DIR=/etc/systemd/system
WORKSPACE="$ROOT"
while (($#)); do
  case "$1" in
    install|uninstall|doctor) ACTION="$1" ;;
    --dry-run) DRY_RUN=1 ;;
    --no-start) NO_START=1 ;;
    --purge-data) PURGE_DATA=1 ;;
    --unit-dir) shift; UNIT_DIR="${1:?missing --unit-dir value}" ;;
    --workspace) shift; WORKSPACE="${1:?missing --workspace value}" ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[[ "$ACTION" == doctor ]] && exec "$ROOT/bin/agent-handoff-doctor.sh"
run_root() { if [[ "$DRY_RUN" == 1 ]]; then printf 'would run:'; printf ' %q' "$@"; printf '\n'; elif [[ $EUID == 0 || "$UNIT_DIR" != /etc/systemd/system ]]; then "$@"; else sudo "$@"; fi; }
if [[ "$ACTION" == uninstall ]]; then
  if [[ "$NO_START" == 0 ]] && command -v systemctl >/dev/null; then run_root systemctl disable --now agent-handoff-worker.service agent-handoff-ingress.service; fi
  run_root rm -f "$UNIT_DIR/agent-handoff-worker.service" "$UNIT_DIR/agent-handoff-ingress.service"
  if [[ "$NO_START" == 0 ]] && command -v systemctl >/dev/null; then run_root systemctl daemon-reload; fi
  if [[ "$PURGE_DATA" == 1 ]]; then rm -rf -- "$ROOT/.runtime"; else echo "durable data preserved at $ROOT/.runtime"; fi
  exit 0
fi
USER_NAME="${SUDO_USER:-${USER:-$(id -un)}}"
NODE_BIN="${AGENT_HANDOFF_NODE_BIN:-$(command -v node || true)}"
CLAUDE_BIN="${AGENT_HANDOFF_CLAUDE_BIN:-$(command -v claude || true)}"
for command_name in install sed flock; do command -v "$command_name" >/dev/null || { echo "$command_name is required" >&2; exit 1; }; done
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || { echo "Node is required" >&2; exit 1; }
"$NODE_BIN" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22 || (a===22 && b>=5) ? 0 : 1)' || { echo "Node >=22.5 is required" >&2; exit 1; }
[[ -n "$CLAUDE_BIN" && -x "$CLAUDE_BIN" ]] || { echo "Claude Code CLI is required" >&2; exit 1; }
[[ -d "$WORKSPACE" ]] || { echo "workspace does not exist: $WORKSPACE" >&2; exit 1; }
if [[ "$DRY_RUN" == 1 ]]; then
  echo "would prepare $ROOT/.env, $ROOT/.env.routing, and $ROOT/.runtime"
else
  [[ -e "$ROOT/.env" ]] || install -m 0600 "$ROOT/.env.example" "$ROOT/.env"
  if [[ ! -e "$ROOT/.env.routing" ]]; then
    sed -e "s|@ROOT@|$ROOT|g" -e "s|@WORKSPACE@|$WORKSPACE|g" "$ROOT/.env.routing.example" > "$ROOT/.env.routing"
    chmod 0600 "$ROOT/.env.routing"
  fi
  install -d -m 0700 "$ROOT/.runtime"
fi
escape() { printf '%s' "$1" | sed 's/[&|]/\\&/g'; }
render_unit() {
  local source="$1" target="$2"
  sed -e "s|@USER@|$(escape "$USER_NAME")|g" \
      -e "s|@ROOT@|$(escape "$ROOT")|g" \
      -e "s|@WORKSPACE@|$(escape "$WORKSPACE")|g" \
      -e "s|@NODE_BIN@|$(escape "$NODE_BIN")|g" \
      -e "s|@CLAUDE_BIN@|$(escape "$CLAUDE_BIN")|g" "$source" > "$target"
}
if [[ "$DRY_RUN" == 1 ]]; then echo "would render service units into $UNIT_DIR"; exit 0; fi
tmp_dir="$(mktemp -d)"; trap 'rm -rf -- "$tmp_dir"' EXIT
render_unit "$ROOT/systemd/agent-handoff-ingress.service.in" "$tmp_dir/agent-handoff-ingress.service"
render_unit "$ROOT/systemd/agent-handoff-worker.service.in" "$tmp_dir/agent-handoff-worker.service"
run_root install -d -m 0755 "$UNIT_DIR"
run_root install -m 0644 "$tmp_dir/agent-handoff-ingress.service" "$UNIT_DIR/agent-handoff-ingress.service"
run_root install -m 0644 "$tmp_dir/agent-handoff-worker.service" "$UNIT_DIR/agent-handoff-worker.service"
if [[ "$NO_START" == 0 ]] && command -v systemctl >/dev/null; then
  run_root systemctl daemon-reload
  run_root systemctl enable --now agent-handoff-ingress.service agent-handoff-worker.service
else
  echo "units installed but not started"
fi
