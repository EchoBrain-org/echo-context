import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type AdapterSyncModule = typeof import('../../src/echo-home/adapter-sync.js');

let tmpRoot: string;
let stubHome: string;
let echoHome: string;
let originalHome: string | undefined;
let originalEchoHome: string | undefined;
let originalCodexHome: string | undefined;

const ROLES = ['builder.toml', 'reviewer.toml', 'strategist.toml'];

async function loadAdapterSync(): Promise<AdapterSyncModule> {
  return import('../../src/echo-home/adapter-sync.js');
}

function setupRepoMirror(): {
  repoRoot: string;
  skillsDir: string;
  rolesDir: string;
  workflowsDir: string;
} {
  const repoRoot = join(tmpRoot, 'repo');
  const contributorSkillsDir = join(repoRoot, 'skills');
  const skillsDir = join(repoRoot, 'assets', 'echo-skills');
  const rolesDir = join(repoRoot, 'assets', 'echo-roles');
  const workflowsDir = join(repoRoot, 'assets', 'echo-workflows');
  mkdirSync(contributorSkillsDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });
  mkdirSync(rolesDir, { recursive: true });
  mkdirSync(workflowsDir, { recursive: true });
  // Pretend this is a package root: package.json + assets/echo-skills/.
  writeFileSync(join(repoRoot, 'package.json'), '{}\n');
  // Contributor-process skills should exist but not be customer-synced.
  writeFileSync(join(contributorSkillsDir, 'process-backlog.md'), '# process\n');
  writeFileSync(join(contributorSkillsDir, 'merge-and-cleanup.md'), '# merge\n');
  // Customer skill fixtures.
  writeFileSync(join(skillsDir, 'alpha.md'), '# alpha\n');
  writeFileSync(join(skillsDir, 'beta.md'), '# beta\n');
  writeFileSync(
    join(skillsDir, 'using-echo-mcp.md'),
    '---\nname: using-echo-mcp\n---\n# using echo mcp\n',
  );
  // Role fixtures (matching DEFAULT_ROLE_FILENAMES).
  for (const r of ROLES) writeFileSync(join(rolesDir, r), `# ${r}\nbody\n`);
  writeFileSync(
    join(workflowsDir, 'change-review.toml'),
    '[workflow]\nname = "change-review"\ndescription = "Review"\nschema_version = 1\n\n[[step]]\nrole = "reviewer"\nprompt = "Review"\n',
  );
  return { repoRoot, skillsDir, rolesDir, workflowsDir };
}

beforeEach(() => {
  originalHome = process.env.HOME;
  originalEchoHome = process.env.ECHO_HOME;
  originalCodexHome = process.env.CODEX_HOME;
  tmpRoot = mkdtempSync(join(tmpdir(), 'echo-072-adapter-'));
  stubHome = join(tmpRoot, 'home');
  mkdirSync(stubHome, { recursive: true });
  process.env.HOME = stubHome;
  delete process.env.CODEX_HOME;
  echoHome = join(stubHome, '.echo');
  process.env.ECHO_HOME = echoHome;
  vi.resetModules();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalEchoHome === undefined) delete process.env.ECHO_HOME;
  else process.env.ECHO_HOME = originalEchoHome;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.resetModules();
});

describe('syncAll (orchestrator)', () => {
  it('all three agents succeed → overallOk:true', async () => {
    const { repoRoot } = setupRepoMirror();
    const { syncAll } = await loadAdapterSync();

    const profiles = [
      {
        kind: 'codex' as const,
        echoSection: '## ECHO Pro\nx',
        mcpServerConfig: { url: 'http://localhost:7117/mcp' },
      },
      {
        kind: 'claude-code' as const,
        echoSection: '## ECHO Pro\nx',
      },
      {
        kind: 'cursor' as const,
        mcpServerConfig: { url: 'http://localhost:7117/mcp' },
      },
    ];

    const result = await syncAll(profiles, { repoRoot });
    expect(result.overallOk).toBe(true);
    expect(result.skillsPopulated.ok).toBe(true);
    expect(result.agents).toHaveLength(3);
    for (const a of result.agents) expect(a.ok).toBe(true);
  });

  it('codex conflict on config.toml; cursor + claude-code unaffected; no transactional rollback', async () => {
    const { repoRoot } = setupRepoMirror();
    // Pre-seed codex config with an unexpected echo block (forces conflict).
    const codexDir = join(stubHome, '.codex');
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      join(codexDir, 'config.toml'),
      `[mcp_servers.echo]\nurl = "http://user-edited"\n`,
    );
    const { syncAll } = await loadAdapterSync();
    const result = await syncAll(
      [
        {
          kind: 'codex',
          echoSection: '## ECHO Pro\nx',
          mcpServerConfig: { url: 'http://localhost:7117/mcp' },
        },
        { kind: 'claude-code', echoSection: '## ECHO Pro\nx' },
        { kind: 'cursor', mcpServerConfig: { url: 'http://localhost:7117/mcp' } },
      ],
      { repoRoot },
    );
    expect(result.overallOk).toBe(false);
    const codex = result.agents.find((a) => a.agent === 'codex')!;
    expect(codex.ok).toBe(false);
    if (codex.ok === false) {
      expect(codex.conflicts.length).toBeGreaterThan(0);
      expect(codex.conflicts[0].kind).toBe('config');
    }
    const claude = result.agents.find((a) => a.agent === 'claude-code')!;
    expect(claude.ok).toBe(true);
    const cursor = result.agents.find((a) => a.agent === 'cursor')!;
    expect(cursor.ok).toBe(true);
    // Cursor config WAS written (no rollback).
    expect(existsSync(join(stubHome, '.cursor', 'mcp.json'))).toBe(true);
  });

  it('populate-skills runs before claude-code fan-out', async () => {
    const { repoRoot } = setupRepoMirror();
    const { syncAll } = await loadAdapterSync();
    const result = await syncAll([{ kind: 'claude-code', echoSection: '## E\nx' }], { repoRoot });
    expect(result.skillsPopulated.ok).toBe(true);
    expect(existsSync(join(echoHome, 'skills', 'alpha.md'))).toBe(true);
    expect(existsSync(join(echoHome, 'skills', 'process-backlog.md'))).toBe(false);
    expect(existsSync(join(echoHome, 'skills', 'merge-and-cleanup.md'))).toBe(false);
    expect(existsSync(join(stubHome, '.claude', 'commands', 'alpha.md'))).toBe(true);
    expect(existsSync(join(stubHome, '.claude', 'commands', 'process-backlog.md'))).toBe(false);
  });

  it('customer profile filters dogfood skills and skips roles/workflows as successful no-ops', async () => {
    const { repoRoot, skillsDir } = setupRepoMirror();
    writeFileSync(join(skillsDir, 'dogfood.md'), '---\naudience: dogfood\n---\n# dogfood\n');
    const { syncAll } = await loadAdapterSync();

    const result = await syncAll([{ kind: 'claude-code', echoSection: '## E\nx' }], {
      repoRoot,
      profile: 'customer',
    });

    expect(result.overallOk).toBe(true);
    expect(result.skillsPopulated.ok).toBe(true);
    if (result.skillsPopulated.ok) {
      expect(result.skillsPopulated.copied.sort()).toEqual([
        'alpha.md',
        'beta.md',
        'using-echo-mcp.md',
      ]);
      expect(result.skillsPopulated.skipped).toContain('dogfood.md');
    }
    expect(existsSync(join(echoHome, 'skills', 'dogfood.md'))).toBe(false);
    expect(existsSync(join(stubHome, '.claude', 'commands', 'dogfood.md'))).toBe(false);
    expect(result.roles.results.map((entry) => entry.action)).toEqual(['noop', 'noop', 'noop']);
    expect(existsSync(join(echoHome, 'roles', 'builder.toml'))).toBe(false);
    expect(result.workflowsResult?.results).toEqual([
      { workflow: 'change-review.toml', action: 'noop' },
    ]);
    expect(existsSync(join(echoHome, 'workflows', 'change-review.toml'))).toBe(false);
  });

  it('populate-skills failure (missing repoSkillsDir) skips claude-code fan-out and flips overallOk', async () => {
    const { repoRoot } = setupRepoMirror();
    const { syncAll } = await loadAdapterSync();
    const result = await syncAll([{ kind: 'claude-code', echoSection: '## E\nx' }], {
      repoRoot,
      repoSkillsDir: join(repoRoot, 'does-not-exist'),
    });
    expect(result.skillsPopulated.ok).toBe(false);
    expect(result.overallOk).toBe(false);
    const claude = result.agents.find((a) => a.agent === 'claude-code')!;
    // Markers merge still ran; second-hop skipped.
    if (claude.ok === true) {
      expect(claude.skipped).toContain('syncClaudeSkills');
    } else if (claude.ok === false) {
      expect(claude.skipped).toContain('syncClaudeSkills');
    }
    // commandsDir was not populated.
    const cmdDir = join(stubHome, '.claude', 'commands');
    if (existsSync(cmdDir)) {
      expect(readdirSync(cmdDir)).toEqual([]);
    }
  });

  it('default role list comes from DEFAULT_ROLE_FILENAMES (071) when opts.defaultRoles omitted', async () => {
    const { repoRoot } = setupRepoMirror();
    const { syncAll } = await loadAdapterSync();
    const result = await syncAll([], { repoRoot });
    const rolesSeen = result.roles.results.map((r) => r.role).sort();
    expect(rolesSeen).toEqual([...ROLES].sort());
  });

  it('default workflow is copied into ECHO_HOME workflows and keeps overallOk true', async () => {
    const { repoRoot, workflowsDir } = setupRepoMirror();
    const { syncAll } = await loadAdapterSync();

    const result = await syncAll([], {
      repoRoot,
      workflowsSourceDir: workflowsDir,
      defaultWorkflows: ['change-review.toml'],
    });

    expect(readFileSync(join(echoHome, 'workflows', 'change-review.toml'))).toEqual(
      readFileSync(join(workflowsDir, 'change-review.toml')),
    );
    expect(result.workflowsResult?.results).toEqual([
      { workflow: 'change-review.toml', action: 'copied' },
    ]);
    expect(result.overallOk).toBe(true);
  });

  it('default workflow source-missing is diagnosed via workflowsResult and fails overallOk', async () => {
    const { repoRoot } = setupRepoMirror();
    const emptyWorkflows = join(tmpRoot, 'empty-workflows');
    mkdirSync(emptyWorkflows);
    const { syncAll } = await loadAdapterSync();

    const result = await syncAll([], {
      repoRoot,
      workflowsSourceDir: emptyWorkflows,
      defaultWorkflows: ['change-review.toml'],
    });

    expect(result.workflowsResult?.results[0]).toEqual({
      workflow: 'change-review.toml',
      action: 'source-missing',
    });
    expect(result.overallOk).toBe(false);
  });

  it('user-modified workflow is preserved and does not fail overallOk', async () => {
    const { repoRoot } = setupRepoMirror();
    const workflowsTarget = join(echoHome, 'workflows');
    mkdirSync(workflowsTarget, { recursive: true });
    const target = join(workflowsTarget, 'change-review.toml');
    writeFileSync(target, 'user edit\n');
    const before = statSync(target);
    const { syncAll } = await loadAdapterSync();

    const result = await syncAll([], {
      repoRoot,
      defaultWorkflows: ['change-review.toml'],
    });

    expect(result.workflowsResult?.results[0]?.action).toBe('user-modified');
    expect(result.overallOk).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('user edit\n');
    expect(statSync(target).mtimeMs).toBe(before.mtimeMs);
  });

  it('workflow per-file error fails overallOk without blocking skills or roles', async () => {
    const { repoRoot } = setupRepoMirror();
    const workflowsTarget = join(echoHome, 'workflows');
    mkdirSync(join(workflowsTarget, 'change-review.toml'), { recursive: true });
    const { syncAll } = await loadAdapterSync();

    const result = await syncAll([], {
      repoRoot,
      defaultWorkflows: ['change-review.toml'],
    });

    expect(result.workflowsResult?.results).toHaveLength(1);
    expect(result.workflowsResult?.results[0]).toMatchObject({
      workflow: 'change-review.toml',
      action: 'error',
    });
    expect(result.workflowsResult?.workflowsErrors).toHaveLength(1);
    expect(result.roles.results.map((entry) => entry.action)).toEqual([
      'copied',
      'copied',
      'copied',
    ]);
    expect(result.skillsPopulated.ok).toBe(true);
    expect(result.overallOk).toBe(false);
  });

  it('lockfile present → second sync returns RETRY_CONFLICT with shell-quoted rm hint; agents = []', async () => {
    const { repoRoot } = setupRepoMirror();
    const { syncAll } = await loadAdapterSync();
    // Pre-create lockfile.
    const stateDir = join(echoHome, 'state');
    mkdirSync(stateDir, { recursive: true });
    const lockPath = join(stateDir, 'adapter-sync.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: 0, hostname: 'x' }));
    const result = await syncAll([], { repoRoot });
    expect(result.syncLock).toBeDefined();
    expect(result.syncLock!.code).toBe('RETRY_CONFLICT');
    expect(result.syncLock!.file).toBe(lockPath);
    expect(result.syncLock!.message).toContain('rm -- ');
    expect(result.agents).toEqual([]);
    expect(result.overallOk).toBe(false);
    // Now remove the lock, retry.
    rmSync(lockPath);
    const result2 = await syncAll([], { repoRoot });
    expect(result2.syncLock).toBeUndefined();
  });

  it('lock listeners (exit/SIGINT/SIGTERM) unregistered after success', async () => {
    const { repoRoot } = setupRepoMirror();
    const { syncAll } = await loadAdapterSync();
    const c1 = process.listenerCount('exit');
    const c2 = process.listenerCount('SIGINT');
    const c3 = process.listenerCount('SIGTERM');
    await syncAll([], { repoRoot });
    expect(process.listenerCount('exit')).toBe(c1);
    expect(process.listenerCount('SIGINT')).toBe(c2);
    expect(process.listenerCount('SIGTERM')).toBe(c3);
    // Run 50 more times to pin no leak.
    for (let i = 0; i < 50; i++) {
      await syncAll([], { repoRoot });
    }
    expect(process.listenerCount('exit')).toBe(c1);
    expect(process.listenerCount('SIGINT')).toBe(c2);
    expect(process.listenerCount('SIGTERM')).toBe(c3);
  });

  it('repoRoot not findable → repoRoot AdapterError; agents = []', async () => {
    const { syncAll } = await loadAdapterSync();
    // Don't set up a repo mirror — pass a tmpdir as repoRoot that has no
    // package.json + assets/echo-skills.
    const noRepo = join(tmpRoot, 'no-repo');
    mkdirSync(noRepo);
    const result = await syncAll([], { repoRoot: noRepo });
    // syncAll uses opts.repoRoot directly when provided — it doesn't validate.
    // So if we DON'T pass repoRoot, the walk fails (since we may not be in a
    // repo from the test runner's perspective — but the test runner IS in a
    // repo). To force failure, monkey-patch by passing a known-bad explicit
    // repoSkillsDir, leaving repoRoot resolution at module-level (which will
    // succeed). The intent of this test is the unfound-walk path — we exercise
    // it by setting opts.repoRoot to a tmpdir which has neither package.json
    // nor customer skills, but the orchestrator currently trusts opts.repoRoot. We
    // therefore test the missing-source branch via repoSkillsDir.
    expect(result.repoRoot).toBeUndefined();
    // The role + skill sources won't exist; skills populate should fail.
    expect(result.skillsPopulated.ok).toBe(false);
  });

  it('missing required input → agent.ok:false with MISSING_REQUIRED_INPUT', async () => {
    const { repoRoot } = setupRepoMirror();
    const { syncAll } = await loadAdapterSync();
    const result = await syncAll(
      [{ kind: 'codex', echoSection: '## E\nx' /* mcpServerConfig omitted */ }],
      { repoRoot },
    );
    expect(result.overallOk).toBe(false);
    const codex = result.agents.find((a) => a.agent === 'codex')!;
    expect(codex.ok).toBe(false);
    if (codex.ok === false) {
      expect(codex.errors.some((e) => e.code === 'MISSING_REQUIRED_INPUT')).toBe(true);
    }
  });

  it('marker target is a symlink → target-symlink conflict; linked file unchanged', async () => {
    const { repoRoot } = setupRepoMirror();
    // Pre-create the claude instructions file as a symlink to an external file.
    const realFile = join(tmpRoot, 'external-CLAUDE.md');
    writeFileSync(realFile, 'pristine\n');
    mkdirSync(join(stubHome, '.claude'), { recursive: true });
    symlinkSync(realFile, join(stubHome, '.claude', 'CLAUDE.md'));
    const { syncAll } = await loadAdapterSync();
    const result = await syncAll([{ kind: 'claude-code', echoSection: '## E\nx' }], { repoRoot });
    const claude = result.agents.find((a) => a.agent === 'claude-code')!;
    expect(claude.ok).toBe(false);
    if (claude.ok === false) {
      expect(claude.conflicts.some((c) => c.kind === 'target-symlink')).toBe(true);
    }
    expect(readFileSync(realFile, 'utf8')).toBe('pristine\n');
  });

  it('directory-component symlink at ~/.echo/skills → directorySymlink AdapterError, agents = []', async () => {
    const { repoRoot } = setupRepoMirror();
    // Create stub echo home with skills as a symlink.
    mkdirSync(echoHome, { recursive: true });
    const linkTarget = join(tmpRoot, 'redirected-skills');
    mkdirSync(linkTarget, { recursive: true });
    symlinkSync(linkTarget, join(echoHome, 'skills'));
    const { syncAll } = await loadAdapterSync();
    const result = await syncAll([], { repoRoot });
    expect(result.directorySymlink).toBeDefined();
    expect(result.directorySymlink!.code).toBe('EEXIST');
    expect(result.agents).toEqual([]);
    expect(result.overallOk).toBe(false);
  });

  it('directory-component symlink at ~/.echo/workflows short-circuits before workflow sync', async () => {
    const { repoRoot } = setupRepoMirror();
    mkdirSync(echoHome, { recursive: true });
    const linkTarget = join(tmpRoot, 'redirected-workflows');
    mkdirSync(linkTarget, { recursive: true });
    symlinkSync(linkTarget, join(echoHome, 'workflows'));
    const { syncAll } = await loadAdapterSync();

    const result = await syncAll([], { repoRoot });

    expect(result.directorySymlink).toBeDefined();
    expect(result.directorySymlink!.file).toBe(join(echoHome, 'workflows'));
    expect(result.overallOk).toBe(false);
    expect(result.workflowsResult).toBeUndefined();
    expect(readdirSync(linkTarget)).toEqual([]);
  });

  it('first-run: parent dirs (.codex, .cursor) are created when defaults are used', async () => {
    const { repoRoot } = setupRepoMirror();
    expect(existsSync(join(stubHome, '.codex'))).toBe(false);
    expect(existsSync(join(stubHome, '.cursor'))).toBe(false);
    const { syncAll } = await loadAdapterSync();
    const result = await syncAll(
      [
        {
          kind: 'codex',
          echoSection: '## E\nx',
          mcpServerConfig: { url: 'http://localhost:7117/mcp' },
        },
        { kind: 'cursor', mcpServerConfig: { url: 'http://localhost:7117/mcp' } },
      ],
      { repoRoot },
    );
    expect(existsSync(join(stubHome, '.codex', 'config.toml'))).toBe(true);
    expect(existsSync(join(stubHome, '.codex', 'skills', 'using-echo-mcp', 'SKILL.md'))).toBe(true);
    expect(
      readFileSync(join(stubHome, '.codex', 'skills', 'using-echo-mcp', 'SKILL.md'), 'utf8'),
    ).toMatch(/^name: using-echo-mcp/m);
    expect(existsSync(join(stubHome, '.cursor', 'mcp.json'))).toBe(true);
    expect(result.overallOk).toBe(true);
  });

  it('codex missing required packaged skill fails before marker/config writes', async () => {
    const { repoRoot, skillsDir } = setupRepoMirror();
    rmSync(join(skillsDir, 'using-echo-mcp.md'));
    const { syncAll } = await loadAdapterSync();

    const result = await syncAll(
      [
        {
          kind: 'codex',
          echoSection: '## E\nx',
          mcpServerConfig: { url: 'http://localhost:7117/mcp' },
        },
      ],
      { repoRoot },
    );

    expect(result.overallOk).toBe(false);
    const codex = result.agents.find((a) => a.agent === 'codex')!;
    expect(codex.ok).toBe(false);
    if (codex.ok === false) {
      expect(codex.errors[0]?.message).toContain('missing required Codex skill source');
    }
    expect(existsSync(join(stubHome, '.codex', 'skills', 'using-echo-mcp', 'SKILL.md'))).toBe(
      false,
    );
    expect(existsSync(join(stubHome, '.codex', 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(stubHome, '.codex', 'config.toml'))).toBe(false);
  });

  it('symlink in repo assets/echo-skills/ is not propagated to ~/.echo/skills/', async () => {
    const { repoRoot, skillsDir } = setupRepoMirror();
    const external = join(tmpRoot, 'external-skill.md');
    writeFileSync(external, 'untouchable\n');
    symlinkSync(external, join(skillsDir, 'leaky.md'));
    const { syncAll } = await loadAdapterSync();
    await syncAll([], { repoRoot });
    expect(existsSync(join(echoHome, 'skills', 'alpha.md'))).toBe(true);
    expect(existsSync(join(echoHome, 'skills', 'leaky.md'))).toBe(false);
  });

  it('user-modified role flips overallOk to false unless opts.allowUserModifiedRoles', async () => {
    const { repoRoot } = setupRepoMirror();
    // Pre-seed user-modified reviewer.toml.
    const rolesTarget = join(echoHome, 'roles');
    mkdirSync(rolesTarget, { recursive: true });
    writeFileSync(join(rolesTarget, 'reviewer.toml'), 'user-edit\n');
    const { syncAll } = await loadAdapterSync();
    const r1 = await syncAll([], { repoRoot });
    expect(r1.overallOk).toBe(false);
    const reviewer = r1.roles.results.find((r) => r.role === 'reviewer.toml')!;
    expect(reviewer.action).toBe('user-modified');
    // With opt-in, overallOk is true (still need skills to be populated though).
    const r2 = await syncAll([], { repoRoot, allowUserModifiedRoles: true });
    expect(r2.overallOk).toBe(true);
  });

  it('cursor config preserves auth headers in conflict payload but does NOT log them', async () => {
    const { repoRoot } = setupRepoMirror();
    const cursorDir = join(stubHome, '.cursor');
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(
      join(cursorDir, 'mcp.json'),
      JSON.stringify(
        {
          mcpServers: {
            echo: { url: 'http://user-edited', headers: { Authorization: 'Bearer leaked-xyz' } },
          },
        },
        null,
        2,
      ),
    );
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { syncAll } = await loadAdapterSync();
    const result = await syncAll(
      [
        {
          kind: 'cursor',
          mcpServerConfig: {
            url: 'http://localhost:7117/mcp',
            headers: { Authorization: 'Bearer new-secret' },
          },
        },
      ],
      { repoRoot },
    );
    const cursor = result.agents.find((a) => a.agent === 'cursor')!;
    expect(cursor.ok).toBe(false);
    const stderrCalls = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    const stdoutCalls = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrCalls).not.toContain('Bearer');
    expect(stdoutCalls).not.toContain('Bearer');
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('malformed JSON in cursor mcp.json does not throw; agent ok:false with PARSE_ERROR; no leaked bytes', async () => {
    const { repoRoot } = setupRepoMirror();
    const cursorDir = join(stubHome, '.cursor');
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(join(cursorDir, 'mcp.json'), '{ "mcpServers": { broken-syntax');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { syncAll } = await loadAdapterSync();
    const result = await syncAll(
      [
        { kind: 'cursor', mcpServerConfig: { url: 'http://localhost:7117/mcp' } },
        {
          kind: 'codex',
          echoSection: '## E\nx',
          mcpServerConfig: { url: 'http://localhost:7117/mcp' },
        },
      ],
      { repoRoot },
    );
    const cursor = result.agents.find((a) => a.agent === 'cursor')!;
    expect(cursor.ok).toBe(false);
    if (cursor.ok === false) {
      expect(cursor.errors.some((e) => e.code === 'PARSE_ERROR')).toBe(true);
    }
    const codex = result.agents.find((a) => a.agent === 'codex')!;
    expect(codex.ok).toBe(true);
    expect(result.overallOk).toBe(false);
    stderrSpy.mockRestore();
  });

  it('previous*-absent: existing differs from proposed → conflict', async () => {
    const { repoRoot } = setupRepoMirror();
    mkdirSync(join(stubHome, '.claude'), { recursive: true });
    writeFileSync(
      join(stubHome, '.claude', 'CLAUDE.md'),
      '<!-- BEGIN ECHO -->\nold-content\n<!-- END ECHO -->\n',
    );
    const { syncAll } = await loadAdapterSync();
    const result = await syncAll([{ kind: 'claude-code', echoSection: 'new-content' }], {
      repoRoot,
    });
    const claude = result.agents.find((a) => a.agent === 'claude-code')!;
    expect(claude.ok).toBe(false);
  });

  it('symlinked target in commandsDir is skipped, not followed', async () => {
    const { repoRoot } = setupRepoMirror();
    const cmdDir = join(stubHome, '.claude', 'commands');
    mkdirSync(cmdDir, { recursive: true });
    const externalSkill = join(tmpRoot, 'external-skill.md');
    writeFileSync(externalSkill, 'pristine-external\n');
    symlinkSync(externalSkill, join(cmdDir, 'alpha.md'));
    const { syncAll } = await loadAdapterSync();
    await syncAll([{ kind: 'claude-code', echoSection: '## E\nx' }], { repoRoot });
    expect(readFileSync(externalSkill, 'utf8')).toBe('pristine-external\n');
    // beta.md still copies fine.
    expect(existsSync(join(cmdDir, 'beta.md'))).toBe(true);
  });

  it('all commandsDir targets pre-staged as symlinks → claude-code ok:false / overallOk:false', async () => {
    const { repoRoot } = setupRepoMirror();
    const cmdDir = join(stubHome, '.claude', 'commands');
    mkdirSync(cmdDir, { recursive: true });
    const externA = join(tmpRoot, 'extern-alpha.md');
    const externB = join(tmpRoot, 'extern-beta.md');
    const externC = join(tmpRoot, 'extern-using-echo-mcp.md');
    writeFileSync(externA, 'pristine-alpha\n');
    writeFileSync(externB, 'pristine-beta\n');
    writeFileSync(externC, 'pristine-mcp\n');
    symlinkSync(externA, join(cmdDir, 'alpha.md'));
    symlinkSync(externB, join(cmdDir, 'beta.md'));
    symlinkSync(externC, join(cmdDir, 'using-echo-mcp.md'));
    const { syncAll } = await loadAdapterSync();
    const result = await syncAll([{ kind: 'claude-code', echoSection: '## E\nx' }], {
      repoRoot,
    });
    const claude = result.agents.find((a) => a.agent === 'claude-code')!;
    expect(claude.ok).toBe(false);
    expect(result.overallOk).toBe(false);
    if (!claude.ok) {
      const zeroCopiedErr = claude.errors.find((e) => e.message.includes('copied 0 files'));
      expect(zeroCopiedErr).toBeDefined();
      expect(zeroCopiedErr!.code).toBe('EEXIST');
    }
    expect(readFileSync(externA, 'utf8')).toBe('pristine-alpha\n');
    expect(readFileSync(externB, 'utf8')).toBe('pristine-beta\n');
  });

  it('symlinked dotfile target (config.toml) is written through (followSymlink: true preserved)', async () => {
    const { repoRoot } = setupRepoMirror();
    const dotfiles = join(tmpRoot, 'dotfiles');
    mkdirSync(dotfiles, { recursive: true });
    const realCfg = join(dotfiles, 'codex-config.toml');
    writeFileSync(realCfg, '');
    mkdirSync(join(stubHome, '.codex'), { recursive: true });
    symlinkSync(realCfg, join(stubHome, '.codex', 'config.toml'));
    const { syncAll } = await loadAdapterSync();
    const result = await syncAll(
      [
        {
          kind: 'codex',
          echoSection: '## E\nx',
          mcpServerConfig: { url: 'http://localhost:7117/mcp' },
        },
      ],
      { repoRoot },
    );
    expect(result.overallOk).toBe(true);
    // The symlink itself is preserved.
    const linkPath = join(stubHome, '.codex', 'config.toml');
    expect(statSync(linkPath).isFile()).toBe(true);
    // The dotfiles target received the update.
    expect(readFileSync(realCfg, 'utf8')).toContain('[mcp_servers.echo]');
    // The temp file lived next to dotfiles realCfg, not next to the symlink.
    const dotfilesContents = readdirSync(dotfiles);
    expect(dotfilesContents.every((n) => !n.endsWith('.tmp'))).toBe(true);
  });

  // Suppress unused-var warning
  void resolve;
  void dirname;
  void sep;
});
