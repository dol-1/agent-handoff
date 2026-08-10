# Agent Handoff

Agent Handoff is a local, durable bridge from Linear issue state changes to
separate Claude Code execution and review turns. It accepts verified webhook
events, commits them to SQLite before responding, and processes jobs through a
bounded state machine.

Agent Handoff is licensed under Apache-2.0.

## State machine

```text
Todo -> execute (Sonnet) -> [SONNET RESULT] -> In Review
  -> review (--model opus) -> REVISION REQUIRED -> Todo
  -> review PASS -> [OPUS REVIEW #<cycle>-r<revision>] PASS — HUMAN GATE -> Done
```

`Done` is only the terminal automation marker. Agent Handoff never treats it as
permission to merge, deploy, or perform another destructive action. Execution
and review use distinct stable Claude session identities and share one exclusive
worker lane.

## Reliability model

Ingress and worker are separate processes sharing one SQLite queue. Signed
Linear deliveries are deduplicated and durably recorded before HTTP 200.
Failures remain pending with bounded exponential backoff; exhausted attempts
move to `needs_review`. Startup and periodic reconciliation recover missed
eligible transitions. Cycle IDs and revision counts prevent duplicate review
actions, and completed cycles cannot enqueue post-`Done` work.

## Requirements

- Linux with Bash, `flock`, and systemd for service installation
- Node.js 22.5 or newer (`node:sqlite`)
- Claude Code CLI authenticated for the installation user
- Claude Code access to Linear and GitHub in the configured workspace
- A Linear webhook secret, team ID, project ID, and the `Todo`, `In Review`,
  and `Done` workflow states

Claude Code is the first supported execution backend. The durable Linear queue
and state machine are kept separate from invocation/evaluation modules so later
backends can be added without replacing orchestration semantics.

## Install

```bash
git clone https://github.com/dol-1/agent-handoff.git
cd agent-handoff
./install.sh --workspace /absolute/path/to/your/agent-workspace --no-start
```

The installer discovers the current user, repository, Node, and Claude paths;
creates `.env`, `.env.routing`, and `.runtime` with restrictive permissions;
and renders machine-correct service units from `.service.in` templates. Edit:

- `.env`: replace `LINEAR_WEBHOOK_SECRET` with a new random secret. This file is
  ingress-only and is never loaded by the worker service.
- `.env.routing`: replace the Linear team/project placeholders and confirm the
  workspace/runtime paths.

Then validate and start:

```bash
./install.sh doctor
sudo systemctl enable --now agent-handoff-ingress.service agent-handoff-worker.service
curl --fail http://127.0.0.1:8788/healthz
```

The listener is fixed to `127.0.0.1`; external TLS ingress and webhook routing
are operator-managed and outside this installer.

## Security boundaries

Webhook bodies are HMAC-SHA256 verified before parsing or routing. Only trusted
identifiers enter jobs; webhook free text is not forwarded. Routing is explicit
and fail-closed. The ingress service alone loads `.env`; the worker loads only
non-secret routing, and spawned Claude processes explicitly remove
`LINEAR_WEBHOOK_SECRET` from their environment. Runtime state and session IDs
are stored under `.runtime` with owner-only permissions.

Never commit `.env`, `.env.routing`, `.runtime`, database files, session IDs, or
logs. See [SECURITY.md](SECURITY.md) for private reporting guidance.

## Doctor and troubleshooting

```bash
./install.sh doctor
# or
npm run doctor
```

Doctor checks Node, Claude Code, `flock`, required routing without printing its
values, secret presence and file mode, workspace existence, runtime
writability, and installed service status. For service failures:

```bash
sudo systemctl status agent-handoff-ingress agent-handoff-worker
sudo journalctl -u agent-handoff-ingress -u agent-handoff-worker
```

Do not paste environment files or unsanitized logs into an issue.

## Upgrade

1. Stop both services.
2. Back up `.runtime` and both environment files without changing ownership.
3. Update the source to a reviewed release.
4. Run `npm ci`, `./install.sh --workspace <same-path> --no-start`, and doctor.
5. Restart ingress, then worker, and confirm `/healthz`.

The installer preserves existing configuration and durable data.

## Uninstall

```bash
./install.sh uninstall
```

This disables/removes the generated units and preserves `.runtime`. Durable
data is deleted only with the explicit `--purge-data` flag.

## Development

```bash
npm ci
npm test
```

Tests use temporary runtime directories and a spawned fake Claude executable;
they do not require live Linear events. See [CONTRIBUTING.md](CONTRIBUTING.md).
