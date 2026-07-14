import { describe, expect, it, vi } from 'vitest';
import {
  claudeCodeMcpAddArgs,
  registerClaudeCodeMcpServer,
  validateLocalMcpServerUrl,
} from '../../../src/echo-home/adapters/claude-code-mcp.js';

describe('Claude Code MCP registration', () => {
  it('accepts and canonicalizes explicit loopback MCP URLs', () => {
    expect(validateLocalMcpServerUrl('http://LOCALHOST:38478/mcp')).toBe(
      'http://localhost:38478/mcp',
    );
    expect(validateLocalMcpServerUrl('http://[::1]:38478/mcp')).toBe('http://[::1]:38478/mcp');
    expect(claudeCodeMcpAddArgs('http://127.0.0.1:38478/mcp')).toEqual([
      'mcp',
      'add',
      '--transport',
      'http',
      '--scope',
      'user',
      'echo',
      'http://127.0.0.1:38478/mcp',
    ]);
  });

  it.each([
    'not-a-url',
    'https://127.0.0.1:38478/mcp',
    'http://example.com:38478/mcp',
    'http://evil-localhost:38478/mcp',
    'http://127.0.0.1/mcp',
    'http://127.0.0.1:38478/',
    'http://user@127.0.0.1:38478/mcp',
    'http://127.0.0.1:38478/mcp?x=1',
    'http://127.0.0.1:38478/mcp#fragment',
    'http://127.0.0.1:38478/mcp&calc',
  ])('rejects a non-local or non-canonical URL: %s', (url) => {
    expect(() => validateLocalMcpServerUrl(url)).toThrow(/ECHO MCP URL/);
  });

  it('validates before invoking even an injected spawn implementation', async () => {
    const spawn = vi.fn();
    await expect(
      registerClaudeCodeMcpServer('http://127.0.0.1:38478/mcp&calc', { spawn }),
    ).resolves.toMatchObject({
      action: 'error',
      command: 'claude mcp add --transport http --scope user echo <invalid-url>',
      detail: expect.stringMatching(/ECHO MCP URL/),
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('always invokes the allowlisted Claude executable with validated argv', async () => {
    const spawn = vi.fn(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    }));
    const result = await registerClaudeCodeMcpServer('http://localhost:38478/mcp', { spawn });

    expect(result.action).toBe('mcp-add');
    expect(spawn).toHaveBeenCalledWith(
      'claude',
      [
        'mcp',
        'add',
        '--transport',
        'http',
        '--scope',
        'user',
        'echo',
        'http://localhost:38478/mcp',
      ],
      { timeoutMs: 30_000, outputLimit: 4000 },
    );
  });
});
