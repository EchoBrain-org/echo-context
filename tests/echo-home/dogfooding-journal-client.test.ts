import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface JournalClientModule {
  appendJournalEntry(options: {
    actor: string;
    registryPath: string;
    entry: Record<string, string>;
    fetchImpl: typeof fetch;
  }): Promise<Record<string, unknown>>;
  createJournal(options: {
    registryPath: string;
    journalDir: string;
    fetchImpl: typeof fetch;
  }): Promise<Record<string, unknown>>;
  resolveJournal(options: {
    actor: string;
    registryPath: string;
    fetchImpl: typeof fetch;
    updateCurrent?: boolean;
  }): Promise<Record<string, unknown>>;
}

const clientUrl = new URL(
  "../../tools/dogfooding/journal-client.mjs",
  import.meta.url,
).href;
const client = (await import(clientUrl)) as JournalClientModule;

const VERSION = "0.1.0-beta.6";
const DIGEST = "a".repeat(64);
let scratch: string;
let journalRoot: string;
let journalDir: string;
let registryPath: string;

const healthyFetch = (async () =>
  new Response(
    JSON.stringify({
      status: "healthy",
      components: {
        runtime: {
          details: {
            version: VERSION,
            artifact_digest: DIGEST,
          },
        },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as typeof fetch;

function identityFetch(version: string, digest: string): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        status: "healthy",
        components: {
          runtime: {
            details: {
              version,
              artifact_digest: digest,
            },
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
}

function writeRegistry(
  journals: Record<string, unknown>,
  currentVersion?: string,
): void {
  const state = join(journalRoot, "state");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  registryPath = join(state, "dogfooding-journals.json");
  writeFileSync(
    registryPath,
    `${JSON.stringify(
      {
        schema_version: 1,
        enabled: true,
        mcp_url: "http://127.0.0.1:39478/mcp",
        health_url: "http://127.0.0.1:39478/healthz",
        journal_root: journalRoot,
        current_version: currentVersion,
        journals,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  chmodSync(registryPath, 0o600);
}

function seedJournal(): void {
  journalDir = join(journalRoot, "releases", `${VERSION}-source`, "dogfooding");
  mkdirSync(journalDir, { recursive: true, mode: 0o700 });
  for (const file of ["JOURNAL.md", "codex.md", "claude.md"]) {
    writeFileSync(join(journalDir, file), `# ${file}\n\n## Interactions\n`, {
      mode: 0o600,
    });
  }
  writeRegistry({
    [VERSION]: {
      artifact_digest: DIGEST,
      journal_dir: journalDir,
      created_at: "2026-07-29T17:00:00Z",
    },
  });
}

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "echo-context-dogfood-")));
  journalRoot = join(scratch, "share", "echo-context");
  mkdirSync(journalRoot, { recursive: true, mode: 0o700 });
  registryPath = join(journalRoot, "state", "dogfooding-journals.json");
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("version-bound dogfooding journal client", () => {
  it("resolves by live version and artifact digest and updates only the convenience pointer", async () => {
    seedJournal();
    const result = await client.resolveJournal({
      actor: "codex",
      registryPath,
      fetchImpl: healthyFetch,
    });
    expect(result).toMatchObject({
      status: "ready",
      version: VERSION,
      artifact_digest: DIGEST,
      actor: "codex",
      shard: join(journalDir, "codex.md"),
    });
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    expect(registry.current_version).toBe(VERSION);
    expect(statSync(registryPath).mode & 0o777).toBe(0o600);
  });

  it("returns the exact founder prompt without creating or reusing a journal", async () => {
    writeRegistry({});
    const before = readdirSync(journalRoot, { recursive: true }).sort();
    const result = await client.resolveJournal({
      actor: "claude",
      registryPath,
      fetchImpl: healthyFetch,
    });
    expect(result).toEqual({
      status: "needs_confirmation",
      version: VERSION,
      artifact_digest: DIGEST,
      prompt:
        "ECHO runtime 0.1.0-beta.6 has no dogfooding journal. Create it now and make it current?",
    });
    expect(readdirSync(journalRoot, { recursive: true }).sort()).toEqual(
      before,
    );
  });

  it("fails closed on a same-version artifact conflict", async () => {
    seedJournal();
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    registry.journals[VERSION].artifact_digest = "b".repeat(64);
    writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, {
      mode: 0o600,
    });
    await expect(
      client.resolveJournal({
        actor: "codex",
        registryPath,
        fetchImpl: healthyFetch,
      }),
    ).rejects.toThrow(
      "runtime 0.1.0-beta.6 artifact digest conflicts with its existing journal mapping",
    );
  });

  it("requires the nested runtime version instead of a top-level fallback", async () => {
    seedJournal();
    const incompleteFetch = (async () =>
      new Response(
        JSON.stringify({
          version: VERSION,
          components: {
            runtime: { details: { artifact_digest: DIGEST } },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    await expect(
      client.resolveJournal({
        actor: "codex",
        registryPath,
        fetchImpl: incompleteFetch,
      }),
    ).rejects.toThrow("live ECHO health has no valid runtime version");
  });

  it("requires MCP and health identity to use the same loopback origin", async () => {
    seedJournal();
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    registry.health_url = "http://127.0.0.1:39479/healthz";
    writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, {
      mode: 0o600,
    });
    await expect(
      client.resolveJournal({
        actor: "codex",
        registryPath,
        fetchImpl: healthyFetch,
      }),
    ).rejects.toThrow("MCP and health URLs do not share an origin");
  });

  it("serializes a compact revalidated append into the correct actor shard", async () => {
    seedJournal();
    const result = await client.appendJournalEntry({
      actor: "claude",
      registryPath,
      fetchImpl: healthyFetch,
      entry: {
        timestamp: "2026-07-29 11:30 -07:00",
        trigger: "Founder asked for current context",
        query_inputs: "health preflight; find_clusters grouped by project",
        returned: "one project group and two representative IDs",
        sources: "Codex and Claude Code",
        verdict: "right — the active thread surfaced first",
        note: "The grouped result was concise.",
      },
    });
    expect(result).toMatchObject({
      status: "appended",
      actor: "claude",
      shard: join(journalDir, "claude.md"),
    });
    const shard = readFileSync(join(journalDir, "claude.md"), "utf8");
    expect(shard).toContain("Founder asked for current context");
    expect(shard).toContain(`\`${DIGEST}\``);
    expect(statSync(join(journalDir, "claude.md")).mode & 0o777).toBe(0o600);
    expect(readdirSync(journalDir)).not.toContain(".append.lock");
  });

  it("creates only Codex and Claude shards in an explicit accepted release directory", async () => {
    writeRegistry({});
    const releaseDir = join(journalRoot, "releases", `${VERSION}-accepted`);
    mkdirSync(releaseDir, { recursive: true, mode: 0o700 });
    const requested = join(releaseDir, "dogfooding");
    const result = await client.createJournal({
      registryPath,
      journalDir: requested,
      fetchImpl: healthyFetch,
    });
    expect(result).toMatchObject({
      status: "ready",
      version: VERSION,
      artifact_digest: DIGEST,
    });
    expect(readdirSync(requested).sort()).toEqual([
      "JOURNAL.md",
      "claude.md",
      "codex.md",
    ]);
    expect(statSync(requested).mode & 0o777).toBe(0o700);
    for (const file of readdirSync(requested)) {
      expect(statSync(join(requested, file)).mode & 0o777).toBe(0o600);
    }
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    expect(registry.journals[VERSION]).toMatchObject({
      artifact_digest: DIGEST,
      journal_dir: requested,
    });
  });

  it("preserves a concurrently created version when an older resolve updates current_version", async () => {
    seedJournal();
    let releaseFirstFetch!: () => void;
    let announceFirstFetch!: () => void;
    const firstFetchStarted = new Promise<void>((resolve) => {
      announceFirstFetch = resolve;
    });
    const firstFetchRelease = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });
    const delayedBeta6Fetch = (async () => {
      announceFirstFetch();
      await firstFetchRelease;
      return identityFetch(VERSION, DIGEST)("http://127.0.0.1:39478/healthz");
    }) as typeof fetch;

    const beta6Resolve = client.resolveJournal({
      actor: "codex",
      registryPath,
      fetchImpl: delayedBeta6Fetch,
    });
    await firstFetchStarted;

    const beta7 = "0.1.0-beta.7";
    const beta7Digest = "b".repeat(64);
    const beta7Release = join(journalRoot, "releases", `${beta7}-accepted`);
    mkdirSync(beta7Release, { recursive: true, mode: 0o700 });
    await client.createJournal({
      registryPath,
      journalDir: join(beta7Release, "dogfooding"),
      fetchImpl: identityFetch(beta7, beta7Digest),
    });

    releaseFirstFetch();
    await expect(beta6Resolve).resolves.toMatchObject({
      status: "ready",
      version: VERSION,
    });
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    expect(Object.keys(registry.journals).sort()).toEqual(
      [VERSION, beta7].sort(),
    );
    expect(registry.journals[beta7]).toMatchObject({
      artifact_digest: beta7Digest,
    });
  });

  it("recovers an exact helper-created directory when registry publication was interrupted", async () => {
    writeRegistry({});
    const releaseDir = join(journalRoot, "releases", `${VERSION}-accepted`);
    const requested = join(releaseDir, "dogfooding");
    mkdirSync(requested, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(requested, "JOURNAL.md"),
      `# recovered\n\n- version: \`${VERSION}\`\n- digest: \`${DIGEST}\`\n`,
    );
    writeFileSync(join(requested, "codex.md"), "# Codex\n\n## Interactions\n");
    writeFileSync(
      join(requested, "claude.md"),
      "# Claude\n\n## Interactions\n",
    );

    await expect(
      client.createJournal({
        registryPath,
        journalDir: requested,
        fetchImpl: healthyFetch,
      }),
    ).resolves.toMatchObject({ status: "ready", version: VERSION });
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    expect(registry.journals[VERSION].journal_dir).toBe(requested);
    expect(statSync(join(requested, "JOURNAL.md")).mode & 0o777).toBe(0o600);
  });

  it("rejects journal mappings outside the configured root", async () => {
    const outside = join(scratch, "outside");
    mkdirSync(outside, { mode: 0o700 });
    for (const file of ["JOURNAL.md", "codex.md", "claude.md"]) {
      writeFileSync(join(outside, file), "# outside\n", { mode: 0o600 });
    }
    writeRegistry({
      [VERSION]: {
        artifact_digest: DIGEST,
        journal_dir: outside,
      },
    });
    await expect(
      client.resolveJournal({
        actor: "codex",
        registryPath,
        fetchImpl: healthyFetch,
      }),
    ).rejects.toThrow("escapes journal_root");
  });

  it("refuses creation outside exact accepted release evidence", async () => {
    writeRegistry({});
    const looseParent = join(journalRoot, "misc");
    mkdirSync(looseParent, { recursive: true, mode: 0o700 });
    await expect(
      client.createJournal({
        registryPath,
        journalDir: join(looseParent, "dogfooding"),
        fetchImpl: healthyFetch,
      }),
    ).rejects.toThrow(
      "must be releases/<accepted-release>/dogfooding beneath journal_root",
    );
  });
});
