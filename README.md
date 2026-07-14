# echo-context

Standalone ECHO **context substrate**: generic capture, normalization, append-only
storage, clustering/retrieval, permissions/health, and the eight read-only context
MCP tools. Extracted from Project_echo commit
`2971310441b69735cbe759293abd8c4d044bf347` (item 135).

The eight context tools (see `context-tools.v1.json`): `echo_ping`,
`echo_resolve_mru`, `find_clusters`, `get_atom`, `get_atoms`,
`get_recent_work_context`, `search_memories`, `wait_for_new_turns`. Capture is a
service-only `POST /v1/capture` operation — never a ninth MCP tool.

Project_echo remains the active daemon/MCP, backup, and authority. This repo is
local-only with no remote; it proves the split on synthetic state only.

---

## ⚠️ STATUS: INCOMPLETE / UNACCEPTED (item 135, in-progress attended build)

This commit is a founder-endorsed **incomplete milestone**, not an accepted
target. It is on branch `migration/2026-07-13-135` with no remote. Do not treat
it as passing acceptance.

### Done and verified in this commit
- **AC1** isolated repo (config-free init, migration branch, no remote/reflogs).
- **AC6** source closure: `tools/emit-source-inventory.mjs` reproduces the sealed
  217-path inventory (110 source + 107 test), SHA-256
  `8b0280660ea5eb64851a5ce0d1a9d56b707d6e29ce00d113ec6656b055d72d37`.
- **AC6** extraction: 172 ported byte-exact + 3 rewritten (`src/mcp/server.ts`
  → exact 8-tool roster; `src/enrich/granola-signals.ts` → AC5 minimal generic
  duplicate; `tests/mcp/tools/search-memories.test.ts` → product-decision cases
  excised) + 42 excluded (coord/product/loop tools, product enrich workers,
  onboarding wizard, brain test). Import closure verified: 0 unresolved local
  imports among ported/rewritten.
- `provenance/source-evidence.v1.json`, `provenance/parity-matrix.v1.json`,
  `context-tools.v1.json`, `package.json` (Node 22.22.1 / npm 10.9.4 pins).

### Remaining before acceptance (see the Project_echo run log for the full map)
- Standalone build green: install (AC7), typecheck, lint, and the ~107 tests.
- `provenance/target-only-policy.v1.json` (exact 38-path list) + the exact
  HEAD-equality partition with `source-extraction.v1.json`; the 9 provenance
  schemas.
- `provenance/runtime-inventory.v1.json` + `tools/check-runtime-inventory.mjs`
  (AC2 closed edge grammar).
- `tests/fixtures/context-tool-parity.v1.json` + `tools/verify-context-tools.mjs`
  + `provenance/context-tool-parity.v1.json` (AC3 stdio parity, 10 ordered cases).
- `src/state/paths.ts` `ECHO_CONTEXT_HOME` distinct default (AC4).
- `schemas/service-api.v1.json` + `tools/verify-service-parity.mjs` +
  `tests/integration/context-service.test.ts` (AC8).
- AC7 clean-install lifecycle proof under `sandbox-exec` network denial
  (`lifecycle-expected/observed`, `native-toolchain`); only the pinned
  `better-sqlite3` rebuild may execute.
- The six migration tests; migration record; codex-ops reviewer handoff.

### Open question for the founder
The AC6 exhaustive 38-path target-only policy does **not** include a tracked
`tsconfig.json` (nor eslint/vitest config), yet AC7 requires `typecheck` and
`lint` to run from the private clone. A provisional `tsconfig.json` (kept in the
builder's scratch, not committed) mirrors the source's NodeNext/ES2022 strict
config. Reconcile before acceptance: either TS/lint config is supplied via CLI
flags at check time, or the 38-path policy needs those config paths added.
