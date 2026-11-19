---
name: using-echo-mcp
description: Retrieve prior work and decisions from the read-only ECHO context server. Record founder-live calls in the live version's dogfooding journal.
---

# Use ECHO MCP

Use the `echo` MCP server. The `echo-memory` server is a separate, write-capable product. Apply the founder-live journal check below before the first call in each user turn.

## Find the evidence

- For a repository handoff, use `find_clusters({group_by: "project", repo_path: "/absolute/repo/root"})`. For a discussion, group by `"thread"` and use the known time window. Read representative IDs with `get_atoms`. Add `fields: ["content"]` for the conversation text, or request metadata for thread lineage.
- For a literal phrase, SHA, path, or error, use `search_memories` with the narrowest known source, repo, or dates. For a named app’s latest session, `echo_resolve_mru` gives a source and filter to pass to search. Check the topic against the returned turns.
- Read one known ID with `get_atom` when the exact wording matters. If the body exceeds its wire limit, use the returned source pointer where accessible. In older Codex captures, an opening update and final answer can be separate observations. Search the exact session around that time and compare logical turn IDs.
- To watch for new turns, use `wait_for_new_turns` with a source selector and an offset-bearing `since`. Poll from the returned `next_since`, including after timeout. On `[NEXT_SINCE_CLAMP]`, retry from the intended non-future time. Use explicit offsets throughout and preserve returned timestamps. Use `echo_ping` for connectivity.

Stop when the evidence answers the question. For exhaustive coverage, continue the relevant pages.

| Tool | Continuation |
| --- | --- |
| `find_clusters` | Send only `cursor`. Use a group's `membership_cursor` for members after its representatives, or the top-level `next_cursor` for the next page. |
| `search_memories`, `get_atoms` | Repeat the original arguments and add `cursor` set to the returned `next_cursor`. |

A zero-match search with `[SEARCH_SCAN_BUDGET]` leaves older candidates unscanned. Skip missing IDs and read deferred IDs on the next page. Cite the source and mention any clipping, missing coverage, or freshness limit that affects the answer.

## Founder-live journal

Check `~/.local/share/echo-context/state/dogfooding-journals.json`. If absent or disabled, skip journaling. If the user requires recording, report that it is disabled and make no ECHO call. On unreadable or malformed state, stop and report the error.

When enabled, use the installed helper before retrieval. Set `<actor>` to `codex` or `claude`.

```sh
node ~/.local/share/echo-context/tools/journal-client.mjs resolve --actor <actor>
```

The helper verifies live `components.runtime.details.version` and `components.runtime.details.artifact_digest` and selects `codex.md` or `claude.md`. Proceed on `ready`. For `disabled`, apply the rule above. On error, make no ECHO call. For `needs_confirmation`, show the exact prompt below.

`ECHO runtime <version> has no dogfooding journal. Create it now and make it current?`

If the founder answers yes, use `create --journal-dir <path>` inside the exact accepted release evidence. Ask for the path if unknown. The helper sets directory mode `0700` and file mode `0600`. Then run `resolve --actor <actor>`
again and proceed only when it returns `ready`.

After the last call, pipe one JSON object to the same helper's `append --actor <actor>`. Include `timestamp` with offset, `trigger`, `query_inputs` including preflight, `returned`, `sources`, `verdict`, and `note`. Use `conjecture` for an optional hypothesis. Every supplied value must be a non-empty string. `verdict` must begin with `right`, `partial`, or
`wrong`, followed by the reason. Use `partial` for incomplete, empty, or failed retrieval. Summarize without secrets or raw payloads.

Recording succeeds when append returns `status: "appended"`. For another status, resolve and satisfy it before retrying. After an append error, inspect the shard tail for an existing entry before retrying. A stale lock requires operator inspection of the writer and shard. If recording still fails, report that the ECHO call was not recorded.
