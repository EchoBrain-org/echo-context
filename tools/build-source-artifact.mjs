#!/usr/bin/env node

import { deflateRawSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJsonBytes, sha256 } from './canonical-json.mjs';

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;
const BASELINE_PATH = 'provenance/extraction-baseline.v1.json';
const LOCK_PATH = 'package-lock.json';
const PACKAGE_PATH = 'package.json';
const decoder = new TextDecoder('utf-8', { fatal: true });

function fail(message) {
  throw new Error(message);
}

function usage(message) {
  fail(`${message}\nusage: node tools/build-source-artifact.mjs --source-sha <40-hex-commit> --out <empty-directory>`);
}

function parseArgs(argv) {
  const result = { sourceSha: undefined, out: undefined };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option !== '--source-sha' && option !== '--out') usage(`unknown argument: ${option}`);
    if (seen.has(option)) usage(`duplicate argument: ${option}`);
    seen.add(option);
    if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) usage(`missing value for ${option}`);
    const value = argv[++index];
    if (option === '--source-sha') result.sourceSha = value;
    if (option === '--out') result.out = value;
  }
  if (!result.sourceSha) usage('missing --source-sha');
  if (!result.out) usage('missing --out');
  if (!SHA_PATTERN.test(result.sourceSha)) usage('--source-sha must be one lowercase full 40-hex commit OID');
  if (result.out.includes('\0')) usage('--out contains NUL');
  return result;
}

function gitEnvironment() {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
  };
}

function git(args, { cwd, allowStatus } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    env: gitEnvironment(),
    shell: false,
    encoding: null,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.error) fail(`git ${args[0]} could not start: ${result.error.message}`);
  if (result.signal) fail(`git ${args[0]} terminated by signal ${result.signal}`);
  if (allowStatus?.includes(result.status)) return result;
  if (result.status !== 0) {
    const detail = Buffer.from(result.stderr ?? '').toString('utf8').trim();
    fail(`git ${args[0]} exited ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function gitText(args, cwd) {
  return git(args, { cwd }).stdout.toString('utf8').trim();
}

function decodeUtf8(bytes, label) {
  try {
    return decoder.decode(bytes);
  } catch (error) {
    fail(`${label} is not valid UTF-8: ${error.message}`);
  }
}

function readJson(bytes, label) {
  try {
    return JSON.parse(decodeUtf8(bytes, label));
  } catch (error) {
    if (error.message.startsWith(`${label} is not valid UTF-8`)) throw error;
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} keys must be exactly ${expected.join(', ')}`);
  }
}

function assertString(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(`${label} is invalid`);
}

function validateBaselineRecord(record) {
  exactKeys(
    record,
    ['schema', 'baseline_commit', 'baseline_tree', 'path_count', 'inventory_sha256', 'paths', 'evidence'],
    'extraction baseline record',
  );
  if (record.schema !== 'extraction-baseline.v1') fail('extraction baseline schema must be extraction-baseline.v1');
  assertString(record.baseline_commit, SHA_PATTERN, 'extraction baseline commit');
  assertString(record.baseline_tree, SHA_PATTERN, 'extraction baseline tree');
  assertString(record.inventory_sha256, DIGEST_PATTERN, 'extraction baseline inventory_sha256');
  if (!Number.isSafeInteger(record.path_count) || record.path_count < 1) fail('extraction baseline path_count is invalid');
  if (!Array.isArray(record.paths) || record.paths.length !== record.path_count) {
    fail('extraction baseline paths length must equal path_count');
  }
  exactKeys(record.evidence, ['migration_record', 'independent_review'], 'extraction baseline evidence');
  for (const key of ['migration_record', 'independent_review']) {
    exactKeys(record.evidence[key], ['path', 'sha256'], `extraction baseline evidence.${key}`);
    if (typeof record.evidence[key].path !== 'string' || record.evidence[key].path.length === 0) {
      fail(`extraction baseline evidence.${key}.path is invalid`);
    }
    assertString(record.evidence[key].sha256, DIGEST_PATTERN, `extraction baseline evidence.${key}.sha256`);
  }
}

function assertSafePath(path) {
  if (typeof path !== 'string' || path.length === 0) fail('source tree contains an empty path');
  if (path.startsWith('/') || path.includes('\\') || /[\u0000-\u001f\u007f]/u.test(path)) {
    fail(`source tree contains unsafe path ${JSON.stringify(path)}`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail(`source tree contains unsafe path ${JSON.stringify(path)}`);
  }
}

function assertSourceOnlyPath(path) {
  const lower = path.toLowerCase();
  const segments = lower.split('/');
  const forbiddenSegments = new Set([
    'node_modules', 'dist', 'build', 'artifacts', '.echo', '.echo-context',
    'launchagents', 'mutable-state', 'live-state',
  ]);
  if (segments.some((segment) => forbiddenSegments.has(segment))) {
    fail(`source artifact rejects generated, install, or live-state path ${JSON.stringify(path)}`);
  }
  const leaf = segments.at(-1);
  if (
    leaf === '.env' || leaf.startsWith('.env.') ||
    /\.(?:db|sqlite|sqlite3|sock|pid|pem|p12|pfx)$/u.test(leaf)
  ) {
    fail(`source artifact rejects credential or mutable-state path ${JSON.stringify(path)}`);
  }
}

function parseTree(raw, cwd) {
  const entries = [];
  let start = 0;
  for (let offset = 0; offset < raw.length; offset += 1) {
    if (raw[offset] !== 0) continue;
    if (offset === start) fail('git ls-tree emitted an empty record');
    const record = raw.subarray(start, offset);
    start = offset + 1;
    const tab = record.indexOf(0x09);
    if (tab < 0) fail('git ls-tree emitted a malformed record without TAB');
    const header = record.subarray(0, tab).toString('ascii').match(/^(\d{6}) ([a-z]+) ([0-9a-f]{40})$/);
    if (!header) fail('git ls-tree emitted a malformed record header');
    if (header[2] !== 'blob' || (header[1] !== '100644' && header[1] !== '100755')) {
      fail(`source artifact supports only regular Git blobs, got ${header[1]} ${header[2]}`);
    }
    const pathBytes = record.subarray(tab + 1);
    const path = decodeUtf8(pathBytes, 'Git path');
    if (!Buffer.from(path, 'utf8').equals(pathBytes)) fail(`Git path is not canonical UTF-8: ${JSON.stringify(path)}`);
    assertSafePath(path);
    assertSourceOnlyPath(path);
    entries.push({ gitMode: header[1], blobOid: header[3], path, pathBytes: Buffer.from(pathBytes) });
  }
  if (start !== raw.length) fail('git ls-tree output lacks its final NUL');
  entries.sort((left, right) => Buffer.compare(left.pathBytes, right.pathBytes));
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1].path === entries[index].path) fail(`duplicate source path ${entries[index].path}`);
  }
  if (entries.length === 0) fail('source tree is empty');
  return entries.map((entry) => {
    const content = git(['cat-file', 'blob', entry.blobOid], { cwd }).stdout;
    return {
      path: entry.path,
      mode: entry.gitMode === '100755' ? '0755' : '0644',
      blob_oid: entry.blobOid,
      size: content.length,
      content_sha256: sha256(content),
      content,
    };
  });
}

function parseSource(cwd, sourceSha) {
  const resolved = gitText(['rev-parse', '--verify', `${sourceSha}^{commit}`], cwd);
  if (resolved !== sourceSha) fail(`--source-sha must name the commit object exactly; resolved ${resolved}`);
  const sourceTree = gitText(['rev-parse', `${sourceSha}^{tree}`], cwd);
  assertString(sourceTree, SHA_PATTERN, 'source tree');
  const timestampText = gitText(['show', '-s', '--format=%ct', sourceSha], cwd);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(timestampText)) fail('source commit timestamp is invalid');
  const sourceCommitTimestamp = Number(timestampText);
  if (!Number.isSafeInteger(sourceCommitTimestamp) || sourceCommitTimestamp < 0 || sourceCommitTimestamp > 0o77777777777) {
    fail('source commit timestamp cannot be represented by USTAR');
  }

  const rawTree = git(['ls-tree', '-r', '-z', '--full-tree', sourceSha], { cwd }).stdout;
  const inventoryWithContent = parseTree(rawTree, cwd);
  const byPath = new Map(inventoryWithContent.map((entry) => [entry.path, entry]));
  for (const required of [PACKAGE_PATH, LOCK_PATH, BASELINE_PATH]) {
    if (!byPath.has(required)) fail(`source commit lacks required tracked path ${required}`);
  }

  const packageJson = readJson(byPath.get(PACKAGE_PATH).content, PACKAGE_PATH);
  if (packageJson.name !== 'echo-context') fail('package.json name must be echo-context');
  if (packageJson.private !== true) fail('package.json must remain private');
  if (!VERSION_PATTERN.test(packageJson.version)) fail(`package.json version is not a supported exact version: ${packageJson.version}`);
  for (const lifecycle of ['preinstall', 'install', 'postinstall']) {
    if (Object.hasOwn(packageJson.scripts ?? {}, lifecycle)) fail(`package.json must not define ${lifecycle}`);
  }

  const packageLock = readJson(byPath.get(LOCK_PATH).content, LOCK_PATH);
  if (packageLock.name !== 'echo-context' || packageLock.version !== packageJson.version) {
    fail('package-lock.json root name/version must equal package.json');
  }
  if (
    !packageLock.packages ||
    !packageLock.packages[''] ||
    packageLock.packages[''].name !== 'echo-context' ||
    packageLock.packages[''].version !== packageJson.version
  ) {
    fail('package-lock.json packages[""] name/version must equal package.json');
  }

  const baselineBytes = byPath.get(BASELINE_PATH).content;
  const baselineRecord = readJson(baselineBytes, BASELINE_PATH);
  validateBaselineRecord(baselineRecord);
  const baselineResolved = gitText(['rev-parse', '--verify', `${baselineRecord.baseline_commit}^{commit}`], cwd);
  if (baselineResolved !== baselineRecord.baseline_commit) fail('extraction baseline commit does not resolve exactly');
  const baselineTree = gitText(['rev-parse', `${baselineRecord.baseline_commit}^{tree}`], cwd);
  if (baselineTree !== baselineRecord.baseline_tree) fail('extraction baseline tree does not match its commit');
  const ancestry = git(
    ['merge-base', '--is-ancestor', baselineRecord.baseline_commit, sourceSha],
    { cwd, allowStatus: [0, 1] },
  );
  if (ancestry.status !== 0) fail('extraction baseline is not an ancestor of the source commit');

  const inventory = inventoryWithContent.map(({ content: _content, ...entry }) => entry);
  return {
    sourceTree,
    sourceCommitTimestamp,
    version: packageJson.version,
    baselineRecord,
    baselineRecordSha256: sha256(baselineBytes),
    lock: byPath.get(LOCK_PATH),
    inventory,
    inventoryWithContent,
  };
}

function writeOctal(header, offset, length, value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} is not a nonnegative safe integer`);
  const octal = value.toString(8);
  if (octal.length > length - 1) fail(`${label} does not fit its USTAR field`);
  header.write(`${octal.padStart(length - 1, '0')}\0`, offset, length, 'ascii');
}

function splitUstarPath(path) {
  const bytes = Buffer.from(path, 'utf8');
  if (bytes.length <= 100) return { name: path, prefix: '' };
  for (let offset = path.lastIndexOf('/'); offset > 0; offset = path.lastIndexOf('/', offset - 1)) {
    const prefix = path.slice(0, offset);
    const name = path.slice(offset + 1);
    if (Buffer.byteLength(prefix, 'utf8') <= 155 && Buffer.byteLength(name, 'utf8') <= 100) {
      return { name, prefix };
    }
  }
  fail(`path does not fit USTAR name/prefix fields: ${JSON.stringify(path)}`);
}

function writeField(header, offset, length, value, label) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.includes(0) || bytes.length > length) fail(`${label} does not fit its USTAR field`);
  bytes.copy(header, offset);
}

function tarHeader(path, mode, size, mtime) {
  const header = Buffer.alloc(512);
  const { name, prefix } = splitUstarPath(path);
  writeField(header, 0, 100, name, 'USTAR name');
  writeOctal(header, 100, 8, Number.parseInt(mode, 8), 'USTAR mode');
  writeOctal(header, 108, 8, 0, 'USTAR uid');
  writeOctal(header, 116, 8, 0, 'USTAR gid');
  writeOctal(header, 124, 12, size, 'USTAR size');
  writeOctal(header, 136, 12, mtime, 'USTAR mtime');
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  writeField(header, 345, 155, prefix, 'USTAR prefix');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const encoded = checksum.toString(8);
  if (encoded.length > 6) fail('USTAR header checksum overflow');
  header.write(`${encoded.padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

function buildTar(root, inventoryWithContent, timestamp) {
  const parts = [];
  const members = [];
  for (const entry of inventoryWithContent) {
    const archivePath = `${root}${entry.path}`;
    const header = tarHeader(archivePath, entry.mode, entry.content.length, timestamp);
    const paddingLength = (512 - (entry.content.length % 512)) % 512;
    parts.push(header, entry.content);
    if (paddingLength > 0) parts.push(Buffer.alloc(paddingLength));
    members.push({
      path: archivePath,
      mode: entry.mode,
      size: entry.content.length,
      mtime: timestamp,
    });
  }
  parts.push(Buffer.alloc(1024));
  return { bytes: Buffer.concat(parts), members };
}

let crcTable;
function crc32(bytes) {
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

function deterministicGzip(bytes) {
  const header = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0xff]);
  const compressed = deflateRawSync(bytes, { level: 9 });
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(bytes), 0);
  trailer.writeUInt32LE(bytes.length >>> 0, 4);
  return Buffer.concat([header, compressed, trailer]);
}

function prepareOutputDirectory(outArg) {
  const out = resolve(outArg);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const stat = lstatSync(out);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('--out must resolve to a real directory, not a symlink');
  const existing = readdirSync(out);
  if (existing.length !== 0) fail(`--out must be empty; found ${existing.length} existing entr${existing.length === 1 ? 'y' : 'ies'}`);
  return out;
}

export function buildSourceArtifact({ cwd = process.cwd(), sourceSha, out: outArg }) {
  if (!SHA_PATTERN.test(sourceSha)) fail('sourceSha must be one lowercase full 40-hex commit OID');
  const repoRoot = gitText(['rev-parse', '--show-toplevel'], cwd);
  const source = parseSource(repoRoot, sourceSha);
  const root = `echo-context-${source.version}/`;
  assertSafePath(root.slice(0, -1));
  const tar = buildTar(root, source.inventoryWithContent, source.sourceCommitTimestamp);
  const archiveBytes = deterministicGzip(tar.bytes);
  const archiveFilename = `echo-context-${source.version}-source.tgz`;
  const checksumFilename = `${archiveFilename}.sha256`;
  const manifestFilename = `echo-context-${source.version}-source.manifest.json`;
  const sourceArchiveSha256 = sha256(archiveBytes);
  const manifest = {
    schema: 'source-artifact-manifest.v1',
    artifact_kind: 'source',
    version: source.version,
    source: {
      commit: sourceSha,
      tree: source.sourceTree,
      committer_timestamp: source.sourceCommitTimestamp,
    },
    extraction_baseline: {
      commit: source.baselineRecord.baseline_commit,
      tree: source.baselineRecord.baseline_tree,
      record_sha256: source.baselineRecordSha256,
    },
    lock_hash: source.lock.content_sha256,
    inventory: source.inventory,
    tar: {
      format: 'ustar',
      root,
      member_count: tar.members.length,
      members: tar.members,
    },
    source_archive: {
      filename: archiveFilename,
      checksum_filename: checksumFilename,
      format: 'gzip+ustar',
      size: archiveBytes.length,
      source_archive_sha256: sourceArchiveSha256,
    },
    installable: false,
    runtime_authority: false,
    state_authority: false,
    maturity: 'DEV',
  };
  const manifestBytes = canonicalJsonBytes(manifest);
  const manifestHash = sha256(manifestBytes);
  const checksumBytes = Buffer.from(`${sourceArchiveSha256}  ${archiveFilename}\n`, 'utf8');
  const out = prepareOutputDirectory(outArg);
  const written = [];
  try {
    for (const [name, bytes] of [
      [archiveFilename, archiveBytes],
      [checksumFilename, checksumBytes],
      [manifestFilename, manifestBytes],
    ]) {
      const path = resolve(out, name);
      if (basename(path) !== name) fail(`unsafe output filename ${name}`);
      writeFileSync(path, bytes, { flag: 'wx', mode: 0o644 });
      written.push(path);
    }
  } catch (error) {
    for (const path of written) rmSync(path, { force: true });
    throw error;
  }
  return {
    archive: resolve(out, archiveFilename),
    checksum: resolve(out, checksumFilename),
    manifest: resolve(out, manifestFilename),
    manifestHash,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = buildSourceArtifact({ sourceSha: args.sourceSha, out: args.out });
  process.stdout.write(`manifest_hash=${result.manifestHash}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`build-source-artifact: ${error.message}\n`);
    process.exitCode = 1;
  }
}
