# Security

Do not report vulnerabilities with secrets, webhook bodies, environment files,
session transcripts, queue databases, or unsanitized logs in a public issue.
Until a public security contact is approved, use the repository owner's private
GitHub contact channel.

Agent Handoff should be bound to loopback behind operator-managed authenticated
TLS ingress. Rotate the Linear webhook secret after suspected exposure. Keep
`.env` readable only by the service user and never load it into the worker.
