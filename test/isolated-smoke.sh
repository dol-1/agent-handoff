#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
value_for() { awk -F= -v key="$2" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$1"; }
secret="$(value_for "$ROOT/.env" LINEAR_WEBHOOK_SECRET)"
team_id="$(value_for "$ROOT/.env.routing" AGENT_HANDOFF_ALLOWED_TEAM_ID)"
project_id="$(value_for "$ROOT/.env.routing" AGENT_HANDOFF_ALLOWED_PROJECT_ID)"
runtime_dir="$(value_for "$ROOT/.env.routing" AGENT_HANDOFF_RUNTIME_DIR)"
node_bin="$(command -v node)"
for value in "$secret" "$team_id" "$project_id" "$runtime_dir"; do [[ -n "$value" ]] || { echo 'configuration is incomplete' >&2; exit 1; }; done

systemctl stop agent-handoff-worker.service
systemctl start agent-handoff-ingress.service
for _ in $(seq 1 30); do curl --fail --silent http://127.0.0.1:8788/healthz >/dev/null && break; sleep 0.2; done
body="$(printf '{"action":"update","type":"Issue","webhookTimestamp":%s,"updatedFrom":{"stateId":"previous-state"},"data":{"id":"issue-clean-1","identifier":"DEMO-CLEAN-1","team":{"id":"%s"},"project":{"id":"%s"},"state":{"name":"Todo"},"url":"https://linear.app/example/issue/DEMO-CLEAN-1/smoke"}}' "$(( $(date +%s) * 1000 ))" "$team_id" "$project_id")"
signature="$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$secret" | sed 's/^.* //')"
curl --fail --silent --show-error -X POST http://127.0.0.1:8788/hooks/linear \
  -H 'content-type: application/json' -H "linear-signature: $signature" \
  -H 'linear-delivery: clean-machine-smoke-1' -d "$body" >/dev/null

# Ingress restart must not lose the accepted pending event.
systemctl restart agent-handoff-ingress.service
"$node_bin" --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; const db=new DatabaseSync(process.argv[1],{readOnly:true}); const row=db.prepare("select status from events where delivery_id=?").get("clean-machine-smoke-1"); if(row?.status!=="pending") process.exit(1);' "$runtime_dir/queue.db"

systemctl start agent-handoff-worker.service
for _ in $(seq 1 60); do
  if "$node_bin" --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; const db=new DatabaseSync(process.argv[1],{readOnly:true}); const row=db.prepare("select status from events where delivery_id=?").get("clean-machine-smoke-1"); process.exit(row?.status==="delivered"?0:1);' "$runtime_dir/queue.db"; then break; fi
  sleep 0.25
done
"$node_bin" --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; const db=new DatabaseSync(process.argv[1],{readOnly:true}); const rows=db.prepare("select status,attempt_count,last_error_class from events where delivery_id=?").all("clean-machine-smoke-1"); if(rows.length!==1||rows[0].status!=="delivered"||rows[0].attempt_count!==0||rows[0].last_error_class!==null) process.exit(1);' "$runtime_dir/queue.db"

# Restart must preserve terminal delivery and must not duplicate work.
systemctl restart agent-handoff-worker.service agent-handoff-ingress.service
sleep 1
"$node_bin" --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; const db=new DatabaseSync(process.argv[1],{readOnly:true}); const row=db.prepare("select count(*) n,min(status) status from events where delivery_id=?").get("clean-machine-smoke-1"); if(row.n!==1||row.status!=="delivered") process.exit(1);' "$runtime_dir/queue.db"
curl --fail --silent http://127.0.0.1:8788/healthz >/dev/null
printf 'isolated handoff smoke: PASS\n'
