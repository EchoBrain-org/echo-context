# echo-context

`echo-context` is ECHO's independently usable context-source repository. It
contains generic capture, normalization, append-only storage,
clustering/retrieval, permissions and health support, and the eight read-only
context MCP tools sealed in `context-tools.v1.json`.

## Authority boundary

After item 136 lands, `echo-context/main` is the canonical **source** authority
and its versioned source archive is the canonical **source-artifact** authority.
It is still an internal asset at maturity `DEV`:

- `installable: false`
- `installed: false`
- `runtime_authority: false`
- `state_authority: false`

Project_echo continues to own the active daemon, live context state, client MCP
endpoint, backup, and rollback. Nothing in this repository changes a machine
client, launches a service, reads a live database, or grants runtime authority.
The source archive is verification material for the separately reviewed item
137 installer; it is not an installer or a commercial package.

## Development checks

Node `22.22.1` and npm `10.9.4` are the reviewed toolchain. A clean clone runs:

```sh
npm ci
npm run typecheck
npm run lint
npm run test:ci
npm run verify:inventory
npm run verify:authority
```

`npm run test:operator` is intentionally separate. It requires explicit
`ECHO_SOURCE_GIT_DIR` and `ECHO_SOURCE_SHA` values and replays the accepted
item-135 proof against pinned Project_echo Git objects. It is not part of the
source-only clean-clone acceptance.

`tools/fresh-clone-acceptance.sh` is the authoritative local, source-only
acceptance entrypoint. Immediately before entering its scrubbed, credential-free
environment, the operator captures the complete advertised source-ref namespace
with `git fetch origin '+refs/*:refs/echo-scan/*'` and installs the reviewed
scanner into that sandbox using `tools/install-gitleaks.sh <HOME>/bin`; the
acceptance scanner then uses only the pinned `<HOME>/bin/gitleaks` and local refs
and performs no authenticated network operation.
`npm run build:artifact -- --source-sha <sha> --out <directory>` creates one
deterministic, explicitly non-installable source archive and its checksum and
manifest sidecars from committed Git objects only.

Item 136 intentionally contains no GitHub Actions workflow, hosted gate,
publication controller, tag, GitHub Release, or hosted artifact. Those controls
are deferred to separately reviewed item 140.

## Provenance

The extraction accepted by item 135 remains frozen at commit
`0cf7b006eba665c0bf55e82ff04da70f19f01ebb`, tree
`70c5cf8352652b3c4c1dce68cd1a5e40d44e4b05`, and exactly 190 tracked paths.
`provenance/extraction-baseline.v1.json` seals that object; successor checks
require it to be an ancestor without rewriting any item-135 evidence bytes.
