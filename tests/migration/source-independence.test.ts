import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// AC6 — no source/sibling/live-state escape. The standalone target's SOURCE code
// (src/) must not import or reference Project_echo, the sibling repos, out-of-root
// modules, or live-state/home paths. (Test *fixtures* may embed sample paths as
// data, so this scans src/ only for import specifiers + forbidden tokens.)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GIT = '/usr/local/bin/git';
const gitOut = (args: string[]) => execFileSync(GIT, ['-C', ROOT, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// Out-of-root sibling/product roots that the extraction excluded. An import of
// any of these would mean the closure leaked outside the 20 sealed roots.
const FORBIDDEN_LOCAL = [
  '../coord/', '../brain/', '../daemon/', '../surfaces/', '../../src/coord/', '../../src/brain/',
  '../../src/daemon/', '../../src/surfaces/', 'echo-brain', 'echo-loop', 'Project_echo',
];

describe('AC6 — source independence', () => {
  const srcFiles = gitOut(['ls-files', '--', 'src']).split('\n').filter((f) => f.endsWith('.ts'));

  it('no src/ file imports a sibling/product/out-of-root module', () => {
    const importRe = /\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g;
    for (const f of srcFiles) {
      const text = execFileSync(GIT, ['-C', ROOT, 'cat-file', 'blob', `HEAD:${f}`], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      let m: RegExpExecArray | null;
      importRe.lastIndex = 0;
      while ((m = importRe.exec(text))) {
        const spec = m[1] ?? m[2];
        for (const bad of FORBIDDEN_LOCAL) {
          if (spec.includes(bad)) throw new Error(`src/${f} imports forbidden module '${spec}'`);
        }
      }
    }
    expect(srcFiles.length).toBeGreaterThan(0);
  });

  it('no src/ file hardcodes a Project_echo / sibling / live-state absolute path', () => {
    for (const f of srcFiles) {
      const text = execFileSync(GIT, ['-C', ROOT, 'cat-file', 'blob', `HEAD:${f}`], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      for (const bad of ['/Desktop/Project_echo', 'Desktop/echo-brain', 'Desktop/echo-loop', 'Library/Application Support/ECHO']) {
        if (text.includes(bad)) throw new Error(`src/${f} references live-state/sibling path '${bad}'`);
      }
    }
  });

  it('the default context home is echo-context-scoped, distinct from ~/.echo and siblings', () => {
    const sp = execFileSync(GIT, ['-C', ROOT, 'cat-file', 'blob', 'HEAD:src/echo-home/state-paths.ts'], { encoding: 'utf8' });
    expect(sp).toContain("ECHO_CONTEXT_HOME");
    expect(sp).toContain(".echo-context");
    expect(sp).not.toMatch(/'\.echo'/);
  });
});
