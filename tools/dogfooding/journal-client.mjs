#!/usr/bin/env node

import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";

const ACTORS = new Set(["codex", "claude"]);
const DIGEST = /^[a-f0-9]{64}$/u;
const VERSION = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const MAX_REGISTRY_BYTES = 1024 * 1024;
const MAX_ENTRY_BYTES = 32 * 1024;

function fail(message) {
  throw new Error(message);
}

function registryPathForHome(userHome) {
  return join(
    userHome,
    ".local",
    "share",
    "echo-context",
    "state",
    "dogfooding-journals.json",
  );
}

function assertActor(actor) {
  if (!ACTORS.has(actor))
    fail(`actor must be codex or claude: ${String(actor)}`);
}

function assertRegular(path, label) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`${label} is not a regular file: ${path}`);
  }
}

function realDirectory(path, label) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`${label} is not a real directory: ${path}`);
  }
  return realpathSync(path);
}

function isContained(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function localHealthUrl(value) {
  if (typeof value !== "string") return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const loopback =
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "localhost" ||
    parsed.hostname === "[::1]";
  if (
    !loopback ||
    parsed.protocol !== "http:" ||
    parsed.pathname !== "/healthz" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return null;
  }
  return parsed.toString().replace(/\/$/, "");
}

function localMcpUrl(value) {
  if (typeof value !== "string") return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const loopback =
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "localhost" ||
    parsed.hostname === "[::1]";
  if (
    !loopback ||
    parsed.protocol !== "http:" ||
    parsed.pathname !== "/mcp" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return null;
  }
  return parsed.toString().replace(/\/$/, "");
}

function atomicWrite(path, content, mode = 0o600) {
  if (existsSync(path)) assertRegular(path, "atomic-write target");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    writeFileSync(temporary, content, { mode });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // best effort
    }
    throw error;
  }
}

export function loadRegistry(registryPath) {
  if (!existsSync(registryPath)) return { status: "disabled", registry: null };
  assertRegular(registryPath, "dogfooding registry");
  const stat = statSync(registryPath);
  if (stat.size > MAX_REGISTRY_BYTES)
    fail("dogfooding registry exceeds byte budget");
  let registry;
  try {
    registry = JSON.parse(readFileSync(registryPath, "utf8"));
  } catch {
    fail(`dogfooding registry is malformed: ${registryPath}`);
  }
  if (registry?.enabled === false) return { status: "disabled", registry };
  if (
    registry?.schema_version !== 1 ||
    registry?.enabled !== true ||
    typeof registry?.journals !== "object" ||
    registry.journals === null ||
    localMcpUrl(registry.mcp_url) === null ||
    localHealthUrl(registry.health_url) === null ||
    typeof registry.journal_root !== "string" ||
    !isAbsolute(registry.journal_root)
  ) {
    fail(`dogfooding registry has an invalid schema: ${registryPath}`);
  }
  if (
    new URL(registry.mcp_url).origin !== new URL(registry.health_url).origin
  ) {
    fail(`dogfooding registry MCP and health URLs do not share an origin`);
  }
  return { status: "enabled", registry };
}

export async function readLiveIdentity(registry, fetchImpl = fetch) {
  const healthUrl = localHealthUrl(registry.health_url);
  if (healthUrl === null) fail("dogfooding registry has an invalid health_url");
  let response;
  try {
    response = await fetchImpl(healthUrl, {
      signal: AbortSignal.timeout(3_000),
    });
  } catch (error) {
    fail(
      `could not fetch live ECHO health: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (!response.ok) fail(`live ECHO health returned HTTP ${response.status}`);
  const body = await response.json();
  const version = body?.components?.runtime?.details?.version;
  const artifactDigest = body?.components?.runtime?.details?.artifact_digest;
  if (typeof version !== "string" || !VERSION.test(version)) {
    fail("live ECHO health has no valid runtime version");
  }
  if (typeof artifactDigest !== "string" || !DIGEST.test(artifactDigest)) {
    fail("live ECHO health has no valid artifact digest");
  }
  return { version, artifact_digest: artifactDigest };
}

function prompt(version) {
  return `ECHO runtime ${version} has no dogfooding journal. Create it now and make it current?`;
}

function validateMapping(registry, identity, actor) {
  const mapping = registry.journals[identity.version];
  if (mapping === undefined) {
    return {
      status: "needs_confirmation",
      ...identity,
      prompt: prompt(identity.version),
    };
  }
  if (typeof mapping !== "object" || mapping === null) {
    fail(`journal mapping is malformed: ${identity.version}`);
  }
  if (mapping.artifact_digest !== identity.artifact_digest) {
    fail(
      `runtime ${identity.version} artifact digest conflicts with its existing journal mapping`,
    );
  }

  const root = realDirectory(registry.journal_root, "journal root");
  if (
    typeof mapping.journal_dir !== "string" ||
    !isAbsolute(mapping.journal_dir)
  ) {
    fail(`journal mapping has no absolute journal_dir: ${identity.version}`);
  }
  const journalDir = realDirectory(mapping.journal_dir, "version journal");
  if (!isContained(root, journalDir))
    fail("version journal escapes journal_root");
  const index = join(journalDir, "JOURNAL.md");
  const shard = join(journalDir, `${actor}.md`);
  assertRegular(index, "version journal index");
  assertRegular(shard, "version journal actor shard");
  return {
    status: "ready",
    ...identity,
    journal_dir: journalDir,
    journal_index: index,
    actor,
    shard,
  };
}

function acquireLock(lockPath, label) {
  const waitArray = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 2_000;
  while (true) {
    try {
      return openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let age;
      try {
        age = Date.now() - statSync(lockPath).mtimeMs;
      } catch (statError) {
        if (statError?.code === "ENOENT") continue;
        throw statError;
      }
      if (age > 30_000)
        fail(`stale ${label} lock requires inspection: ${lockPath}`);
      if (Date.now() >= deadline)
        fail(`timed out waiting for ${label} lock: ${lockPath}`);
      Atomics.wait(waitArray, 0, 0, 20);
    }
  }
}

async function acquireLockAsync(lockPath, label) {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      return openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let age;
      try {
        age = Date.now() - statSync(lockPath).mtimeMs;
      } catch (statError) {
        if (statError?.code === "ENOENT") continue;
        throw statError;
      }
      if (age > 30_000)
        fail(`stale ${label} lock requires inspection: ${lockPath}`);
      if (Date.now() >= deadline)
        fail(`timed out waiting for ${label} lock: ${lockPath}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
  }
}

async function withLock(lockPath, label, operation) {
  const fd = await acquireLockAsync(lockPath, label);
  try {
    return await operation();
  } finally {
    closeSync(fd);
    unlinkSync(lockPath);
  }
}

async function revalidateAndUpdateCurrent(registryPath, identity, actor) {
  return withLock(`${registryPath}.lock`, "dogfooding registry", async () => {
    const loaded = loadRegistry(registryPath);
    if (loaded.status !== "enabled") return { status: "disabled" };
    const resolved = validateMapping(loaded.registry, identity, actor);
    if (
      resolved.status === "ready" &&
      loaded.registry.current_version !== identity.version
    ) {
      const updated = {
        ...loaded.registry,
        current_version: identity.version,
      };
      atomicWrite(registryPath, `${JSON.stringify(updated, null, 2)}\n`);
    }
    return resolved;
  });
}

export async function resolveJournal({
  actor,
  registryPath,
  fetchImpl = fetch,
  updateCurrent = true,
}) {
  assertActor(actor);
  const loaded = loadRegistry(registryPath);
  if (loaded.status === "disabled") return { status: "disabled" };
  const identity = await readLiveIdentity(loaded.registry, fetchImpl);
  const resolved = validateMapping(loaded.registry, identity, actor);
  if (resolved.status === "ready" && updateCurrent) {
    return revalidateAndUpdateCurrent(registryPath, identity, actor);
  }
  return resolved;
}

function journalIndex(identity) {
  return [
    `# ECHO Context ${identity.version} dogfooding journal`,
    "",
    "- Status: active",
    `- Started: \`${new Date().toISOString().slice(0, 10)}\``,
    `- Runtime version: \`${identity.version}\``,
    `- Artifact digest: \`${identity.artifact_digest}\``,
    "",
    "## Actor shards",
    "",
    "- [Codex](codex.md)",
    "- [Claude Code](claude.md)",
    "",
    "Entries are founder-live observations. One entry may cover several ECHO calls",
    "made for one user task.",
    "",
  ].join("\n");
}

function actorShard(identity, actor) {
  const title = actor === "codex" ? "Codex" : "Claude Code";
  return [
    `# ECHO Context ${identity.version} — ${title} dogfooding`,
    "",
    "## Interactions",
    "",
  ].join("\n");
}

async function createJournalLocked({
  registryPath,
  journalDir,
  fetchImpl = fetch,
}) {
  const loaded = loadRegistry(registryPath);
  if (loaded.status !== "enabled") fail("dogfooding registry is not enabled");
  const identity = await readLiveIdentity(loaded.registry, fetchImpl);
  const prior = loaded.registry.journals[identity.version];
  if (prior !== undefined) {
    if (prior.artifact_digest !== identity.artifact_digest) {
      fail(`runtime ${identity.version} already maps to a different artifact`);
    }
    return validateMapping(loaded.registry, identity, "codex");
  }

  if (!isAbsolute(journalDir)) fail("journal directory must be absolute");
  const root = realDirectory(loaded.registry.journal_root, "journal root");
  const requestedInput = resolve(journalDir);
  const parent = realDirectory(dirname(requestedInput), "journal parent");
  const requested = join(parent, basename(requestedInput));
  if (!isContained(root, parent) || !isContained(root, requested)) {
    fail("requested journal directory escapes journal_root");
  }
  const releaseParts = relative(root, requested).split(sep);
  if (
    releaseParts.length !== 3 ||
    releaseParts[0] !== "releases" ||
    releaseParts[2] !== "dogfooding"
  ) {
    fail(
      "journal directory must be releases/<accepted-release>/dogfooding beneath journal_root",
    );
  }
  const releases = realDirectory(
    join(root, "releases"),
    "accepted release evidence root",
  );
  if (dirname(parent) !== releases) {
    fail("accepted release directory does not resolve beneath journal_root");
  }
  const expectedFiles = ["JOURNAL.md", "claude.md", "codex.md"];
  if (existsSync(requested)) {
    const recovered = realDirectory(requested, "recoverable version journal");
    if (!isContained(root, recovered))
      fail("existing journal escapes journal_root");
    const files = readdirSync(recovered).sort();
    if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) {
      fail(
        `existing journal is not a recoverable helper-created directory: ${requested}`,
      );
    }
    for (const file of expectedFiles) {
      assertRegular(join(recovered, file), "recoverable journal file");
    }
    const index = readFileSync(join(recovered, "JOURNAL.md"), "utf8");
    if (
      !index.includes(`\`${identity.version}\``) ||
      !index.includes(`\`${identity.artifact_digest}\``)
    ) {
      fail("recoverable journal identity does not match the live runtime");
    }
    chmodSync(recovered, 0o700);
    for (const file of expectedFiles) chmodSync(join(recovered, file), 0o600);
  } else {
    const staging = join(
      parent,
      `.${basename(requested)}.${process.pid}.${randomUUID().slice(0, 8)}.creating`,
    );
    mkdirSync(staging, { mode: 0o700 });
    chmodSync(staging, 0o700);
    try {
      atomicWrite(join(staging, "JOURNAL.md"), journalIndex(identity));
      atomicWrite(join(staging, "codex.md"), actorShard(identity, "codex"));
      atomicWrite(join(staging, "claude.md"), actorShard(identity, "claude"));
      renameSync(staging, requested);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }

  try {
    const updated = {
      ...loaded.registry,
      current_version: identity.version,
      journals: {
        ...loaded.registry.journals,
        [identity.version]: {
          artifact_digest: identity.artifact_digest,
          journal_dir: requested,
          created_at: new Date().toISOString(),
        },
      },
    };
    atomicWrite(registryPath, `${JSON.stringify(updated, null, 2)}\n`);
  } catch (error) {
    fail(
      `journal registry update stopped with recoverable files at ${requested}: ${
        error instanceof Error ? error.message : error
      }`,
    );
  }
  return validateMapping(
    {
      ...loaded.registry,
      journals: {
        ...loaded.registry.journals,
        [identity.version]: {
          artifact_digest: identity.artifact_digest,
          journal_dir: requested,
        },
      },
    },
    identity,
    "codex",
  );
}

export async function createJournal(options) {
  return withLock(
    `${options.registryPath}.lock`,
    "dogfooding registry",
    async () => createJournalLocked(options),
  );
}

function compact(value, label, maximum) {
  if (typeof value !== "string") fail(`${label} must be a string`);
  const result = value.replace(/\0/gu, "").replace(/\s+/gu, " ").trim();
  if (result.length === 0) fail(`${label} must not be empty`);
  if (result.length > maximum) fail(`${label} exceeds ${maximum} characters`);
  return result;
}

export function renderEntry(entry, identity) {
  const timestamp = compact(entry.timestamp, "timestamp", 64);
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/u.test(timestamp)) {
    fail("timestamp must carry an explicit offset");
  }
  const trigger = compact(entry.trigger, "trigger", 2_000);
  const queryInputs = compact(entry.query_inputs, "query_inputs", 4_000);
  const returned = compact(entry.returned, "returned", 4_000);
  const sources = compact(entry.sources, "sources", 3_000);
  const verdict = compact(entry.verdict, "verdict", 1_000);
  if (!/^(right|partial|wrong)(?:\s|$|—|-)/u.test(verdict)) {
    fail("verdict must begin with right, partial, or wrong");
  }
  const note = compact(entry.note, "note", 4_000);
  const conjecture =
    entry.conjecture === undefined
      ? null
      : compact(entry.conjecture, "conjecture", 3_000);
  const lines = [
    "",
    `### ${timestamp} — ${trigger.slice(0, 160)}`,
    "",
    `- **Runtime:** \`${identity.version}\` (\`${identity.artifact_digest}\`)`,
    `- **Trigger:** ${trigger}`,
    `- **Query inputs:** ${queryInputs}`,
    `- **Returned:** ${returned}`,
    `- **Sources:** ${sources}`,
    `- **Verdict:** ${verdict}`,
    `- **Note:** ${note}`,
  ];
  if (conjecture !== null) lines.push(`- **Conjecture:** ${conjecture}`);
  lines.push("");
  const rendered = `${lines.join("\n")}\n`;
  if (Buffer.byteLength(rendered) > MAX_ENTRY_BYTES)
    fail("rendered entry exceeds byte budget");
  return rendered;
}

export async function appendJournalEntry({
  actor,
  registryPath,
  entry,
  fetchImpl = fetch,
}) {
  const resolved = await resolveJournal({
    actor,
    registryPath,
    fetchImpl,
    updateCurrent: true,
  });
  if (resolved.status !== "ready") return resolved;
  const rendered = renderEntry(entry, resolved);
  const lockPath = join(resolved.journal_dir, ".append.lock");
  const fd = acquireLock(lockPath, "dogfooding append");
  let shardFd;
  try {
    shardFd = openSync(resolved.shard, "a", 0o600);
    appendFileSync(shardFd, rendered, { encoding: "utf8" });
    chmodSync(resolved.shard, 0o600);
    fsyncSync(shardFd);
  } finally {
    if (shardFd !== undefined) closeSync(shardFd);
    closeSync(fd);
    unlinkSync(lockPath);
  }
  return {
    status: "appended",
    version: resolved.version,
    artifact_digest: resolved.artifact_digest,
    actor,
    shard: resolved.shard,
    bytes: Buffer.byteLength(rendered),
  };
}

function parseArgs(argv) {
  const parsed = {
    command: argv[0],
    actor: undefined,
    journalDir: undefined,
    registryPath: registryPathForHome(homedir()),
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--actor" || arg === "--journal-dir" || arg === "--registry") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--"))
        fail(`${arg} requires a value`);
      if (arg === "--actor") parsed.actor = value;
      if (arg === "--journal-dir") parsed.journalDir = value;
      if (arg === "--registry") parsed.registryPath = resolve(value);
      index += 1;
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    let result;
    if (args.command === "resolve") {
      result = await resolveJournal({
        actor: args.actor,
        registryPath: args.registryPath,
      });
    } else if (args.command === "create") {
      if (args.journalDir === undefined) fail("create requires --journal-dir");
      result = await createJournal({
        registryPath: args.registryPath,
        journalDir: resolve(args.journalDir),
      });
    } else if (args.command === "append") {
      const input = readFileSync(0);
      if (input.length > MAX_ENTRY_BYTES)
        fail("entry input exceeds byte budget");
      result = await appendJournalEntry({
        actor: args.actor,
        registryPath: args.registryPath,
        entry: JSON.parse(input.toString("utf8")),
      });
    } else {
      fail("usage: journal-client.mjs resolve|create|append [options]");
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status === "needs_confirmation") process.exitCode = 2;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
