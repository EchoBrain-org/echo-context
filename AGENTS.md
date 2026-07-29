# Agent instructions

This repository is ECHO's canonical context-layer source and installable
context-daemon package. It contains context capture/storage/retrieval only; do
not add product coordination, Slack, backlog, or enrichment-loop ownership.

- Changes to `main` require an independently reviewed feature branch. A builder
  must never review its own implementation.
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

ECHO is wired to the `echo` MCP server (tools prefixed `mcp__echo__`) at `http://127.0.0.1:39478/mcp`. Default project: `none chosen`.

Use the ECHO tools `find_clusters`, `get_atoms`, `get_atom`, `search_memories`, `echo_resolve_mru`, `wait_for_new_turns`, `echo_ping` to retrieve your prior cross-tool context. See `~/.echo/state/onboarding.json` for the install record.

<!-- echo-version: 0.1.0-beta.1 · runtime-version: 0.1.0-beta.5 · rendered-at: 2026-07-29T00:50:14.000Z -->

<!-- END ECHO -->
