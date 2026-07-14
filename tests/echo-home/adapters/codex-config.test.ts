import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { syncCodexMcpBlock } from '../../../src/echo-home/adapters/codex-config.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'echo-072-codex-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const SERVER_CONFIG_V1 = {
  url: 'http://localhost:7117/mcp',
  enabled: true,
};

describe('syncCodexMcpBlock', () => {
  it('add: file has no [mcp_servers.echo] → block is appended', () => {
    const target = join(tmpRoot, 'config.toml');
    writeFileSync(
      target,
      `model = "claude-opus"\n\n# user comment\n[projects.foo]\nbar = "baz"\n`,
    );
    const result = syncCodexMcpBlock({ filePath: target, serverConfig: SERVER_CONFIG_V1 });
    expect(result.action).toBe('add');
    const content = readFileSync(target, 'utf8');
    expect(content.includes('[mcp_servers.echo]')).toBe(true);
    expect(content.includes('url = "http://localhost:7117/mcp"')).toBe(true);
    // Sibling preserved byte-for-byte (prefix).
    expect(content.startsWith(`model = "claude-opus"\n\n# user comment\n[projects.foo]\nbar = "baz"\n`)).toBe(true);
  });

  it('update: existing matches previous → block is rewritten; siblings + comments preserved byte-for-byte', () => {
    const target = join(tmpRoot, 'config.toml');
    const preamble = `# top comment\nmodel = "claude-opus"\n\n`;
    const block = `[mcp_servers.echo]\nurl = "http://old:1234/mcp"\nenabled = true\n`;
    const tail = `[projects.foo] # inline comment\nbar = "baz"\n[mcp_servers.other]\nurl = "http://other"\n`;
    writeFileSync(target, `${preamble}${block}${tail}`);
    const result = syncCodexMcpBlock({
      filePath: target,
      serverConfig: SERVER_CONFIG_V1,
      previousServerConfig: { url: 'http://old:1234/mcp', enabled: true },
    });
    expect(result.action).toBe('update');
    const content = readFileSync(target, 'utf8');
    expect(content.startsWith(preamble)).toBe(true);
    expect(content.endsWith(tail)).toBe(true);
    expect(content.includes('[mcp_servers.echo]')).toBe(true);
    expect(content.includes('url = "http://localhost:7117/mcp"')).toBe(true);
  });

  it('update: user-added key is preserved while desired echo keys are rewritten', () => {
    const target = join(tmpRoot, 'config.toml');
    writeFileSync(
      target,
      `[mcp_servers.echo]\nurl = "http://old:1234/mcp"\nenabled = true\n`,
    );
    const result = syncCodexMcpBlock({
      filePath: target,
      serverConfig: { url: 'http://new:5678/mcp' },
      previousServerConfig: { url: 'http://old:1234/mcp' },
    });
    expect(result.action).toBe('update');
    const content = readFileSync(target, 'utf8');
    expect(content).toContain('url = "http://new:5678/mcp"');
    expect(content).toContain('enabled = true');
  });

  it('noop: existing already matches new → no write', () => {
    const target = join(tmpRoot, 'config.toml');
    const block = `[mcp_servers.echo]\nenabled = true\nurl = "http://localhost:7117/mcp"\n`;
    writeFileSync(target, block);
    const before = readFileSync(target);
    const result = syncCodexMcpBlock({ filePath: target, serverConfig: SERVER_CONFIG_V1 });
    expect(result.action).toBe('noop');
    expect(readFileSync(target).equals(before)).toBe(true);
  });

  it('noop: merged desired config equals current without a previous cache → no write', () => {
    const target = join(tmpRoot, 'config.toml');
    const serverConfig = { url: 'http://127.0.0.1:38478/mcp' };
    const original = `[mcp_servers.echo]\nurl = "${serverConfig.url}"\n\n[mcp_servers.echo.headers]\n`;
    writeFileSync(target, original);
    const before = readFileSync(target);

    const result = syncCodexMcpBlock({ filePath: target, serverConfig });

    expect(result.action).toBe('noop');
    expect(readFileSync(target).equals(before)).toBe(true);
  });

  it('conflict: existing differs from both previous and new → no write', () => {
    const target = join(tmpRoot, 'config.toml');
    writeFileSync(target, `[mcp_servers.echo]\nurl = "http://user-edited:9999/mcp"\nenabled = false\n`);
    const before = readFileSync(target);
    const result = syncCodexMcpBlock({
      filePath: target,
      serverConfig: SERVER_CONFIG_V1,
      previousServerConfig: { url: 'http://old:1234/mcp', enabled: true },
    });
    expect(result.action).toBe('conflict');
    if (result.action !== 'conflict') return;
    expect(result.conflict.kind).toBe('config');
    expect(readFileSync(target).equals(before)).toBe(true);
  });

  it('force: conflicting echo block is replaced while sibling tables are preserved', () => {
    const target = join(tmpRoot, 'config.toml');
    const preamble = `model = "gpt-5"\n\n`;
    const sibling = `[mcp_servers.other]\nurl = "http://other"\n`;
    writeFileSync(
      target,
      `${preamble}[mcp_servers.echo]\nurl = "http://user-edited:9999/mcp"\nenabled = false\n${sibling}`,
    );
    const result = syncCodexMcpBlock({
      filePath: target,
      serverConfig: SERVER_CONFIG_V1,
      previousServerConfig: { url: 'http://old:1234/mcp', enabled: true },
      force: true,
    });
    const content = readFileSync(target, 'utf8');
    expect(result.action).toBe('update');
    expect(content.startsWith(preamble)).toBe(true);
    expect(content.endsWith(sibling)).toBe(true);
    expect(content).toContain('url = "http://localhost:7117/mcp"');
    expect(content).not.toContain('user-edited');
  });

  it('conflict: different current echo without a previous cache still does not write', () => {
    const target = join(tmpRoot, 'config.toml');
    const original = `[mcp_servers.echo]\nurl = "http://user-edited"\n\n[mcp_servers.echo.headers]\n`;
    writeFileSync(target, original);
    const before = readFileSync(target);

    const result = syncCodexMcpBlock({
      filePath: target,
      serverConfig: { url: 'http://127.0.0.1:38478/mcp' },
    });

    expect(result.action).toBe('conflict');
    expect(readFileSync(target).equals(before)).toBe(true);
  });

  it('conflict: proposedValue preserves user-added keys around desired echo keys', () => {
    const target = join(tmpRoot, 'config.toml');
    writeFileSync(
      target,
      `[mcp_servers.echo]\nurl = "http://edited:9999/mcp"\nenabled = true\n`,
    );
    const result = syncCodexMcpBlock({
      filePath: target,
      serverConfig: { url: 'http://new:5678/mcp' },
      previousServerConfig: { url: 'http://original:1234/mcp' },
    });
    expect(result.action).toBe('conflict');
    if (result.action !== 'conflict') return;
    expect(result.conflict.proposedValue).toEqual({
      url: 'http://new:5678/mcp',
      enabled: true,
    });
  });

  it('missing file: creates with just the target block at 0600', () => {
    const subdir = join(tmpRoot, '.codex');
    mkdirSync(subdir);
    const target = join(subdir, 'config.toml');
    const result = syncCodexMcpBlock({ filePath: target, serverConfig: SERVER_CONFIG_V1 });
    expect(result.action).toBe('add');
    const content = readFileSync(target, 'utf8');
    expect(content.startsWith('[mcp_servers.echo]\n')).toBe(true);
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it('sibling [mcp_servers.other] table is preserved byte-for-byte after sync', () => {
    const target = join(tmpRoot, 'config.toml');
    const other = `[mcp_servers.other]\nurl = "http://other:1234"\nenabled = false\n`;
    writeFileSync(target, other);
    syncCodexMcpBlock({ filePath: target, serverConfig: SERVER_CONFIG_V1 });
    const content = readFileSync(target, 'utf8');
    expect(content.includes(other)).toBe(true);
  });

  it('mode preservation on existing file (0600)', () => {
    const target = join(tmpRoot, 'config.toml');
    const block = `[mcp_servers.echo]\nurl = "http://old:1234/mcp"\nenabled = true\n`;
    writeFileSync(target, block);
    chmodSync(target, 0o600);
    syncCodexMcpBlock({
      filePath: target,
      serverConfig: SERVER_CONFIG_V1,
      previousServerConfig: { url: 'http://old:1234/mcp', enabled: true },
    });
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it('secretSensitive clamps existing 0644 to 0600', () => {
    const target = join(tmpRoot, 'config.toml');
    const block = `[mcp_servers.echo]\nurl = "http://old:1234/mcp"\nenabled = true\n`;
    writeFileSync(target, block);
    chmodSync(target, 0o644);
    syncCodexMcpBlock({
      filePath: target,
      serverConfig: SERVER_CONFIG_V1,
      previousServerConfig: { url: 'http://old:1234/mcp', enabled: true },
    });
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it('descendant subtable [mcp_servers.echo.headers] is rewritten, not duplicated', () => {
    const target = join(tmpRoot, 'config.toml');
    const original = `[mcp_servers.echo]\nurl = "http://old:1234/mcp"\nenabled = true\n\n[mcp_servers.echo.headers]\nX-Auth = "old"\n\n[mcp_servers.other]\nurl = "http://other"\n`;
    writeFileSync(target, original);
    const result = syncCodexMcpBlock({
      filePath: target,
      serverConfig: {
        url: 'http://localhost:7117/mcp',
        enabled: true,
        headers: { 'X-Auth': 'new' },
      },
      previousServerConfig: {
        url: 'http://old:1234/mcp',
        enabled: true,
        headers: { 'X-Auth': 'old' },
      },
    });
    expect(result.action).toBe('update');
    const content = readFileSync(target, 'utf8');
    // The dotted-key form is what we emit; the old subtable header should be gone.
    expect(content.includes('headers.X-Auth = "new"')).toBe(true);
    expect(content.includes('X-Auth = "old"')).toBe(false);
    // Sibling preserved.
    expect(content.includes('[mcp_servers.other]')).toBe(true);
  });
});
