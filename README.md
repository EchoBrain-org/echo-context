# echo-context

Standalone ECHO **context substrate**: generic capture, normalization,
append-only storage, clustering/retrieval, permissions/health, and the eight
read-only context MCP tools. It was extracted from Project_echo commit
`2971310441b69735cbe759293abd8c4d044bf347` under item 135.

The eight tools, sealed in `context-tools.v1.json`, are `echo_ping`,
`echo_resolve_mru`, `find_clusters`, `get_atom`, `get_atoms`,
`get_recent_work_context`, `search_memories`, and `wait_for_new_turns`.
Capture is available only as service operation `POST /v1/capture`; it is never
a ninth MCP tool.

## Candidate status

The repository is a builder-complete local extraction awaiting fresh
independent review of the exact candidate OID. It remains on
`migration/2026-07-13-135`, has no remote, and is deliberately
`authority:false`, `installed:false`, and maturity `DEV`. Project_echo remains
the active daemon, MCP endpoint, backup, and authority. No user or live ECHO
state is read by the synthetic verification paths.

## Sealed evidence

- The raw pinned-source inventory is 217 paths: 144 byte-identical ports, seven
  deterministic rewrites, one deliberate duplication, and 65 exclusions.
  Same-path source SHA-256 and Git blob OIDs are cryptographically cross-bound
  across source evidence, parity rows, replay output, and committed target
  blobs.
- `provenance/runtime-inventory.v1.json` is derived recursively from final Git
  objects. It closes package scripts, executable tools, embedded launchers,
  target modules, literal SQL assets, exact npm rows, `tsx`, `vite-node`, the
  `better-sqlite3` native binding, and pinned system helpers. Computed imports,
  repository-rooted reads, and process launches fail closed.
- Context-tool parity launches both raw pinned source and target over stdio on
  fresh synthetic state. The pinned source `src/mcp/server.ts` is HTTP-only, so
  both sides use the same hash-bound scratch registrar harness. Evidence binds
  the source's full 15-tool roster, seven classified ignored IDs, the projected
  eight descriptors, ten ordered full-result cases, fixture/config/harness
  bytes, and aggregate
  `2f0b28f6b62d31682db30b63139e21cc42977713500a1655f65213f69d7f427e`.
  The wait case maps the source's integer `timeout: 1` to a literal 10 ms wall
  budget by advancing the identical harness's virtual clock 1000 ms.
- The loopback service compiles and enforces `schemas/service-api.v1.json` for
  every request and successful response. It caps bodies, IDs, and serialized
  results; uses bounded storage retrieval; sanitizes its environment; enforces
  request and shutdown deadlines; and treats forced teardown as failure.
- Dependency installation is lockfile-only. Lifecycle evidence permits only
  the pinned `better-sqlite3` rebuild under network-denying `sandbox-exec`, and
  binds the resulting native artifact and toolchain.

The normal next gate is independent review against the exact clean target OID
and tree. Review acceptance does not install, publish, promote, or grant this
repository authority.
