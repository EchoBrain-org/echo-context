import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error committed Node verifier is intentionally plain .mjs; this test asserts its public fixture surface.
import { assertAllowed, parseArgs, releaseTrace, sourceTrace } from '../../tools/fresh-clone-verifier.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const S = '1'.repeat(40);
const H = '2'.repeat(64);
type TraceStep = { executable: string; argv: string[] };

describe('AC3 — fresh clone verifier contract', () => {
  it('keeps the shell entrypoint exec-only and caller-argv-verbatim', () => {
    const lines = readFileSync(join(ROOT, 'tools/fresh-clone-acceptance.sh'), 'utf8').trim().split('\n');
    expect(lines).toEqual(['#!/bin/sh', 'exec node "$(dirname "$0")/fresh-clone-verifier.mjs" "$@"']);
  });

  it('materializes the exact source trace and counts', () => {
    const trace = sourceTrace(S, '/tmp/T', '0.1.0-dev.136.1', H) as TraceStep[];
    expect(trace.map((step) => [step.executable, step.argv])).toEqual([
      ['git', ['status', '--porcelain=v1', '--untracked-files=all']], ['git', ['rev-parse', 'HEAD']], ['npm', ['ci']],
      ['git', ['status', '--porcelain=v1', '--untracked-files=all']], ['git', ['rev-parse', 'HEAD']],
      ['npm', ['run', 'typecheck']], ['npm', ['run', 'lint']], ['npm', ['run', 'test:ci']],
      ['npm', ['run', 'verify:inventory']], ['npm', ['run', 'verify:authority']],
      ['npm', ['run', 'build:artifact', '--', '--source-sha', S, '--out', '/tmp/T']],
      ['npm', ['run', 'verify:artifact', '--', '--archive', '/tmp/T/echo-context-0.1.0-dev.136.1-source.tgz', '--checksum', '/tmp/T/echo-context-0.1.0-dev.136.1-source.tgz.sha256', '--manifest', '/tmp/T/echo-context-0.1.0-dev.136.1-source.manifest.json', '--expected-manifest-hash', H]],
      ['git', ['fsck', '--full']], ['npm', ['run', 'scan:secrets']],
      ['git', ['status', '--porcelain=v1', '--untracked-files=all']], ['git', ['rev-parse', 'HEAD']],
    ]);
    expect(trace.filter((step) => step.executable === 'git' && step.argv[0] === 'status')).toHaveLength(3);
    expect(trace.filter((step) => step.executable === 'git' && step.argv[0] === 'rev-parse')).toHaveLength(3);
    expect(trace.filter((step) => step.argv.includes('build:artifact'))).toHaveLength(1);
    expect(trace.some((step) => step.argv.includes('test:operator'))).toBe(false);
  });

  it('materializes the exact release trace without a build', () => {
    const trace = releaseTrace({ sourceSha: S, version: '0.1.0-dev.136.1', archive: '/a', checksum: '/c', manifest: '/m', expectedManifestHash: H }) as TraceStep[];
    expect(trace).toHaveLength(15);
    expect(trace.filter((step) => step.executable === 'git' && step.argv[0] === 'status')).toHaveLength(3);
    expect(trace.filter((step) => step.executable === 'git' && step.argv[0] === 'rev-parse')).toHaveLength(3);
    expect(trace.some((step) => step.argv.includes('build:artifact'))).toBe(false);
    expect(trace.filter((step) => step.argv.includes('verify:artifact'))).toHaveLength(1);
  });

  it('rejects unknown, duplicate, missing, malformed, and wrong-mode arguments', () => {
    expect(() => parseArgs(['--mode=source', '--source-sha', S])).not.toThrow();
    expect(() => parseArgs(['--mode=source', '--source-sha', S, '--source-sha', S])).toThrow(/usage/);
    expect(() => parseArgs(['--mode=source', '--source-sha', S, '--version', 'x'])).toThrow(/usage/);
    expect(() => parseArgs(['--mode=release', '--source-sha', S])).toThrow(/usage/);
    expect(() => parseArgs(['--mode=source', '--source-sha', 'short'])).toThrow(/full lowercase/);
  });

  it('rejects any child vector or script outside the exact allowlist before spawn', () => {
    const expected = { executable: 'npm', argv: ['run', 'typecheck'] };
    expect(() => assertAllowed(expected, expected)).not.toThrow();
    expect(() => assertAllowed({ executable: 'npm', argv: ['run', 'test:operator'] }, expected)).toThrow(/differs/);
    expect(() => assertAllowed({ executable: 'sh', argv: ['-c', 'npm ci'] }, expected)).toThrow(/differs/);
    expect(() => assertAllowed({ executable: 'npm', argv: ['run', 'typecheck', '--extra'] }, expected)).toThrow(/differs/);
  });
});
