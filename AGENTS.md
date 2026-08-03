# Agent instructions

This repository is ECHO's canonical context-layer source and installable
context-daemon package. It contains context capture/storage/retrieval only; do
not add product coordination, Slack, backlog, or enrichment-loop ownership.

- This repository also owns the context MCP usage skill and its Codex/Claude
  sync operator. Do not source or regenerate those instructions from
  `Project_echo`.
- Changes to `main` require an independently reviewed feature branch. A builder
  must never review its own implementation.
- Hosted CI is source verification only. It must remain read-only and must not
  publish, promote, migrate, cut over, roll back, or acquire runtime authority.
- Build, install, and promote only one exact reviewed Git object. Never rebuild
  between founder-live and client-live acceptance.
- Treat live migration and cutover as explicit operator workflows. Copy legacy
  SQLite state read-only, prove the copy in an isolated lane, preserve the old
  database and LaunchAgent, and fail back automatically before claiming health.
- Never put product credentials in this package, its plist, logs, or evidence.
  The runtime binds loopback only and reads only `ECHO_CONTEXT_*` configuration.
- Keep query/startup memory bounded regardless of database or source-history
  size. New capture adapters need durable checkpoints and capped/coalesced work.
- The item-135 provenance documents, including
  `provenance/runtime-inventory.v1.json`, are immutable historical evidence.

<!-- BEGIN ECHO -->

# ECHO

ECHO context is available through the `echo` MCP server at `http://127.0.0.1:39478/mcp`.

Before calling ECHO, follow the installed `$using-echo-mcp` skill.
On this founder-live machine, those instructions also bind every ECHO-using
turn to the live runtime's versioned dogfooding journal.

<!-- echo-context-agent-instructions: 1 -->

<!-- END ECHO -->
