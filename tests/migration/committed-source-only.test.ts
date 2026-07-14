import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

// AC6 — dirty/replacement/filter bytes excluded. The accepted target commits only
// the pinned committed source: every tracked source-derived file's HEAD bytes
// match source-evidence, with no CRLF, no export-subst ($Format$/$Id$) smudging,
// and no uncommitted modifications.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GIT = '/usr/local/bin/git';
const gitOut = (args: string[]) => execFileSync(GIT, ['-C', ROOT, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

describe('AC6 — committed source only', () => {
  it('has no uncommitted modifications to tracked source files', () => {
    const dirty = gitOut(['status', '--porcelain', '--', 'src', 'tests'])
      .split('\n')
      .filter((l) => l && !l.startsWith('??'));
    expect(dirty).toEqual([]);
  });

  it('every ported HEAD blob matches source-evidence content hash byte-for-byte', () => {
    const parity = JSON.parse(readFileSync(join(ROOT, 'provenance/parity-matrix.v1.json'), 'utf8')) as {
      rows: { path: string; disposition: string; source_content_sha256: string }[];
    };
    for (const r of parity.rows) {
      if (r.disposition !== 'ported') continue;
      const bytes = execFileSync(GIT, ['-C', ROOT, 'cat-file', 'blob', `HEAD:${r.path}`], { maxBuffer: 64 * 1024 * 1024 });
      const h = createHash('sha256').update(bytes).digest('hex');
      if (h !== r.source_content_sha256) throw new Error(`ported HEAD blob differs from source for ${r.path}`);
    }
  }, 30000);

  it('no source-derived file carries CRLF or export-subst smudge markers', () => {
    // Scope to the source-EXTRACTED files (ported+rewritten). Target-only tools /
    // tests / provenance are authored, not extracted, and legitimately mention
    // these tokens (e.g. this test's own detection logic).
    const extraction = JSON.parse(readFileSync(join(ROOT, 'provenance/source-extraction.v1.json'), 'utf8')) as { rows: { path: string }[] };
    for (const { path: f } of extraction.rows) {
      const bytes = execFileSync(GIT, ['-C', ROOT, 'cat-file', 'blob', `HEAD:${f}`], { maxBuffer: 64 * 1024 * 1024 });
      if (bytes.includes(0x0d)) throw new Error(`CRLF byte in ${f}`);
      if (/\$Format:[^$]*\$/.test(bytes.toString('utf8'))) throw new Error(`export-subst smudge in ${f}`);
    }
  }, 30000);
});
