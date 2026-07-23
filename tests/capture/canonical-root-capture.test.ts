import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  startClaudeCodeExtractor,
  type ClaudeCodeExtractorHandle,
} from '../../src/capture/extractors/claude-code.js';
import {
  startCodexExtractor,
  type CodexExtractorHandle,
} from '../../src/capture/extractors/codex.js';
import { CAPTURED_SOURCES } from '../../src/capture/sources.js';
import {
  canonicalizePath,
  projectKeyForCanonicalRoot,
} from '../../src/capture/workspace-root.js';
import { MemoryStorage } from '../../src/storage/memory.js';
import { resetAllowlist, restoreFsPaths, snapshotFsPaths } from '../fixtures/allowlist.js';
import { waitFor, writeJsonl } from '../fixtures/jsonl.js';

const execFileP = promisify(execFile);

interface ClaudeLine {
  type: 'user' | 'assistant';
  sessionId: string;
  cwd: string;
  message: { role: 'user' | 'assistant'; content: unknown };
  uuid: string;
  timestamp: string;
}

interface CodexLine {
  timestamp: string;
  type: string;
  payload: Record<string, unknown>;
}

describe('canonical_root capture stamping', () => {
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
    for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(prefix: string): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    cleanupDirs.push(dir);
    return dir;
  }

  async function makeRepo(prefix: string): Promise<string> {
    const repo = tempDir(prefix);
    await execFileP('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    await execFileP('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    await execFileP('git', ['config', 'user.name', 'Test'], { cwd: repo });
    await execFileP('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
    return repo;
  }

  function claudeUser(repo: string, text: string, uuid: string): ClaudeLine {
    return {
      type: 'user',
      sessionId: 'claude-session',
      cwd: repo,
      message: { role: 'user', content: text },
      uuid,
      timestamp: new Date().toISOString(),
    };
  }

  function claudeAssistant(repo: string, text: string, uuid: string): ClaudeLine {
    return {
      type: 'assistant',
      sessionId: 'claude-session',
      cwd: repo,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
      uuid,
      timestamp: new Date().toISOString(),
    };
  }

  function codexSessionMeta(repo: string): CodexLine {
    return {
      timestamp: new Date().toISOString(),
      type: 'session_meta',
      payload: {
        id: '019de2b0-6551-7682-a51b-2affaa0a7bbf',
        cwd: repo,
      },
    };
  }

  function codexMessage(role: 'user' | 'assistant', text: string): CodexLine {
    return {
      timestamp: new Date().toISOString(),
      type: 'response_item',
      payload: {
        type: 'message',
        role,
        content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
      },
    };
  }

  it('claude_code keeps the observed nested cwd but stamps the repository project root', async () => {
    const repo = await makeRepo('echo-canonical-cc-repo-');
    const nestedCwd = join(repo, 'packages', 'app');
    mkdirSync(nestedCwd, { recursive: true });
    const root = tempDir('echo-canonical-cc-home-');
    const projectsPrefix = `${root}/projects/`;
    const projectDir = join(projectsPrefix, 'repo');
    mkdirSync(projectDir, { recursive: true });
    (CAPTURED_SOURCES.fs_paths as unknown as string[]).push(`${root}/`);
    const storage = new MemoryStorage();
    claudeHandle = await startClaudeCodeExtractor(storage, { projectsPrefix });

    writeJsonl(join(projectDir, 'session.jsonl'), [
      claudeUser(nestedCwd, 'Q1', 'u1'),
      claudeAssistant(nestedCwd, 'A1', 'a1'),
      claudeUser(nestedCwd, 'Q2', 'u2'),
    ]);
    await waitFor(async () => (await storage.count()) >= 1);

    const event = (await storage.query({ order: 'asc' }))[0]!;
    const metadata = event.metadata as Record<string, unknown>;
    expect(metadata['repo_root']).toBe(nestedCwd);
    const canonicalRoot = await canonicalizePath(repo);
    expect(metadata['canonical_root']).toBe(canonicalRoot);
    expect(metadata['project_key']).toBe(projectKeyForCanonicalRoot(canonicalRoot));
  });

  it('codex stamps metadata.canonical_root from cwd/repo_root', async () => {
    const repo = await makeRepo('echo-canonical-codex-repo-');
    const root = tempDir('echo-canonical-codex-home-');
    const sessionsPrefix = `${root}/.codex/sessions/`;
    const sessionDir = join(sessionsPrefix, '2026/06/07');
    mkdirSync(sessionDir, { recursive: true });
    (CAPTURED_SOURCES.fs_paths as unknown as string[]).push(sessionsPrefix);
    const storage = new MemoryStorage();
    codexHandle = await startCodexExtractor(storage, { sessionsPrefix });

    writeJsonl(join(sessionDir, 'rollout-2026-06-07T12-00-00-demo.jsonl'), [
      codexSessionMeta(repo),
      codexMessage('user', 'Q1'),
      codexMessage('assistant', 'A1'),
      codexMessage('user', 'Q2'),
    ]);
    await waitFor(async () => (await storage.count()) >= 1);

    const event = (await storage.query({ order: 'asc' }))[0]!;
    const metadata = event.metadata as Record<string, unknown>;
    expect(metadata['cwd']).toBe(repo);
    expect(metadata['repo_root']).toBe(repo);
    const canonicalRoot = await canonicalizePath(repo);
    expect(metadata['canonical_root']).toBe(canonicalRoot);
    expect(metadata['project_key']).toBe(projectKeyForCanonicalRoot(canonicalRoot));
  });
});
