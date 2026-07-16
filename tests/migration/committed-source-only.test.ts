import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASELINE = '0cf7b006eba665c0bf55e82ff04da70f19f01ebb';
const git = (args: string[]) => execFileSync('git', ['-C', ROOT, ...args], { maxBuffer: 64 * 1024 * 1024 });

describe('AC2 — committed baseline source only', () => {
  it('every ported baseline blob matches source-evidence content byte-for-byte', () => {
    const parity = JSON.parse(readFileSync(join(ROOT, 'provenance/parity-matrix.v1.json'), 'utf8')) as {
      rows: { path: string; disposition: string; source_content_sha256: string }[];
    };
    for (const row of parity.rows) {
      if (row.disposition !== 'ported') continue;
      const bytes = git(['cat-file', 'blob', `${BASELINE}:${row.path}`]);
      expect(createHash('sha256').update(bytes).digest('hex'), row.path).toBe(row.source_content_sha256);
    }
  }, 30_000);

  it('no source-derived baseline blob carries CRLF or export-subst smudge markers', () => {
    const extraction = JSON.parse(readFileSync(join(ROOT, 'provenance/source-extraction.v1.json'), 'utf8')) as { rows: { path: string }[] };
    for (const { path } of extraction.rows) {
      const bytes = git(['cat-file', 'blob', `${BASELINE}:${path}`]);
      expect(bytes.includes(0x0d), path).toBe(false);
      expect(/\$Format:[^$]*\$/.test(bytes.toString('utf8')), path).toBe(false);
    }
  }, 30_000);
});
