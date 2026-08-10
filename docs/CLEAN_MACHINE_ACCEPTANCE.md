# Clean-machine acceptance evidence

MY0-67 publication readiness was exercised in a disposable, privileged systemd
container built from the pinned `node:24-bookworm` image digest
`sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584`.
The container had no parent-repository bind mount, host credentials, production service access,
or product repository access. A credential-free bare Git snapshot of this standalone
directory was copied in and cloned to `/opt/agent-handoff`.

Environment: Debian GNU/Linux 12 (bookworm), Node v24.19.0, systemd 252.

Acceptance results:

- `npm ci --ignore-scripts`: PASS (93 packages; zero audit vulnerabilities).
- `npm test` on Node 24: PASS (204/204).
- Install with `USER` and `SUDO_USER` unset: PASS via `id -un` fallback.
- Installer-generated `.env` and `.env.routing`: mode 0600.
- Installer-generated `.runtime`: mode 0700.
- Rendered ingress and worker units: mode 0644.
- Both units enabled and started successfully under systemd.
- Doctor: all required checks PASS; both services reported enabled.
- Signed local webhook ingress: PASS.
- Pending event survived ingress restart before worker startup: PASS.
- Isolated handoff completed once: `delivered`, `attempt_count=0`,
  `last_error_class=null`.
- Worker and ingress restart preserved terminal delivery without duplication: PASS.
- Safe uninstall disabled/stopped both services, removed both unit files, and
  preserved an unchanged durable queue database: PASS.

The smoke used the repository fake Claude executable behind the real worker CLI
interface and test-only local routing identifiers. It exercised the installed ingress,
SQLite queue, worker, systemd units, signatures, restart handling, and uninstall path;
it did not contact Linear or any production/product service.

## Remaining gate

A real reboot is not proven. A Docker container shares the host kernel, so restarting
the container or systemd PID 1 would not constitute a clean-machine kernel reboot.
Publication remains blocked only on repeating the enabled-service recovery check across
a real reboot in an isolated supported Linux VM or disposable physical host.
