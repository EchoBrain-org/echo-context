# echo-context

`echo-context` is ECHO's standalone context-layer package and daemon. It owns
coding-session capture, normalization, append-only SQLite storage, bounded
retrieval, readiness health, and the seven read-only context MCP tools sealed in
`context-tools.v2.json`.

It intentionally does **not** contain product coordination, Slack, backlog
workers, enrichment loops, or permanent raw filesystem-change capture.

## Runtime model

The daemon opens a compact checkpoint table before starting capture watchers.
Codex and Claude Code resume from those checkpoints and catch up through
coalesced, capped, serial queues. Health stays `starting` or `catching_up` until
that work completes. SQLite retrieval is paged and has hard row, stored-byte,
and scan-page budgets; free-text search advances through bounded keyset pages.

Defaults:

- home: `~/.echo-context`
- database: `~/.echo-context/data/context.db`
- MCP: `http://127.0.0.1:38478/mcp`
- health: `http://127.0.0.1:38478/healthz`
- bounded service API: `http://127.0.0.1:38478/v1/*`
- live capture: Codex and Claude Code only
- historical compatibility: migrated Cursor events remain queryable and normalized

The HTTP server refuses non-loopback binds. Runtime configuration is isolated
under `ECHO_CONTEXT_*`; it does not inherit Project_echo product secrets.

## Logical activity model

The event ledger remains append-only: every physical source observation is
preserved under its original stored ID. Codex and Claude Code capture stable
logical-turn identity, original occurrence time, observation time, thread
lineage, initiator, and canonical project identity when their source records
provide that evidence. Ambiguous evidence stays `unknown`; capture never
reconstructs identity from matching text.

Retrieval projects those raw observations into logical turns before clustering
or ranking. It groups only `(provider, logical_turn_id)`, retains an original
stored event ID for `get_atoms`, and never treats a later inherited copy as new
activity. If a bounded scan contains only inherited observations, one
representative is retained and evaluated at the logical turn's original
occurrence time. Existing rows without provider identity remain distinct.

Thread topology is project-partitioned and bounded. Explicit root lineage is
authoritative; repo/workspace and generic conversation references are
descriptive only. Concrete strong work artifacts may connect activity; weak
file and document references can attach unowned activity but cannot merge two
explicit roots, while branch references are descriptive only. The default
continuity gap stays four hours regardless of retrieval lookback, and the graph
is emitted as a deterministic spanning forest rather than a pairwise clique.

Run the synthetic fork/copy regression benchmark with:

```sh
node --import tsx tools/benchmark-context-topology.ts
```

It is a deterministic synthetic regression, not a substitute for capture and
SQLite integration tests. It verifies raw-ledger preservation, logical
collapse, canonical project scope, seven-thread topology, complete
`find_clusters` → `get_atoms` hydration, wire size, and bounded latency under
a 10× inherited-copy stress case. Its report also includes the opt-in project
and root-thread routing envelopes, representative-ID cost, and lossless member
pagination.

## Agent-facing context routing

The MCP roster remains seven read-only tools. Existing `find_clusters` calls
are unchanged. Agents may opt into a lean routing projection:

- `group_by: "project"` returns canonical project keys and a `repo_path` that
  can be passed back to scope later retrieval.
- `group_by: "thread"` groups a root thread with its child-agent activity,
  partitioned by canonical project and provider.
- Each group reports unique logical turns, represented raw observations,
  collapsed-copy count, source coverage, a time range, and a small set of
  stored representative IDs.

Grouped header pages use top-level `next_cursor`. A group whose membership is
larger than its representative preview has `membership_cursor`; concatenate
the representative IDs with each returned member page for complete,
duplicate-free membership. Group cursors freeze the resolved time window and
fail closed if delayed capture changes the bounded result set.

`get_atoms` remains capped at 50 requested IDs and 25,000 response bytes. When
that byte budget defers existing atoms, repeat the same IDs and projection
options with `next_cursor`. `atoms_missing` is terminal absence;
`atoms_deferred` is recoverable work, and their sum is the compatibility
`atoms_dropped` count for that page.

## Agent instruction ownership

This repository is the canonical source for the `using-echo-mcp` skill. The
source sync operator installs the same reviewed skill bytes directly for Codex
and Claude Code and refreshes only their managed ECHO banner blocks:

```sh
npm run sync:agents -- --mcp-url http://127.0.0.1:<live-port>/mcp
npm run check:agents
```

The operator does not configure Cursor, import product workflows, or use
`Project_echo` as an intermediate source. Agent-global synchronization is an
explicit operator action rather than a side effect of candidate daemon
installation.
The first sync fails closed unless an explicit loopback MCP URL is supplied or
the canonical registry already contains one; it never guesses a live port.

Founder-live version journals remain mutable release evidence outside Git.
Their selector registry lives at
`~/.local/share/echo-context/state/dogfooding-journals.json`; journal payloads
live beside the exact accepted release under
`~/.local/share/echo-context/releases/`. The installed helper validates the
live runtime version and artifact digest before resolving or appending to the
Codex or Claude shard. Missing mappings require founder confirmation and an
explicit accepted-release journal path. Customer installs with no enabled
registry are unaffected.

## Adapter incubation boundary

The context-adapter registry is the single composition point for observational
source integrations. Core normalization accepts an immutable registration list
from that outer layer; it does not import bundled adapters or capture code.
Every bundled adapter has a stable identity and normalization registration.
Live capture is an optional capability whose descriptor, startup priority, and
factory live together on the same definition. Concrete extractor code loads
only when that adapter starts, and every non-helper extractor entrypoint must
be bound exactly once. Codex and Claude Code currently provide both. Cursor,
Git, and Granola remain normalization-only registrations, so historical data
stays readable without silently activating provider access or background work.

The runtime starts enabled capture registrations sequentially and stops them in
reverse order. Adding an incubating source here does not make it an Echo Brain
operational adapter: this package owns only capture, normalization, storage, and
retrieval. Product actions, credentials, coordination, and client-facing
capability selection remain outside this boundary.

Every current TypeScript file under `src/` is part of the package build closure.
Retired incubation prototypes stay recoverable in Git history instead of living
as dormant source. The immutable item-135 parity records describe the accepted
extraction baseline; their operator replay materializes that exact Git commit.
They are not a requirement to retain every historical file in the current
package.

## Install the technical preview

The beta is distributed from the
[GitHub prereleases](https://github.com/EchoBrain-org/echo-context/releases),
not from the npm registry. For `0.1.0-beta.8`, download all three assets from
the same release:

- `echo-context-0.1.0-beta.8.tgz`
- `echo-context-0.1.0-beta.8.tgz.sha256`
- `beta-release-manifest.v1.json`

The manifest binds the version and tag to the reviewed source commit, tarball
SHA-256, runtime manifest, local CI, independent review, and package smoke.
Verify the downloaded tarball before installing it. On Linux use
`sha256sum -c`; on macOS use `shasum -a 256 -c`:

```sh
sha256sum -c echo-context-0.1.0-beta.8.tgz.sha256
# macOS: shasum -a 256 -c echo-context-0.1.0-beta.8.tgz.sha256
```

On Windows PowerShell:

```powershell
$expected = (Get-Content .\echo-context-0.1.0-beta.8.tgz.sha256).Split()[0].ToLower()
$actual = (Get-FileHash .\echo-context-0.1.0-beta.8.tgz -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $expected) { throw "ECHO Context tarball checksum mismatch" }
```

Use the reviewed Node `22.22.1` and npm `10.9.4`. Install the tarball into a
new local consumer directory; do not run `npm pack` or rebuild it:

```sh
node --version
npm --version
mkdir echo-context-preview
cd echo-context-preview
npm init -y
npm install --save-exact /absolute/path/to/echo-context-0.1.0-beta.8.tgz
./node_modules/.bin/echo-context version
./node_modules/.bin/echo-context daemon run
```

On Windows PowerShell, use the `.cmd` launcher for every ECHO Context CLI
command:

```powershell
.\node_modules\.bin\echo-context.cmd version
.\node_modules\.bin\echo-context.cmd daemon run
```

Keep the foreground daemon terminal open. In another terminal, verify it and
register the loopback MCP endpoint:

```sh
./node_modules/.bin/echo-context status
codex mcp add echo --url http://127.0.0.1:38478/mcp
claude mcp add --scope user --transport http echo http://127.0.0.1:38478/mcp
```

The Windows status command is:

```powershell
.\node_modules\.bin\echo-context.cmd status
```

If the MCP client already has an `echo` entry, update or remove that entry with
the client's own MCP command before adding it again. Start a fresh client
session, or reconnect its MCP servers, after changing the endpoint.

Installing the repository-owned usage skill and managed ECHO banners is a
separate, explicit action:

```sh
node ./node_modules/echo-context/tools/sync-agent-instructions.mjs --mcp-url http://127.0.0.1:38478/mcp
```

This preview supports foreground `daemon run` on Linux, Windows, and macOS.
There is no systemd or Windows Service installer. Managed background
installation remains macOS launchd-only, and Cursor live capture remains
retired. The supported live capture adapters are Codex and Claude Code.

## Continuous integration

Pull requests into `main` and pushes to `main` run the canonical read-only
source gate on the reviewed Node `22.22.1` and npm `10.9.4` toolchain. The gate
is also available locally from a clean, committed worktree:

```sh
npm run ci
```

That command verifies the exact toolchain and lockfile/shrinkwrap parity,
installs and verifies the pinned secret scanner, snapshots and scans complete
remote Git history plus the candidate commit, runs a clean dependency install,
type-checks, lints, runs the ordinary test suite, verifies inventory and source
authority, checks Git object integrity, and builds and verifies a temporary
deterministic source artifact. Temporary scanner and artifact files are removed
before it returns.

The separate onboarding workflow proves the portable, manual-daemon path on
fresh hosted runners:

| Runner       | Architecture | Portable proof                                                                            |
| ------------ | ------------ | ----------------------------------------------------------------------------------------- |
| Ubuntu 24.04 | x64          | tarball install, loopback daemon, Codex + Claude live capture, service API, MCP retrieval |
| Windows 2025 | x64          | tarball install, loopback daemon, Codex + Claude live capture, service API, MCP retrieval |
| macOS 15     | arm64        | tarball install, loopback daemon, Codex + Claude live capture, service API, MCP retrieval |

Each lane packs once, installs that disposable tarball into an isolated local
consumer, starts the installed `dist/cli.js` against scratch state, writes new
Codex and Claude Code turns only after health is green, and retrieves both
through raw search and normalized `find_clusters`. The tarball never leaves the
runner and is not a release or promotion artifact. Windows process termination
is forceful, so that lane proves bounded teardown and scratch cleanup rather
than graceful signal handling.

This matrix does not install a background service. Native `launchd`
installation remains macOS-only and stays in the explicit local promotion
workflow; this package has no systemd or Windows Service installer. The manual
beta workflow remains a read-only hosted tag-and-source validator, while beta
artifact construction, promotion smoke, tagging, draft creation, and
publication remain explicit local operator actions.

## Beta release gate

The minimum beta gate publishes one GitHub prerelease from one reviewed,
smoke-tested tarball. It does not publish to npm and it does not promote or cut
over a live daemon. `0.1.0-beta.6` predates this gate;
`0.1.0-beta.7` is the first candidate governed by it.

The one-time repository policy is part of the gate: create a `beta-release`
environment with at least one named user reviewer, prevent self-review, disable
administrator bypass, add exactly one selected tag rule named
`v*-beta.*`, and keep the environment free of secrets. Enable immutable
releases for the repository. `beta:draft` and `beta:publish` fail closed when
the machine-readable parts of that policy drift, and publication also requires
GitHub's approval history to name a configured reviewer other than the run's
triggering actor. On GitHub Free, Pro, and Team, required environment reviewers
are available only while this repository is public; re-check the account plan
before making it private.

First update the package, lockfile, shrinkwrap, and `src/version.ts` to one new
beta version. Merge its feature branch only after GitHub's `verify` check and an
independent approval pass on the exact branch-head commit. Once that commit is
reachable from `origin/main`, check out that reviewed commit and stage it:

```sh
npm run beta:stage
```

`beta:stage` refuses a dirty tree, an unmerged or unreviewed source commit, a
stale approval, a failed or foreign `verify` check, a reused version, or an
existing release directory. It runs canonical CI, invokes `npm pack` exactly
once, and installs and smokes that tarball exactly once in a new durable prefix.
The command prints a canonical result containing the release root, source SHA,
artifact SHA-256, and promotion-receipt SHA-256. A failed root is preserved as
evidence and cannot silently be rebuilt under the same identity.

Create a GitHub draft from those exact local bytes, substituting the absolute
`release_root` emitted above:

```sh
npm run beta:draft -- --release-root /absolute/path/from/beta-stage
```

This re-verifies the local tarball, installed tree, receipt, review, and CI
evidence; creates and pushes the exact annotated beta tag; creates a draft
prerelease containing only the tarball, checksum, and sanitized
`beta-release-manifest.v1.json`; downloads those assets again to verify the
remote draft; then dispatches the hosted gate and records the exact returned run
ID. The `beta-release` environment requires a second person to approve that
run. The hosted job creates no deployment record and performs no dependency
install, build, package smoke, artifact transfer, release access, or mutation.
It validates the checked-out tag, package version, `main` ancestry, latest
`verify` result, and current independent pull-request approval.

After the `beta-release-gate` run succeeds, publish the same draft by copying
the two confirmations from `beta-stage-result.json`:

```sh
npm run beta:publish -- \
  --release-root /absolute/path/from/beta-stage \
  --confirm-source-sha REVIEWED_40_HEX_COMMIT \
  --confirm-artifact-sha REVIEWED_64_HEX_TARBALL_SHA256
```

Publication refuses to proceed unless GitHub immutable releases are enabled,
the independently approved environment is still configured for beta tags, the
exact recorded hosted run succeeded on the same source, GitHub records an
approval from a configured reviewer other than the triggering actor, and the
local and re-downloaded remote manifests are byte-identical. It changes only
the existing GitHub draft to a prerelease, then proves the published release is
immutable and revalidates its assets. It never rebuilds, reinstalls, or
reuploads the artifact. Immediately before making the draft public, it writes a
local intent bound to the release ID, gate run, source, manifest, and tarball.
If the process stops after GitHub publishes but before the local result is
written, rerun the same command to verify and finish that exact publication;
an already-published release without the prior intent is rejected.

Founder-live and later stages reuse the exact CLI, prefix, artifact digest, and
promotion receipt already recorded inside the durable release root. For the
operator examples below, set `EXACT_CLI` to that root's
`prefix/bin/echo-context`; do not resolve it from another installation.

## Additive migration

Never point a candidate at the legacy database in place. Copy it through
SQLite's online-backup API and apply migrations only to the copy:

```sh
LEGACY_DB="$HOME/Library/Application Support/ECHO/echo.db"
COPY_DB="$HOME/.echo-context-copy/data/context.db"
"$EXACT_CLI" migrate \
  --from "$LEGACY_DB" \
  --to "$COPY_DB"
```

The command pins one read snapshot, opens the source read-only, refuses in-place
conversion and destination overwrite, verifies snapshot event-count parity and
SQLite integrity, and publishes the completed copy atomically. Event IDs,
sources, content, metadata, and embeddings are preserved. Migration 0003
canonicalizes legacy timestamps to UTC `Z`; migration 0005 additively backfills
an indexed normalized source key. The legacy database is never rewritten.

Capture is enabled by default for Codex and Claude Code. Use
`--no-capture-codex` or `--no-capture-claude` for an unused source; source paths
also have explicit CLI overrides. A missing source is reported as
optional/absent, while an existing unreadable source is unhealthy. Cursor live
capture is retired; migration preserves its existing atoms, and the retrieval
and normalization layers continue to recognize those historical records.

## Founder-live and cutover

First prove the exact installed artifact in an isolated lane. Its database,
home, port, and launchd label are intentionally separate from final authority:

```sh
FOUNDER_HOME="$HOME/.echo-context-founder-live"
"$EXACT_CLI" migrate \
  --from "$LEGACY_DB" \
  --to "$FOUNDER_HOME/data/context.db"

"$EXACT_CLI" install \
  --expected-artifact-digest "$REVIEWED_ARTIFACT_DIGEST" \
  --expected-promotion-receipt-digest "$REVIEWED_PROMOTION_RECEIPT_DIGEST" \
  --home "$FOUNDER_HOME" \
  --db "$FOUNDER_HOME/data/context.db" \
  --port 39478 \
  --label com.echo.context.candidate

"$EXACT_CLI" status --port 39478
```

Exercise health, the service API, all seven MCP tools, capture catch-up, bounded
queries, and memory use. After founder acceptance, unload only the candidate;
preserve its database and test evidence:

```sh
"$EXACT_CLI" uninstall --label com.echo.context.candidate
```

Create a fresh final copy immediately before authority transfer. The destination
must not already exist; migration never overwrites a database. The cutover gate
also rejects the copy if the legacy ledger advances after its snapshot, in which
case archive the rejected non-authority copy and migrate again:

```sh
FINAL_HOME="$HOME/.echo-context"
FINAL_DB="$FINAL_HOME/data/context.db"
"$EXACT_CLI" migrate --from "$LEGACY_DB" --to "$FINAL_DB"

"$EXACT_CLI" cutover \
  --legacy-label com.echo.daemon \
  --legacy-db "$LEGACY_DB" \
  --expected-artifact-digest "$REVIEWED_ARTIFACT_DIGEST" \
  --expected-promotion-receipt-digest "$REVIEWED_PROMOTION_RECEIPT_DIGEST" \
  --home "$FINAL_HOME" \
  --db "$FINAL_DB" \
  --label com.echo.context
```

`cutover` unloads the named legacy service when it is running, starts the exact
package at the configured endpoint, and accepts readiness only
when version, per-install nonce, verified package manifest, promotion receipt,
and database identity all match for three consecutive probes, and the launchd
PID owns the listening socket. If installation or readiness fails, it stops the candidate before it
restores and re-verifies the preserved legacy state. If legacy was already
stopped at preparation, recovery keeps its label stopped and proves the endpoint
is unowned instead of bootstrapping it. Any stop whose result cannot be proven
remains explicitly ambiguous rather than claiming rollback.

After a successful cutover, explicit rollback starts the preserved legacy
service even if it was stopped before cutover. Pass the same runtime endpoint
arguments recorded by cutover (including a nondefault port, when used):

```sh
"$EXACT_CLI" rollback \
  --legacy-label com.echo.daemon \
  --expected-artifact-digest "$REVIEWED_ARTIFACT_DIGEST" \
  --expected-promotion-receipt-digest "$REVIEWED_PROMOTION_RECEIPT_DIGEST" \
  --home "$FINAL_HOME" \
  --db "$FINAL_DB" \
  --label com.echo.context

# Idempotently converge an interrupted cutover or rollback on legacy authority.
"$EXACT_CLI" recover \
  --expected-artifact-digest "$REVIEWED_ARTIFACT_DIGEST" \
  --expected-promotion-receipt-digest "$REVIEWED_PROMOTION_RECEIPT_DIGEST" \
  --home "$FINAL_HOME"
```

Neither command deletes the legacy database or plist. `rollback` is retained as
an explicit operator action after a successful cutover. It preserves the next
database and reports whether state diverged, but does **not** reverse-merge
next-only events into the legacy database (`reverseMerged: false`). The authority
receipt at `$FINAL_HOME/state/cutover.json` records both database watermarks
and the preserved divergence window. It also binds the accepted endpoint,
artifact digest/source commit, promotion receipt digest, installed-tree digest,
Node executable, CLI and package realpaths, both database identities, and the
legacy/next plist hashes. Rollback rejects runtime endpoint
arguments that differ from this receipt; pass the original `--port` if the
accepted service did not use the default. The receipt also records whether the
legacy service was running before cutover so failure recovery is state-preserving.

## Authority and provenance

`echo-context/main` is the canonical source authority. The item-135 extraction
baseline and `provenance/runtime-inventory.v1.json` remain immutable historical
evidence. Runtime/state authority changes only after exact-artifact client-live
acceptance; until that gate succeeds, Project_echo's preserved service and
database remain the rollback authority.
