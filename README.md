# echo-context

`echo-context` is ECHO's standalone context-layer package and daemon. It owns
coding-session capture, normalization, append-only SQLite storage, bounded
retrieval, readiness health, and exactly the eight read-only context MCP tools
sealed in `context-tools.v1.json`.

It intentionally does **not** contain product coordination, Slack, backlog
workers, enrichment loops, or permanent raw filesystem-change capture.

## Runtime model

The daemon opens a compact checkpoint table before starting capture watchers.
Codex, Claude Code, and Cursor resume from those checkpoints and catch up through
coalesced, capped, serial queues. Health stays `starting` or `catching_up` until
that work completes. SQLite retrieval is paged and has hard row, stored-byte,
and scan-page budgets; free-text search advances through bounded keyset pages.

Defaults:

- home: `~/.echo-context`
- database: `~/.echo-context/data/context.db`
- MCP: `http://127.0.0.1:38478/mcp`
- health: `http://127.0.0.1:38478/healthz`
- bounded service API: `http://127.0.0.1:38478/v1/*`
- capture: Codex, Claude Code, and Cursor only

The HTTP server refuses non-loopback binds. Runtime configuration is isolated
under `ECHO_CONTEXT_*`; it does not inherit Project_echo product secrets.

## Build and package

Node `22.22.1` and npm `10.9.4` are the reviewed toolchain. Run the source gates,
commit the result, and obtain independent review before packaging. From that
clean reviewed commit, create exactly one tarball and install it exactly once
into a durable, previously nonexistent prefix:

```sh
npm ci
npm run typecheck
npm run lint
npm run test:ci
npm run verify:inventory

REVIEWED_COMMIT="$(git rev-parse HEAD)"
RELEASE_ROOT="$HOME/.local/share/echo-context/releases/0.1.0-beta.2-$REVIEWED_COMMIT"
INSTALL_PREFIX="$RELEASE_ROOT/prefix"
PROMOTION_RESULT="$RELEASE_ROOT/promotion-result.json"
mkdir -p "$RELEASE_ROOT"
npm pack --pack-destination "$RELEASE_ROOT"
npm run --silent smoke:package -- \
  "$RELEASE_ROOT/echo-context-0.1.0-beta.2.tgz" \
  --prefix "$INSTALL_PREFIX" > "$PROMOTION_RESULT"
cat "$PROMOTION_RESULT"
```

`npm pack` invokes the clean-tree package build; do not run a second build. The
smoke command installs the existing tarball as a prefix-scoped global package,
then verifies package import, migrations, manifest integrity, daemon health,
the bounded service API, the sealed eight-tool MCP roster, one tool call, and
clean shutdown. It creates the receipt directory before hashing the installed
tree, excludes only the receipt file from that tree, writes canonical receipt
bytes, and restarts the daemon under that exact receipt-bound identity. Only
after the restart is healthy does it emit the receipt SHA-256 in
`promotion-result.json`. Bind every later command to those externally recorded
smoke results and the exact executable:

```sh
PROMOTION_RECEIPT="$INSTALL_PREFIX/share/echo-context/promotion-receipt.json"
EXACT_CLI="$INSTALL_PREFIX/bin/echo-context"
REVIEWED_ARTIFACT_DIGEST="$(
  node -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(r.artifactDigest)' \
    "$PROMOTION_RESULT"
)"
REVIEWED_PROMOTION_RECEIPT_DIGEST="$(
  node -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(r.promotionReceiptDigest)' \
    "$PROMOTION_RESULT"
)"
```

Founder-live and client-live reuse `EXACT_CLI`, `INSTALL_PREFIX`, and
both reviewed digests; never rebuild or reinstall between stages. Every exact
command re-hashes the receipt bytes, package tarball, and installed tree and
requires the same real CLI, package root, prefix, Node executable, and Node
version. The shrinkwrap pins dependency tarballs, while the runtime manifest
verifies package-owned files at startup.

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

Capture is enabled by default for all three coding tools. Use
`--no-capture-codex`, `--no-capture-claude`, or `--no-capture-cursor` for an
unused source; source paths also have explicit CLI overrides. A missing source
is reported as optional/absent, while an existing unreadable source is
unhealthy.

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

Exercise health, the service API, all eight MCP tools, capture catch-up, bounded
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
