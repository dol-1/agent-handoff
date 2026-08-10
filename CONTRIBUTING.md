# Contributing

Open an issue before changing orchestration semantics. Keep changes focused,
add regression coverage, and preserve fail-closed delivery, distinct executor
and reviewer sessions, bounded revision cycles, and Human Gate behavior.

Run `npm ci`, `npm test`, `bash -n install.sh bin/*.sh`, and a repository-wide
secret/privacy scan. Never include credentials, private identifiers, runtime
data, or host-specific absolute paths. Public contribution terms remain subject
to repository publication; contributions are licensed under Apache-2.0.
