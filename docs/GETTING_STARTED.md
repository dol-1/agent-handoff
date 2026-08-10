# Getting Started

This guide takes a first-time user from a fresh clone to a local health check.
Start with a test Linear project and a non-production workspace.

## 1. Prerequisites

You need:

- a Linux system using systemd, with Bash and `flock`;
- Node.js 22.5 or newer;
- an installed and authenticated Claude Code CLI;
- a workspace where Claude Code can access Linear and GitHub;
- a Linear webhook secret plus the IDs of the test team and project; and
- `Todo`, `In Review`, and `Done` states in that Linear workflow.

Check the main tools before continuing:

```bash
node --version
claude --version
command -v flock
```

## 2. Clone and install dependencies

```bash
git clone https://github.com/dol-1/agent-handoff.git
cd agent-handoff
npm ci
```

## 3. Create configuration from the templates

Run the installer without starting services. Replace the workspace example with
the absolute path to the repository that Claude should work in.

```bash
./install.sh --workspace /absolute/path/to/your/agent-workspace --no-start
```

The installer creates `.env` and `.env.routing` from the checked-in templates
and sets restrictive permissions. Edit them locally:

- In `.env`, set a newly generated `LINEAR_WEBHOOK_SECRET`.
- In `.env.routing`, replace the team and project placeholders and confirm the
  workspace and runtime paths.

Never commit either file or paste its contents into an issue or log.

## 4. Validate and start

Run doctor before starting the services:

```bash
./install.sh doctor
sudo systemctl enable --now agent-handoff-ingress.service agent-handoff-worker.service
curl --fail http://127.0.0.1:8788/healthz
```

A successful health request returns JSON with `ok: true`. The listener stays on
`127.0.0.1`; exposing TLS ingress and configuring Linear webhook delivery are
operator-managed steps.

## 5. First verification

Run the credential-free test suite first:

```bash
npm test
```

For the first real smoke test, use only the configured test team, project, and
workspace. Move one test issue into `Todo`, then confirm:

1. ingress accepts the signed delivery;
2. the execution result moves the issue to `In Review`;
3. the separate review completes; and
4. a passing review moves the issue to `Done` with a Human Gate marker.

`Done` never authorizes an automatic merge or deployment.

## Common troubleshooting

- **Doctor reports a missing command:** install the named dependency and rerun
  `./install.sh doctor`.
- **Doctor reports missing routing:** replace every placeholder in
  `.env.routing` and verify the workspace exists.
- **Webhook requests fail:** confirm the sender and `.env` use the same secret,
  without printing the secret.
- **Health check fails:** inspect service status and recent logs:

  ```bash
  sudo systemctl status agent-handoff-ingress agent-handoff-worker
  sudo journalctl -u agent-handoff-ingress -u agent-handoff-worker -n 100
  ```

Do not publish environment files or unsanitized logs when asking for help.

## Safe uninstall

```bash
./install.sh uninstall
```
