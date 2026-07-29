---
name: using-echo-mcp
description: Use the ECHO context MCP server to recover prior work, decisions, and live cross-tool activity through bounded grouped retrieval, disciplined continuation, and explicit trust signals. On founder-live machines, bind every ECHO-using turn to the live runtime's versioned dogfooding journal.
---

# Use ECHO MCP

## Select the right server

Use only the `echo` MCP server and its `mcp__echo__*` tools:
`echo_ping`, `echo_resolve_mru`, `find_clusters`, `get_atom`, `get_atoms`,
`search_memories`, and `wait_for_new_turns`.

Do not substitute `echo-memory` or `mcp__echo-memory__*`. That is a different,
write-capable product.

## Bind founder-live calls to a version journal

Apply this gate only when
`~/.local/share/echo-context/state/dogfooding-journals.json` exists and contains
`"enabled": true`. If the file is absent or explicitly disabled, skip the gate;
customer installs do not require dogfooding state. If it exists but is
unreadable or malformed, report the failure and make no ECHO call.

Codex uses actor `codex`; Claude Code uses actor `claude`. Before the first ECHO
call in each user turn, run:

```sh
node ~/.local/share/echo-context/tools/journal-client.mjs resolve --actor <actor>
```

The helper reads the live version and artifact digest from `/healthz`; validates
the exact registry mapping, path containment, journal index, and actor shard;
and updates `current_version` only as a convenience pointer. Never infer live
identity from package metadata, this skill, or a cached install record.
Specifically, it requires `components.runtime.details.version` and
`components.runtime.details.artifact_digest`.

- `ready`: proceed and retain the returned version and shard.
- `disabled`: proceed without founder-live journaling.
- `needs_confirmation`: make no ECHO call and show the helper's exact prompt:
  `ECHO runtime <version> has no dogfooding journal. Create it now and make it current?`
- Any error: report it and make no ECHO call.

If the founder answers yes, run the helper's `create --journal-dir <path>`
operation with an explicit dogfooding directory inside the exact accepted
release evidence. Never invent a generic version directory. If that exact
release path is not known, ask for it. Creation writes only `JOURNAL.md`,
`codex.md`, and `claude.md`, records the live artifact digest, and uses
directory mode `0700` and file mode `0600`.

After the last ECHO call in the turn, send one JSON object on standard input to
the helper's `append --actor <actor>` operation. Include `timestamp`, `trigger`,
`query_inputs`, `returned`, `sources`, `verdict`, `note`, and optional
`conjecture`. The helper revalidates live identity and serializes the append.
One entry may cover several calls. Include the health preflight in
`query_inputs`; log errors and zero-result calls. Never paste large raw
payloads, secrets, credentials, or sensitive returned prose.

## Preserve timestamps

Send explicit offsets (`Z`, `±HH:MM`, or `±HHMM`) and copy response timestamps
verbatim. In beta.6, `wait_for_new_turns` rejects offset-less `since`;
`search_memories` and `find_clusters` accept them with a `[TZ]` warning.

Never send a future `since` to `wait_for_new_turns`. If an accidental future
input produces `[NEXT_SINCE_CLAMP]`, retry from the intended non-future bound
before continuing from the returned watermark.

## Continue with the right contract

- `find_clusters` grouped pages: send the returned `membership_cursor` or
  `next_cursor` value as the only input key, `cursor`.
- `search_memories`: send `next_cursor` as `cursor` and repeat the original
  query, source selector, repo path, metadata match, time bounds, and limit.
- `get_atoms`: repeat the original IDs, fields, preference, and view with
  `cursor`.

Never send `membership_cursor` or `next_cursor` as input keys. They are response
field names. All seven beta.6 tools reject unknown top-level keys.

## Resume a repository

Call `find_clusters({group_by: "project", repo_path: "/absolute/repo/root"})`,
then hydrate `representative_atom_ids` with
`get_atoms({atom_ids, view: "compact"})`. Use the legacy ungrouped flow only
when grouped routing cannot answer the task.

For thread topology, call `find_clusters({group_by: "thread"})`, then hydrate
with `view: "rich"` or `fields: ["metadata"]`; compact view omits topology.

For all members of one group:

1. Hydrate representatives first.
2. Send that group's `membership_cursor` value as `cursor`, alone.
3. Continue with each returned `next_cursor` until it is null.
4. Treat representatives plus membership pages as the complete set.

`atoms_total` includes representatives, so a final membership page can return
fewer atoms than `atoms_total` without losing data.

## Interpret hydration honestly

- `atoms_missing`: the ID does not exist; stop retrying it.
- `atoms_deferred`: the atom exists but did not fit; continue with
  `next_cursor`.
- `atoms_dropped`: compatibility sum of missing plus deferred; do not treat the
  whole field as terminal loss.
- Inspect each atom's `truncations` even when no IDs are deferred.

Use compact views and field projection as the primary cost controls. MCP
dual-encoding makes wire cost roughly twice the JSON budget.

## Search and freshness

Use `search_memories` for exact tokens such as SHAs, paths, error strings, and
quoted phrases. Matching is case-insensitive literal substring, not semantic.
A zero-match response with `[SEARCH_SCAN_BUDGET]` is incomplete; continue with
the same search shape and its cursor when the answer matters.

Use `wait_for_new_turns` with an offset-bearing `since`, a non-empty source
selector, and a short timeout. Feed its `next_since` into the next poll. Fetch
bodies with `get_atoms`.

Use `get_atom` only to recover one truncated or over-wire atom. Use
`echo_resolve_mru` to resolve an app or exact source into search filters.
Use `echo_ping` only for connectivity.

## Report trust signals

State what ECHO returned, which sources supported it, and whether warnings,
unconsumed cursors, or truncation make the result partial. If the first chain is
thin, make one disciplined fallback by widening the time window or relaxing the
narrowest filter before asking the user for more clues.
