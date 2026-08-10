#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
failures=0
ok() { printf 'ok: %s\n' "$1"; }
fail() { printf 'fail: %s\n' "$1" >&2; failures=$((failures + 1)); }
value_for() {
  local file="$1" key="$2"
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$file"
}

node_bin="${AGENT_HANDOFF_NODE_BIN:-$(command -v node || true)}"
if [[ -n "$node_bin" ]] && "$node_bin" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22 || (a===22 && b>=5) ? 0 : 1)'; then
  ok "Node >=22.5 available"
else
  fail "Node >=22.5 is required"
fi
claude_bin="${AGENT_HANDOFF_CLAUDE_BIN:-$(command -v claude || true)}"
[[ -n "$claude_bin" && -x "$claude_bin" ]] && ok "Claude Code CLI available" || fail "Claude Code CLI not found"
command -v flock >/dev/null && ok "flock available" || fail "flock not found"

routing="$ROOT/.env.routing"
secret="$ROOT/.env"
if [[ -f "$routing" ]]; then
  for key in AGENT_HANDOFF_ALLOWED_TEAM_ID AGENT_HANDOFF_ALLOWED_PROJECT_ID AGENT_HANDOFF_ALLOWED_TARGET_STATE AGENT_HANDOFF_RUNTIME_DIR AGENT_HANDOFF_WORKSPACE_DIR; do
    value="$(value_for "$routing" "$key")"
    if [[ -z "$value" || "$value" == REPLACE_WITH_* || "$value" == *'@ROOT@'* || "$value" == *'@WORKSPACE@'* ]]; then
      fail "$key is not configured"
    else
      ok "$key is configured"
    fi
  done
  runtime_dir="$(value_for "$routing" AGENT_HANDOFF_RUNTIME_DIR)"
  workspace_dir="$(value_for "$routing" AGENT_HANDOFF_WORKSPACE_DIR)"
  [[ -d "$runtime_dir" && -w "$runtime_dir" ]] && ok "runtime directory writable" || fail "runtime directory missing or not writable"
  [[ -d "$workspace_dir" ]] && ok "workspace directory exists" || fail "workspace directory missing"
else
  fail ".env.routing is missing"
fi
if [[ -f "$secret" ]]; then
  secret_value="$(value_for "$secret" LINEAR_WEBHOOK_SECRET)"
  [[ -n "$secret_value" && "$secret_value" != REPLACE_WITH_* ]] && ok "webhook secret configured" || fail "webhook secret is still a placeholder"
  mode="$(stat -c '%a' "$secret")"
  [[ "$mode" == 600 ]] && ok "secret file mode is 600" || fail "secret file mode must be 600"
else
  fail ".env is missing"
fi
if command -v systemctl >/dev/null; then
  systemctl is-enabled agent-handoff-ingress.service >/dev/null 2>&1 && ok "ingress service enabled" || printf 'info: ingress service not enabled\n'
  systemctl is-enabled agent-handoff-worker.service >/dev/null 2>&1 && ok "worker service enabled" || printf 'info: worker service not enabled\n'
fi
exit "$failures"
