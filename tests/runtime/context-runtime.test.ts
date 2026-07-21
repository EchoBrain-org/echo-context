import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveContextRuntimeConfig } from '../../src/runtime/config.js';
import { startContextRuntime } from '../../src/runtime/context-runtime.js';

describe('context runtime resource transaction', () => {
  const roots: string[] = [];
  let occupied: Server | undefined;

  afterEach(async () => {
    if (occupied !== undefined) {
      await new Promise<void>((resolve) => occupied!.close(() => resolve()));
      occupied = undefined;
    }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('releases its PID lock and storage when MCP binding fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'echo-context-runtime-'));
    roots.push(root);
    occupied = createServer();
    await new Promise<void>((resolve) => occupied!.listen(0, '127.0.0.1', resolve));
    const address = occupied.address();
    if (typeof address !== 'object' || address === null) throw new Error('missing test address');

    const config = resolveContextRuntimeConfig({
      ECHO_CONTEXT_HOME: root,
      ECHO_CONTEXT_PORT: String(address.port),
      ECHO_CONTEXT_CAPTURE_CODEX: 'false',
      ECHO_CONTEXT_CAPTURE_CLAUDE: 'false',
    });
    await expect(startContextRuntime(config)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(existsSync(join(root, 'daemon.pid'))).toBe(false);
  });

  it('rejects a partial exact-launch identity before opening runtime state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'echo-context-runtime-'));
    roots.push(root);
    const config = resolveContextRuntimeConfig({
      ECHO_CONTEXT_HOME: root,
      ECHO_CONTEXT_ARTIFACT_DIGEST: 'a'.repeat(64),
      ECHO_CONTEXT_CAPTURE_CODEX: 'false',
      ECHO_CONTEXT_CAPTURE_CLAUDE: 'false',
    });
    await expect(startContextRuntime(config)).rejects.toThrow(
      /exact launch requires instance, artifact, promotion receipt, and database identity/,
    );
    expect(existsSync(root)).toBe(true);
    expect(existsSync(join(root, 'daemon.pid'))).toBe(false);
  });
});
