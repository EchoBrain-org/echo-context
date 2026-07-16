import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILD = join(ROOT, 'tools/build-source-artifact.mjs');
const VERIFY = join(ROOT, 'tools/verify-source-artifact.mjs');
const VERSION = '0.1.0-dev.136.1';
const HEX_64 = /^[0-9a-f]{64}$/;

interface InventoryEntry {
  path: string;
  mode: '0644' | '0755';
  blob_oid: string;
  size: number;
  content_sha256: string;
}

interface TarMember {
  path: string;
  mode: '0644' | '0755';
  size: number;
  mtime: number;
}

interface SourceManifest {
  schema: string;
  artifact_kind: string;
  version: string;
  source: { commit: string; tree: string; committer_timestamp: number };
  extraction_baseline: { commit: string; tree: string; record_sha256: string };
  lock_hash: string;
  inventory: InventoryEntry[];
  tar: { format: string; root: string; member_count: number; members: TarMember[] };
  source_archive: {
    filename: string;
    checksum_filename: string;
    format: string;
    size: number;
    source_archive_sha256: string;
  };
  installable: boolean;
  runtime_authority: boolean;
  state_authority: boolean;
  maturity: string;
}

interface BuiltArtifact {
  directory: string;
  archive: string;
  checksum: string;
  manifest: string;
  manifestHash: string;
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalJsonBytes(value: unknown): Buffer {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === 'object') {
      return Object.fromEntries(
        Object.entries(entry)
          .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return entry;
  };
  return Buffer.from(`${JSON.stringify(normalize(value))}\n`);
}

function git(repo: string, args: string[], input?: string): Buffer {
  const result = spawnSync('git', args, {
    cwd: repo,
    input,
    encoding: null,
    shell: false,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Artifact Fixture',
      GIT_AUTHOR_EMAIL: 'artifact-fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Artifact Fixture',
      GIT_COMMITTER_EMAIL: 'artifact-fixture@example.invalid',
      GIT_AUTHOR_DATE: '2026-07-16T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-07-16T00:00:00Z',
    },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString('utf8')}`);
  }
  return result.stdout;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function trackedInventory(repo: string, commit: string): Array<{
  path: string;
  mode: string;
  blob_oid: string;
  size: number;
  content_sha256: string;
}> {
  const raw = git(repo, ['ls-tree', '-r', '-z', '--full-tree', commit]);
  const records = raw.subarray(0, -1).toString('utf8').split('\0');
  return records.map((record) => {
    const match = record.match(/^(\d{6}) blob ([0-9a-f]{40})\t(.+)$/s);
    if (!match) throw new Error(`malformed fixture ls-tree row: ${record}`);
    const bytes = git(repo, ['cat-file', 'blob', match[2]]);
    return {
      path: match[3],
      mode: match[1],
      blob_oid: match[2],
      size: bytes.length,
      content_sha256: sha256(bytes),
    };
  }).sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
}

function createFixture(parent: string): { repo: string; sourceSha: string } {
  const repo = join(parent, 'fixture-repo');
  mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  mkdirSync(join(repo, 'src'));
  mkdirSync(join(repo, 'tools'));
  writeJson(join(repo, 'package.json'), {
    name: 'echo-context', version: '0.0.0', private: true, type: 'module', scripts: { test: 'node --test' },
  });
  writeJson(join(repo, 'package-lock.json'), {
    name: 'echo-context', version: '0.0.0', lockfileVersion: 3, requires: true,
    packages: { '': { name: 'echo-context', version: '0.0.0' } },
  });
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  writeFileSync(join(repo, 'src/index.mjs'), 'export const answer = 42;\n');
  writeFileSync(join(repo, 'tools/check.sh'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(repo, 'tools/check.sh'), 0o755);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'baseline']);
  const baselineCommit = git(repo, ['rev-parse', 'HEAD']).toString('utf8').trim();
  const baselineTree = git(repo, ['rev-parse', 'HEAD^{tree}']).toString('utf8').trim();
  const paths = trackedInventory(repo, baselineCommit);

  mkdirSync(join(repo, 'provenance'));
  writeJson(join(repo, 'provenance/extraction-baseline.v1.json'), {
    schema: 'extraction-baseline.v1',
    baseline_commit: baselineCommit,
    baseline_tree: baselineTree,
    path_count: paths.length,
    inventory_sha256: sha256(canonicalJsonBytes(paths)),
    paths,
    evidence: {
      migration_record: {
        path: 'raw/internal/migrations/item-135.md',
        sha256: '1'.repeat(64),
      },
      independent_review: {
        path: 'raw/internal/migrations/item-135-review.md',
        sha256: '2'.repeat(64),
      },
    },
  });
  writeJson(join(repo, 'package.json'), {
    name: 'echo-context', version: VERSION, private: true, type: 'module', scripts: { test: 'node --test' },
  });
  writeJson(join(repo, 'package-lock.json'), {
    name: 'echo-context', version: VERSION, lockfileVersion: 3, requires: true,
    packages: { '': { name: 'echo-context', version: VERSION } },
  });
  mkdirSync(join(repo, 'src', 'a'.repeat(88)));
  writeFileSync(join(repo, 'src', 'a'.repeat(88), 'long-name.mjs'), 'export const longPath = true;\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'successor source']);
  return { repo, sourceSha: git(repo, ['rev-parse', 'HEAD']).toString('utf8').trim() };
}

function artifactPaths(directory: string): Omit<BuiltArtifact, 'directory' | 'manifestHash'> {
  return {
    archive: join(directory, `echo-context-${VERSION}-source.tgz`),
    checksum: join(directory, `echo-context-${VERSION}-source.tgz.sha256`),
    manifest: join(directory, `echo-context-${VERSION}-source.manifest.json`),
  };
}

function runBuild(repo: string, sourceSha: string, directory: string): BuiltArtifact {
  const result = spawnSync(process.execPath, [BUILD, '--source-sha', sourceSha, '--out', directory], {
    cwd: repo, encoding: 'utf8', shell: false,
  });
  if (result.status !== 0) throw new Error(`build failed: ${result.stderr}`);
  const match = result.stdout.match(/^manifest_hash=([0-9a-f]{64})\n$/);
  if (!match) throw new Error(`unexpected build stdout: ${JSON.stringify(result.stdout)}`);
  return { directory, ...artifactPaths(directory), manifestHash: match[1] };
}

function runVerify(repo: string, artifact: BuiltArtifact, expectedHash = artifact.manifestHash) {
  return spawnSync(process.execPath, [
    VERIFY,
    '--archive', artifact.archive,
    '--checksum', artifact.checksum,
    '--manifest', artifact.manifest,
    '--expected-manifest-hash', expectedHash,
  ], { cwd: repo, encoding: 'utf8', shell: false });
}

function readManifest(path: string): SourceManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as SourceManifest;
}

function cloneArtifact(parent: string, source: BuiltArtifact, name: string): BuiltArtifact {
  const directory = join(parent, name);
  mkdirSync(directory);
  const paths = artifactPaths(directory);
  cpSync(source.archive, paths.archive);
  cpSync(source.checksum, paths.checksum);
  cpSync(source.manifest, paths.manifest);
  return { directory, ...paths, manifestHash: source.manifestHash };
}

let crcTable: Uint32Array | undefined;
function crc32(bytes: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
      crcTable[index] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function deterministicGzip(bytes: Buffer): Buffer {
  const header = Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0x02, 0xff]);
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(bytes), 0);
  trailer.writeUInt32LE(bytes.length >>> 0, 4);
  return Buffer.concat([header, deflateRawSync(bytes, { level: 9 }), trailer]);
}

function tarChunks(tar: Buffer): { chunks: Buffer[]; terminal: Buffer } {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (!tar.subarray(offset, offset + 512).every((byte) => byte === 0)) {
    const sizeText = tar.subarray(offset + 124, offset + 135).toString('ascii');
    const size = Number.parseInt(sizeText, 8);
    const length = 512 + size + ((512 - (size % 512)) % 512);
    chunks.push(Buffer.from(tar.subarray(offset, offset + length)));
    offset += length;
  }
  return { chunks, terminal: Buffer.from(tar.subarray(offset)) };
}

function rewriteHeaderChecksum(header: Buffer): void {
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
}

function writeOctalField(header: Buffer, offset: number, length: number, value: number): void {
  header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
  rewriteHeaderChecksum(header);
}

function writeMutatedArchive(artifact: BuiltArtifact, manifest: SourceManifest, tar: Buffer): string {
  const archive = deterministicGzip(tar);
  const digest = sha256(archive);
  manifest.source_archive.size = archive.length;
  manifest.source_archive.source_archive_sha256 = digest;
  writeFileSync(artifact.archive, archive);
  writeFileSync(artifact.checksum, `${digest}  ${manifest.source_archive.filename}\n`);
  const manifestBytes = canonicalJsonBytes(manifest);
  writeFileSync(artifact.manifest, manifestBytes);
  return sha256(manifestBytes);
}

function writeMutatedManifest(artifact: BuiltArtifact, manifest: SourceManifest): string {
  const bytes = canonicalJsonBytes(manifest);
  writeFileSync(artifact.manifest, bytes);
  return sha256(bytes);
}

describe('AC3/AC5 deterministic source artifact', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'echo-context-source-artifact-'));
  let repo: string;
  let sourceSha: string;
  let first: BuiltArtifact;
  let second: BuiltArtifact;

  beforeAll(() => {
    ({ repo, sourceSha } = createFixture(temporaryRoot));
    first = runBuild(repo, sourceSha, join(temporaryRoot, 'build-one'));
    second = runBuild(repo, sourceSha, join(temporaryRoot, 'build-two'));
  });

  afterAll(() => rmSync(temporaryRoot, { recursive: true, force: true }));

  it('builds exactly three files twice with byte-identical output and an exact final carrier', () => {
    expect(first.manifestHash).toMatch(HEX_64);
    for (const key of ['archive', 'checksum', 'manifest'] as const) {
      expect(readFileSync(first[key]).equals(readFileSync(second[key])), key).toBe(true);
    }
    expect(first.manifestHash).toBe(second.manifestHash);
    const manifest = readManifest(first.manifest);
    expect(manifest).toMatchObject({
      schema: 'source-artifact-manifest.v1',
      artifact_kind: 'source',
      version: VERSION,
      source: { commit: sourceSha },
      installable: false,
      runtime_authority: false,
      state_authority: false,
      maturity: 'DEV',
    });
  });

  it('authenticates the valid archive/checksum/manifest triple against the external manifest hash', () => {
    const result = runVerify(repo, first);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`manifest_hash=${first.manifestHash}`);
  });

  it('uses committed Git object bytes rather than dirty working-tree substitutions', () => {
    const readme = join(repo, 'README.md');
    const original = readFileSync(readme);
    writeFileSync(readme, 'dirty bytes that must never enter the archive\n');
    const dirtyBuild = runBuild(repo, sourceSha, join(temporaryRoot, 'dirty-build'));
    writeFileSync(readme, original);
    for (const key of ['archive', 'checksum', 'manifest'] as const) {
      expect(readFileSync(dirtyBuild[key]).equals(readFileSync(first[key])), key).toBe(true);
    }
  });

  it.each([
    ['unknown build argument', [BUILD, '--source-sha', '0'.repeat(40), '--out', 'out', '--extra', 'x']],
    ['duplicate build argument', [BUILD, '--source-sha', '0'.repeat(40), '--source-sha', '0'.repeat(40), '--out', 'out']],
    ['missing build argument', [BUILD, '--source-sha', '0'.repeat(40)]],
  ])('rejects %s before building', (_label, argv) => {
    const result = spawnSync(process.execPath, argv, { cwd: repo, encoding: 'utf8', shell: false });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('usage:');
  });

  it('rejects a wrong expected manifest hash even when all downloaded bytes are internally consistent', () => {
    const result = runVerify(repo, first, '0'.repeat(64));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not equal expected manifest hash');
  });

  it.each([
    ['unknown verify argument', (args: string[]) => [...args, '--extra', 'x']],
    ['duplicate verify argument', (args: string[]) => [...args, '--archive', first?.archive ?? 'unused']],
    ['missing verify argument', (args: string[]) => args.slice(0, -2)],
  ])('rejects %s before authenticating assets', (_label, mutate) => {
    const args = [
      VERIFY,
      '--archive', first.archive,
      '--checksum', first.checksum,
      '--manifest', first.manifest,
      '--expected-manifest-hash', first.manifestHash,
    ];
    const result = spawnSync(process.execPath, mutate(args), { cwd: repo, encoding: 'utf8', shell: false });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('usage:');
  });

  it('rejects noncanonical manifest bytes even when their external hash is supplied', () => {
    const artifact = cloneArtifact(temporaryRoot, first, 'noncanonical-manifest');
    const bytes = Buffer.from(`${JSON.stringify(readManifest(artifact.manifest), null, 2)}\n`);
    writeFileSync(artifact.manifest, bytes);
    const result = runVerify(repo, artifact, sha256(bytes));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('not canonical JSON');
  });

  it.each([
    ['installable', true, 'installable must be false'],
    ['runtime_authority', true, 'runtime_authority must be false'],
    ['state_authority', true, 'state_authority must be false'],
    ['maturity', 'QUALIFIED', 'maturity must be DEV'],
  ] as const)('rejects a mutated %s classification', (field, value, error) => {
    const artifact = cloneArtifact(temporaryRoot, first, `classification-${field}`);
    const manifest = readManifest(artifact.manifest);
    manifest[field] = value as never;
    const result = runVerify(repo, artifact, writeMutatedManifest(artifact, manifest));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(error);
  });

  it.each([
    ['source tree', (manifest: SourceManifest) => { manifest.source.tree = '0'.repeat(40); }, 'source tree differs'],
    ['lock hash', (manifest: SourceManifest) => { manifest.lock_hash = '0'.repeat(64); }, 'lock identity differs'],
    ['baseline record hash', (manifest: SourceManifest) => { manifest.extraction_baseline.record_sha256 = '0'.repeat(64); }, 'baseline record hash differs'],
    ['version', (manifest: SourceManifest) => { manifest.version = '0.1.0-dev.136.2'; }, 'tar root must be'],
  ])('rejects a wrong %s identity', (name, mutate, error) => {
    const artifact = cloneArtifact(temporaryRoot, first, `identity-${name.replaceAll(' ', '-')}`);
    const manifest = readManifest(artifact.manifest);
    mutate(manifest);
    const result = runVerify(repo, artifact, writeMutatedManifest(artifact, manifest));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(error);
  });

  it('rejects missing, extra, and reordered archive members', () => {
    const baseTar = gunzipSync(readFileSync(first.archive));
    const { chunks, terminal } = tarChunks(baseTar);
    expect(chunks.length).toBeGreaterThan(2);
    const variants: Array<[string, Buffer]> = [
      ['missing', Buffer.concat([...chunks.slice(1), terminal])],
      ['extra', Buffer.concat([chunks[0], ...chunks, terminal])],
      ['reordered', Buffer.concat([chunks[1], chunks[0], ...chunks.slice(2), terminal])],
    ];
    for (const [name, tar] of variants) {
      const artifact = cloneArtifact(temporaryRoot, first, `member-${name}`);
      const manifest = readManifest(artifact.manifest);
      const result = runVerify(repo, artifact, writeMutatedArchive(artifact, manifest, tar));
      expect(result.status, name).not.toBe(0);
    }
  });

  it('rejects an unsafe archive path even with refreshed archive and manifest hashes', () => {
    const artifact = cloneArtifact(temporaryRoot, first, 'unsafe-member');
    const manifest = readManifest(artifact.manifest);
    const { chunks, terminal } = tarChunks(gunzipSync(readFileSync(artifact.archive)));
    const header = chunks[0].subarray(0, 512);
    header.fill(0, 0, 100);
    header.fill(0, 345, 500);
    header.write('../escape', 0, 'utf8');
    rewriteHeaderChecksum(header);
    const hash = writeMutatedArchive(artifact, manifest, Buffer.concat([...chunks, terminal]));
    const result = runVerify(repo, artifact, hash);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('USTAR member path is unsafe');
  });

  it.each([
    ['mode', 100, 8, 0o600],
    ['timestamp', 136, 12, 1],
  ] as const)('rejects USTAR %s drift', (name, offset, length, value) => {
    const artifact = cloneArtifact(temporaryRoot, first, `tar-${name}`);
    const manifest = readManifest(artifact.manifest);
    const { chunks, terminal } = tarChunks(gunzipSync(readFileSync(artifact.archive)));
    writeOctalField(chunks[0].subarray(0, 512), offset, length, value);
    const hash = writeMutatedArchive(artifact, manifest, Buffer.concat([...chunks, terminal]));
    const result = runVerify(repo, artifact, hash);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('member');
  });

  it('rejects archive member bytes that differ from the committed Git blob', () => {
    const artifact = cloneArtifact(temporaryRoot, first, 'dirty-member-bytes');
    const manifest = readManifest(artifact.manifest);
    const { chunks, terminal } = tarChunks(gunzipSync(readFileSync(artifact.archive)));
    chunks[0][512] ^= 0x01;
    const hash = writeMutatedArchive(artifact, manifest, Buffer.concat([...chunks, terminal]));
    const result = runVerify(repo, artifact, hash);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('tar member bytes differ');
  });

  it('rejects checksum sidecar mutation', () => {
    const artifact = cloneArtifact(temporaryRoot, first, 'bad-checksum');
    writeFileSync(artifact.checksum, `${'0'.repeat(64)}  ${readManifest(artifact.manifest).source_archive.filename}\n`);
    const result = runVerify(repo, artifact);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('checksum sidecar');
  });

  it('rejects unsafe and reordered manifest inventory before trusting archive contents', () => {
    const unsafe = cloneArtifact(temporaryRoot, first, 'unsafe-inventory');
    const unsafeManifest = readManifest(unsafe.manifest);
    unsafeManifest.inventory[0].path = '../escape';
    expect(runVerify(repo, unsafe, writeMutatedManifest(unsafe, unsafeManifest)).status).not.toBe(0);

    const reordered = cloneArtifact(temporaryRoot, first, 'reordered-inventory');
    const reorderedManifest = readManifest(reordered.manifest);
    [reorderedManifest.inventory[0], reorderedManifest.inventory[1]] = [
      reorderedManifest.inventory[1], reorderedManifest.inventory[0],
    ];
    const result = runVerify(repo, reordered, writeMutatedManifest(reordered, reorderedManifest));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('strict raw UTF-8 path order');
  });

  it('refuses a source whose declared extraction baseline is not its ancestor', () => {
    const badRepo = join(temporaryRoot, 'bad-ancestry-repo');
    cpSync(repo, badRepo, { recursive: true });
    const currentTree = git(badRepo, ['rev-parse', 'HEAD^{tree}']).toString('utf8').trim();
    const orphan = git(badRepo, ['commit-tree', currentTree], 'unrelated baseline\n').toString('utf8').trim();
    const baselinePath = join(badRepo, 'provenance/extraction-baseline.v1.json');
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as {
      baseline_commit: string;
      baseline_tree: string;
    };
    baseline.baseline_commit = orphan;
    baseline.baseline_tree = currentTree;
    writeJson(baselinePath, baseline);
    git(badRepo, ['add', baselinePath]);
    git(badRepo, ['commit', '-m', 'declare unrelated baseline']);
    const badSha = git(badRepo, ['rev-parse', 'HEAD']).toString('utf8').trim();
    const result = spawnSync(process.execPath, [
      BUILD, '--source-sha', badSha, '--out', join(temporaryRoot, 'bad-ancestry-out'),
    ], { cwd: badRepo, encoding: 'utf8', shell: false });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('not an ancestor');
  });
});
