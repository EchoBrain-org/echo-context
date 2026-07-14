import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  symlinkSync,
  lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type AtomicWriteModule = typeof import('../../../src/echo-home/adapters/atomic-write.js');

let tmpRoot: string;

async function loadAtomicWrite(): Promise<AtomicWriteModule> {
  return import('../../../src/echo-home/adapters/atomic-write.js');
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'echo-072-atomic-'));
  vi.resetModules();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('atomicWrite', () => {
  it('produces unique temp filenames matching <basename>.<pid>.<8hex>.tmp', async () => {
    const { atomicWrite, __setAtomicWriteTestHook } = await loadAtomicWrite();
    const target = join(tmpRoot, 'unique.txt');
    writeFileSync(target, 'seed');
    const seen = new Set<string>();
    __setAtomicWriteTestHook((tempPath) => seen.add(tempPath));
    try {
      for (let i = 0; i < 100; i++) {
        atomicWrite({ filePath: target, content: `payload-${i}` });
      }
    } finally {
      __setAtomicWriteTestHook(undefined);
    }
    expect(seen.size).toBe(100);
    const re = /^unique\.txt\.\d+\.[a-f0-9]{8}\.tmp$/;
    for (const path of seen) {
      const basename = path.split('/').pop()!;
      expect(basename).toMatch(re);
    }
    const stragglers = readdirSync(tmpRoot).filter((n) => n.endsWith('.tmp'));
    expect(stragglers).toEqual([]);
  });

  it('preserves mode 0600 on an existing file', async () => {
    const { atomicWrite } = await loadAtomicWrite();
    const target = join(tmpRoot, 'mode.txt');
    writeFileSync(target, 'old');
    chmodSync(target, 0o600);
    atomicWrite({ filePath: target, content: 'new' });
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(readFileSync(target, 'utf8')).toBe('new');
  });

  it('writes 0600 for a new file matching the allowlist (resolved against patched HOME env)', async () => {
    const originalHome = process.env.HOME;
    const stubHome = mkdtempSync(join(tmpdir(), 'echo-072-home-'));
    process.env.HOME = stubHome;
    try {
      vi.resetModules();
      const { atomicWrite } = await loadAtomicWrite();
      const target = resolve(stubHome, '.codex/config.toml');
      mkdirSync(resolve(stubHome, '.codex'), { recursive: true });
      atomicWrite({ filePath: target, content: 'allowlisted = true\n' });
      expect(statSync(target).mode & 0o777).toBe(0o600);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(stubHome, { recursive: true, force: true });
    }
  });

  it('writes 0600 when secretSensitive: true is set on a non-allowlisted tmpdir path', async () => {
    const { atomicWrite } = await loadAtomicWrite();
    const target = join(tmpRoot, 'secret-but-tmp.json');
    atomicWrite({ filePath: target, content: '{"k":1}', secretSensitive: true });
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it('does NOT write 0600 for non-allowlisted basename without secretSensitive', async () => {
    const { atomicWrite } = await loadAtomicWrite();
    const target = join(tmpRoot, 'config.toml');
    atomicWrite({ filePath: target, content: 'lookalike = 1\n' });
    const mode = statSync(target).mode & 0o777;
    expect(mode).not.toBe(0o600);
  });

  it('uses umask default for new non-sensitive files', async () => {
    const { atomicWrite } = await loadAtomicWrite();
    const target = join(tmpRoot, 'CLAUDE.md');
    atomicWrite({ filePath: target, content: '# claude\n' });
    const mode = statSync(target).mode & 0o777;
    const expected = 0o666 & ~process.umask();
    expect(mode).toBe(expected);
  });

  it('two concurrent workers writing the same path produce exactly one final payload (no garbled mix, no temps left)', async () => {
    const target = join(tmpRoot, 'concurrent.txt');
    const moduleSrcPath = fileURLToPath(
      new URL('../../../src/echo-home/adapters/atomic-write.ts', import.meta.url),
    );
    const moduleSrc = readFileSync(moduleSrcPath, 'utf8');
    const moduleJs = ts.transpileModule(moduleSrc, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
      },
    }).outputText;
    const compiledModulePath = join(tmpRoot, 'atomic-write.mjs');
    writeFileSync(compiledModulePath, moduleJs);

    const workerSrc = `
import { workerData, parentPort } from 'node:worker_threads';
const { modulePath, filePath, content } = workerData;
const mod = await import(modulePath);
try {
  mod.atomicWrite({ filePath, content });
  parentPort.postMessage({ ok: true });
} catch (err) {
  parentPort.postMessage({ ok: false, error: String(err) });
}
`;
    const workerFile = join(tmpRoot, 'worker.mjs');
    writeFileSync(workerFile, workerSrc);

    const moduleUrl = new URL(`file://${compiledModulePath}`).href;
    const payloadA = 'A'.repeat(2048);
    const payloadB = 'B'.repeat(2048);

    const runWorker = (content: string) =>
      new Promise<{ ok: boolean; error?: string }>((res, rej) => {
        const w = new Worker(workerFile, {
          workerData: { modulePath: moduleUrl, filePath: target, content },
        });
        w.on('message', (m) => {
          res(m);
        });
        w.on('error', rej);
      });

    const results = await Promise.all([runWorker(payloadA), runWorker(payloadB)]);
    for (const r of results) {
      expect(r.ok).toBe(true);
    }

    const finalContent = readFileSync(target, 'utf8');
    expect([payloadA, payloadB]).toContain(finalContent);

    const stragglers = readdirSync(tmpRoot).filter((n) => n.endsWith('.tmp'));
    expect(stragglers).toEqual([]);

    // Suppress unused-import warnings
    void dirname;
    void lstatSync;
    void symlinkSync;
  });

  it('refuses to write through a symlink when followSymlink is false (default)', async () => {
    const { atomicWrite, AtomicWriteError } = await loadAtomicWrite();
    const realTarget = join(tmpRoot, 'real.txt');
    writeFileSync(realTarget, 'real-original');
    const link = join(tmpRoot, 'link.txt');
    symlinkSync(realTarget, link);
    let caught: unknown;
    try {
      atomicWrite({ filePath: link, content: 'attempted' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AtomicWriteError);
    expect((caught as InstanceType<typeof AtomicWriteError>).code).toBe('EEXIST');
    expect(readFileSync(realTarget, 'utf8')).toBe('real-original');
  });

  it('follows symlinks when followSymlink: true and writes onto the resolved target', async () => {
    const { atomicWrite } = await loadAtomicWrite();
    const realTarget = join(tmpRoot, 'real.toml');
    writeFileSync(realTarget, 'old');
    chmodSync(realTarget, 0o600);
    const link = join(tmpRoot, 'link.toml');
    symlinkSync(realTarget, link);
    atomicWrite({ filePath: link, content: 'new', followSymlink: true, secretSensitive: true });
    expect(readFileSync(realTarget, 'utf8')).toBe('new');
    expect(statSync(realTarget).mode & 0o777).toBe(0o600);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('secretSensitive: true clamps existing 0644 to 0600', async () => {
    const { atomicWrite } = await loadAtomicWrite();
    const target = join(tmpRoot, 'config.toml');
    writeFileSync(target, 'old\n');
    chmodSync(target, 0o644);
    atomicWrite({ filePath: target, content: 'new\n', secretSensitive: true });
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });
});
