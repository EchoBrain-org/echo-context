import { execFile } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  startClaudeCodeExtractor,
  type ClaudeCodeExtractorHandle,
} from "../../src/capture/extractors/claude-code.js";
import {
  startCodexExtractor,
  type CodexExtractorHandle,
} from "../../src/capture/extractors/codex.js";
import { CAPTURED_SOURCES } from "../../src/capture/sources.js";
import { findClusters } from "../../src/mcp/tools/find-clusters.js";
import { echoResolveMru } from "../../src/mcp/tools/echo-resolve-mru.js";
import { searchMemories } from "../../src/mcp/tools/search-memories.js";
import { waitForNewTurns } from "../../src/mcp/tools/wait-for-new-turns.js";
import { resolveRepoPath } from "../../src/mcp/util/repo-path.js";
import {
  canonicalizePath,
  projectKeyForCanonicalRoot,
} from "../../src/project-identity.js";
import type {
  AppendOptions,
  CaptureEvent,
  EventId,
} from "../../src/storage/interface.js";
import { MemoryStorage } from "../../src/storage/memory.js";
import {
  resetAllowlist,
  restoreFsPaths,
  snapshotFsPaths,
} from "../fixtures/allowlist.js";
import { waitFor, writeJsonl } from "../fixtures/jsonl.js";

const execFileP = promisify(execFile);

interface ClaudeLine {
  type: "user" | "assistant";
  sessionId: string;
  cwd: string;
  message: { role: "user" | "assistant"; content: unknown };
  uuid: string;
  timestamp: string;
}

interface CodexLine {
  timestamp: string;
  type: string;
  payload: Record<string, unknown>;
}

class RetargetAfterFirstAppendStorage extends MemoryStorage {
  private retargeted = false;

  constructor(private readonly retarget: () => void) {
    super();
  }

  override async append(
    event: Omit<CaptureEvent, "id">,
    options?: AppendOptions,
  ): Promise<EventId> {
    const id = await super.append(event, options);
    if (!this.retargeted) {
      this.retargeted = true;
      this.retarget();
    }
    return id;
  }
}

describe("canonical_root capture stamping", () => {
  let cleanupDirs: string[];
  let originalFsPaths: string[];
  let claudeHandle: ClaudeCodeExtractorHandle | null;
  let codexHandle: CodexExtractorHandle | null;

  beforeEach(() => {
    cleanupDirs = [];
    originalFsPaths = snapshotFsPaths();
    claudeHandle = null;
    codexHandle = null;
  });

  afterEach(async () => {
    if (claudeHandle !== null) await claudeHandle.stop();
    if (codexHandle !== null) await codexHandle.stop();
    resetAllowlist();
    restoreFsPaths(originalFsPaths);
    for (const dir of cleanupDirs)
      rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(prefix: string): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    cleanupDirs.push(dir);
    return dir;
  }

  async function makeRepo(prefix: string): Promise<string> {
    const repo = tempDir(prefix);
    await execFileP("git", ["init", "-q", "-b", "main"], { cwd: repo });
    await execFileP("git", ["config", "user.email", "test@example.com"], {
      cwd: repo,
    });
    await execFileP("git", ["config", "user.name", "Test"], { cwd: repo });
    await execFileP("git", ["config", "commit.gpgsign", "false"], {
      cwd: repo,
    });
    return repo;
  }

  function claudeUser(repo: string, text: string, uuid: string): ClaudeLine {
    return {
      type: "user",
      sessionId: "claude-session",
      cwd: repo,
      message: { role: "user", content: text },
      uuid,
      timestamp: new Date().toISOString(),
    };
  }

  function claudeAssistant(
    repo: string,
    text: string,
    uuid: string,
  ): ClaudeLine {
    return {
      type: "assistant",
      sessionId: "claude-session",
      cwd: repo,
      message: { role: "assistant", content: [{ type: "text", text }] },
      uuid,
      timestamp: new Date().toISOString(),
    };
  }

  function codexSessionMeta(repo: string): CodexLine {
    return {
      timestamp: new Date().toISOString(),
      type: "session_meta",
      payload: {
        id: "019de2b0-6551-7682-a51b-2affaa0a7bbf",
        cwd: repo,
      },
    };
  }

  function codexMessage(role: "user" | "assistant", text: string): CodexLine {
    return {
      timestamp: new Date().toISOString(),
      type: "response_item",
      payload: {
        type: "message",
        role,
        content: [
          { type: role === "user" ? "input_text" : "output_text", text },
        ],
      },
    };
  }

  it("claude_code keeps the observed nested cwd but stamps the repository project root", async () => {
    const repo = await makeRepo("echo-canonical-cc-repo-");
    const nestedCwd = join(repo, "packages", "app");
    mkdirSync(nestedCwd, { recursive: true });
    const root = tempDir("echo-canonical-cc-home-");
    const projectsPrefix = `${root}/projects/`;
    const projectDir = join(projectsPrefix, "repo");
    mkdirSync(projectDir, { recursive: true });
    (CAPTURED_SOURCES.fs_paths as unknown as string[]).push(`${root}/`);
    const storage = new MemoryStorage();
    claudeHandle = await startClaudeCodeExtractor(storage, { projectsPrefix });

    writeJsonl(join(projectDir, "session.jsonl"), [
      claudeUser(nestedCwd, "Q1", "u1"),
      claudeAssistant(nestedCwd, "A1", "a1"),
      claudeUser(nestedCwd, "Q2", "u2"),
    ]);
    await waitFor(async () => (await storage.count()) >= 1);

    const event = (await storage.query({ order: "asc" }))[0]!;
    const metadata = event.metadata as Record<string, unknown>;
    expect(metadata["repo_root"]).toBe(nestedCwd);
    const canonicalRoot = await canonicalizePath(repo);
    expect(metadata["canonical_root"]).toBe(canonicalRoot);
    expect(metadata["project_key"]).toBe(
      projectKeyForCanonicalRoot(canonicalRoot),
    );
  });

  it("codex stamps metadata.canonical_root from cwd/repo_root", async () => {
    const repo = await makeRepo("echo-canonical-codex-repo-");
    const root = tempDir("echo-canonical-codex-home-");
    const sessionsPrefix = `${root}/.codex/sessions/`;
    const sessionDir = join(sessionsPrefix, "2026/06/07");
    mkdirSync(sessionDir, { recursive: true });
    (CAPTURED_SOURCES.fs_paths as unknown as string[]).push(sessionsPrefix);
    const storage = new MemoryStorage();
    codexHandle = await startCodexExtractor(storage, { sessionsPrefix });

    writeJsonl(join(sessionDir, "rollout-2026-06-07T12-00-00-demo.jsonl"), [
      codexSessionMeta(repo),
      codexMessage("user", "Q1"),
      codexMessage("assistant", "A1"),
      codexMessage("user", "Q2"),
    ]);
    await waitFor(async () => (await storage.count()) >= 1);

    const event = (await storage.query({ order: "asc" }))[0]!;
    const metadata = event.metadata as Record<string, unknown>;
    expect(metadata["cwd"]).toBe(repo);
    expect(metadata["repo_root"]).toBe(repo);
    const canonicalRoot = await canonicalizePath(repo);
    expect(metadata["canonical_root"]).toBe(canonicalRoot);
    expect(metadata["project_key"]).toBe(
      projectKeyForCanonicalRoot(canonicalRoot),
    );
  });

  it("keeps one canonical project identity across a Codex extraction batch", async () => {
    const firstRepo = await makeRepo("echo-canonical-codex-batch-a-");
    const secondRepo = await makeRepo("echo-canonical-codex-batch-b-");
    const expectedRoot = await canonicalizePath(firstRepo);
    const linkParent = tempDir("echo-canonical-codex-batch-link-");
    const linkedRepo = join(linkParent, "RepoAlias");
    symlinkSync(firstRepo, linkedRepo, "dir");
    const root = tempDir("echo-canonical-codex-batch-home-");
    const sessionsPrefix = `${root}/.codex/sessions/`;
    const sessionDir = join(sessionsPrefix, "2026/06/07");
    mkdirSync(sessionDir, { recursive: true });
    (CAPTURED_SOURCES.fs_paths as unknown as string[]).push(sessionsPrefix);
    const storage = new RetargetAfterFirstAppendStorage(() => {
      unlinkSync(linkedRepo);
      symlinkSync(secondRepo, linkedRepo, "dir");
    });
    codexHandle = await startCodexExtractor(storage, { sessionsPrefix });

    writeJsonl(join(sessionDir, "rollout-2026-06-07T12-00-00-batch.jsonl"), [
      codexSessionMeta(linkedRepo),
      codexMessage("user", "Q1"),
      codexMessage("assistant", "A1"),
      codexMessage("user", "Q2"),
      codexMessage("assistant", "A2"),
      codexMessage("user", "Q3"),
    ]);
    await waitFor(async () => (await storage.count()) >= 2);

    expect(realpathSync(linkedRepo)).toBe(realpathSync(secondRepo));
    const events = await storage.query({ order: "asc" });
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.metadata?.["canonical_root"]).toBe(expectedRoot);
      expect(event.metadata?.["project_key"]).toBe(
        projectKeyForCanonicalRoot(expectedRoot),
      );
    }
  });

  it("keeps one canonical project identity across a Claude extraction batch", async () => {
    const firstRepo = await makeRepo("echo-canonical-claude-batch-a-");
    const secondRepo = await makeRepo("echo-canonical-claude-batch-b-");
    const expectedRoot = await canonicalizePath(firstRepo);
    const linkParent = tempDir("echo-canonical-claude-batch-link-");
    const linkedRepo = join(linkParent, "RepoAlias");
    symlinkSync(firstRepo, linkedRepo, "dir");
    const root = tempDir("echo-canonical-claude-batch-home-");
    const projectsPrefix = `${root}/projects/`;
    const projectDir = join(projectsPrefix, "repo");
    mkdirSync(projectDir, { recursive: true });
    (CAPTURED_SOURCES.fs_paths as unknown as string[]).push(`${root}/`);
    const storage = new RetargetAfterFirstAppendStorage(() => {
      unlinkSync(linkedRepo);
      symlinkSync(secondRepo, linkedRepo, "dir");
    });
    claudeHandle = await startClaudeCodeExtractor(storage, { projectsPrefix });

    writeJsonl(join(projectDir, "batch.jsonl"), [
      claudeUser(linkedRepo, "Q1", "u1"),
      claudeAssistant(linkedRepo, "A1", "a1"),
      claudeUser(linkedRepo, "Q2", "u2"),
      claudeAssistant(linkedRepo, "A2", "a2"),
      claudeUser(linkedRepo, "Q3", "u3"),
    ]);
    await waitFor(async () => (await storage.count()) >= 2);

    expect(realpathSync(linkedRepo)).toBe(realpathSync(secondRepo));
    const events = await storage.query({ order: "asc" });
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.metadata?.["canonical_root"]).toBe(expectedRoot);
      expect(event.metadata?.["project_key"]).toBe(
        projectKeyForCanonicalRoot(expectedRoot),
      );
    }
  });

  it("keeps captured and queried project identity convergent across case folding and symlinks", async () => {
    const repo = await makeRepo("Echo-Canonical-MixedCase-Repo-");
    const linkParent = tempDir("Echo-Canonical-MixedCase-Link-");
    const linkedRepo = join(linkParent, "RepoAlias");
    symlinkSync(repo, linkedRepo, "dir");
    const root = tempDir("echo-canonical-convergence-home-");
    const sessionsPrefix = `${root}/.codex/sessions/`;
    const sessionDir = join(sessionsPrefix, "2026/06/07");
    mkdirSync(sessionDir, { recursive: true });
    (CAPTURED_SOURCES.fs_paths as unknown as string[]).push(sessionsPrefix);
    const storage = new MemoryStorage();
    codexHandle = await startCodexExtractor(storage, { sessionsPrefix });

    writeJsonl(
      join(sessionDir, "rollout-2026-06-07T12-00-00-convergence.jsonl"),
      [
        codexSessionMeta(linkedRepo),
        codexMessage("user", "Q1"),
        codexMessage("assistant", "A1"),
        codexMessage("user", "Q2"),
      ],
    );
    await waitFor(async () => (await storage.count()) >= 1);

    const event = (await storage.query({ order: "asc" }))[0]!;
    const metadata = event.metadata as Record<string, unknown>;
    const resolvedRepoPath = await resolveRepoPath(linkedRepo);
    expect(resolvedRepoPath.project_key).toBe(metadata["project_key"]);

    const since = new Date(Date.parse(event.timestamp) - 1_000).toISOString();
    const until = new Date(Date.parse(event.timestamp) + 1_000).toISOString();
    const search = await searchMemories(storage, { repo_path: linkedRepo });
    expect(search.matches.map((match) => match.id)).toContain(event.id);

    const clusters = await findClusters(storage, {
      since,
      until,
      repo_path: linkedRepo,
    });
    expect(
      clusters.clusters.some((cluster) => cluster.atom_ids.includes(event.id)),
    ).toBe(true);

    const waited = await waitForNewTurns(storage, {
      sources: [event.source],
      since,
      timeout: 0,
      repo_path: linkedRepo,
    });
    expect(waited.turn_ids).toContain(event.id);

    const resolved = await echoResolveMru(storage, {
      sources: [event.source],
      repo_path: linkedRepo,
    });
    expect(resolved.sources[event.source]?.source).toBe(event.source);
  });
});
