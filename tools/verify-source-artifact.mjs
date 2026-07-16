#!/usr/bin/env node

import { deflateRawSync, gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJsonBytes, parseCanonicalJsonBytes, sha256 } from './canonical-json.mjs';

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;
const BASELINE_PATH = 'provenance/extraction-baseline.v1.json';
const decoder = new TextDecoder('utf-8', { fatal: true });

function fail(message) {
  throw new Error(message);
}

function usage(message) {
  fail(`${message}\nusage: node tools/verify-source-artifact.mjs --archive <path> --checksum <path> --manifest <path> --expected-manifest-hash <64-hex>`);
}

function parseArgs(argv) {
  const names = new Map([
    ['--archive', 'archive'],
    ['--checksum', 'checksum'],
    ['--manifest', 'manifest'],
    ['--expected-manifest-hash', 'expectedManifestHash'],
  ]);
  const result = {};
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!names.has(option)) usage(`unknown argument: ${option}`);
    if (seen.has(option)) usage(`duplicate argument: ${option}`);
    seen.add(option);
    if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) usage(`missing value for ${option}`);
    result[names.get(option)] = argv[++index];
  }
  for (const [option, field] of names) if (!result[field]) usage(`missing ${option}`);
  if (!DIGEST_PATTERN.test(result.expectedManifestHash)) {
    usage('--expected-manifest-hash must be one lowercase 64-hex SHA-256');
  }
  for (const field of ['archive', 'checksum', 'manifest']) {
    if (result[field].includes('\0')) usage(`--${field} contains NUL`);
    result[field] = resolve(result[field]);
  }
  if (new Set([result.archive, result.checksum, result.manifest]).size !== 3) usage('artifact paths must be distinct');
  return result;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} keys must be exactly ${expected.join(', ')}`);
  }
}

function requireString(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(`${label} is invalid`);
}

function requireInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${label} is invalid`);
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function assertSafePath(path, label) {
  if (
    typeof path !== 'string' || path.length === 0 || path.startsWith('/') || path.includes('\\') ||
    /[\u0000-\u001f\u007f]/u.test(path)
  ) {
    fail(`${label} is unsafe: ${JSON.stringify(path)}`);
  }
  if (path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail(`${label} is unsafe: ${JSON.stringify(path)}`);
  }
}

function assertSourceOnlyPath(path) {
  const segments = path.toLowerCase().split('/');
  const forbiddenSegments = new Set([
    'node_modules', 'dist', 'build', 'artifacts', '.echo', '.echo-context',
    'launchagents', 'mutable-state', 'live-state',
  ]);
  if (segments.some((segment) => forbiddenSegments.has(segment))) {
    fail(`source artifact contains generated, install, or live-state path ${JSON.stringify(path)}`);
  }
  const leaf = segments.at(-1);
  if (
    leaf === '.env' || leaf.startsWith('.env.') ||
    /\.(?:db|sqlite|sqlite3|sock|pid|pem|p12|pfx)$/u.test(leaf)
  ) {
    fail(`source artifact contains credential or mutable-state path ${JSON.stringify(path)}`);
  }
}

function validateManifest(manifest) {
  exactKeys(manifest, [
    'schema', 'artifact_kind', 'version', 'source',
    'extraction_baseline', 'lock_hash', 'inventory', 'tar', 'source_archive', 'installable',
    'runtime_authority', 'state_authority', 'maturity',
  ], 'manifest');
  if (manifest.schema !== 'source-artifact-manifest.v1') fail('manifest schema is not source-artifact-manifest.v1');
  if (manifest.artifact_kind !== 'source') fail('manifest artifact_kind must be source');
  requireString(manifest.version, VERSION_PATTERN, 'manifest version');
  exactKeys(manifest.source, ['commit', 'tree', 'committer_timestamp'], 'manifest source');
  requireString(manifest.source.commit, SHA_PATTERN, 'manifest source commit');
  requireString(manifest.source.tree, SHA_PATTERN, 'manifest source tree');
  requireInteger(manifest.source.committer_timestamp, 'manifest source committer_timestamp');
  if (manifest.source.committer_timestamp > 0o77777777777) fail('manifest timestamp cannot be represented by USTAR');
  if (manifest.installable !== false) fail('manifest installable must be false');
  if (manifest.runtime_authority !== false) fail('manifest runtime_authority must be false');
  if (manifest.state_authority !== false) fail('manifest state_authority must be false');
  if (manifest.maturity !== 'DEV') fail('manifest maturity must be DEV');

  exactKeys(manifest.extraction_baseline, ['commit', 'tree', 'record_sha256'], 'manifest extraction_baseline');
  requireString(manifest.extraction_baseline.commit, SHA_PATTERN, 'manifest extraction baseline commit');
  requireString(manifest.extraction_baseline.tree, SHA_PATTERN, 'manifest extraction baseline tree');
  requireString(manifest.extraction_baseline.record_sha256, DIGEST_PATTERN, 'manifest extraction baseline record_sha256');

  requireString(manifest.lock_hash, DIGEST_PATTERN, 'manifest lock_hash');

  if (!Array.isArray(manifest.inventory) || manifest.inventory.length === 0) fail('manifest inventory must be nonempty');
  const paths = new Set();
  for (const [index, entry] of manifest.inventory.entries()) {
    exactKeys(entry, ['path', 'mode', 'blob_oid', 'size', 'content_sha256'], `manifest inventory[${index}]`);
    assertSafePath(entry.path, `manifest inventory[${index}].path`);
    assertSourceOnlyPath(entry.path);
    if (paths.has(entry.path)) fail(`manifest inventory duplicates ${entry.path}`);
    paths.add(entry.path);
    if (entry.mode !== '0644' && entry.mode !== '0755') fail(`manifest inventory mode is invalid for ${entry.path}`);
    requireString(entry.blob_oid, SHA_PATTERN, `manifest inventory blob_oid for ${entry.path}`);
    requireString(entry.content_sha256, DIGEST_PATTERN, `manifest inventory content_sha256 for ${entry.path}`);
    requireInteger(entry.size, `manifest inventory size for ${entry.path}`);
    if (index > 0 && compareUtf8(manifest.inventory[index - 1].path, entry.path) >= 0) {
      fail('manifest inventory is not in strict raw UTF-8 path order');
    }
  }

  exactKeys(manifest.tar, ['format', 'root', 'member_count', 'members'], 'manifest tar');
  if (manifest.tar.format !== 'ustar') fail('manifest tar format must be ustar');
  const expectedRoot = `echo-context-${manifest.version}/`;
  if (manifest.tar.root !== expectedRoot) fail(`manifest tar root must be ${expectedRoot}`);
  if (!Array.isArray(manifest.tar.members)) fail('manifest tar members must be an array');
  if (manifest.tar.member_count !== manifest.inventory.length || manifest.tar.members.length !== manifest.inventory.length) {
    fail('manifest tar member_count/members must equal inventory length');
  }
  for (let index = 0; index < manifest.tar.members.length; index += 1) {
    const member = manifest.tar.members[index];
    const inventory = manifest.inventory[index];
    exactKeys(member, ['path', 'mode', 'size', 'mtime'], `manifest tar members[${index}]`);
    assertSafePath(member.path, `manifest tar members[${index}].path`);
    if (member.path !== `${expectedRoot}${inventory.path}`) fail(`manifest tar member path/order mismatch at index ${index}`);
    if (member.mode !== inventory.mode) fail(`manifest tar mode differs from inventory for ${inventory.path}`);
    if (member.size !== inventory.size) fail(`manifest tar size differs from inventory for ${inventory.path}`);
    if (member.mtime !== manifest.source.committer_timestamp) fail(`manifest tar mtime differs from source timestamp for ${inventory.path}`);
  }

  exactKeys(
    manifest.source_archive,
    ['filename', 'checksum_filename', 'format', 'size', 'source_archive_sha256'],
    'manifest source_archive',
  );
  const archiveFilename = `echo-context-${manifest.version}-source.tgz`;
  if (manifest.source_archive.filename !== archiveFilename) fail(`source archive filename must be ${archiveFilename}`);
  if (manifest.source_archive.checksum_filename !== `${archiveFilename}.sha256`) fail('source archive checksum filename is invalid');
  if (manifest.source_archive.format !== 'gzip+ustar') fail('source archive format must be gzip+ustar');
  requireInteger(manifest.source_archive.size, 'source archive size', 1);
  requireString(manifest.source_archive.source_archive_sha256, DIGEST_PATTERN, 'source_archive_sha256');

  const generatedNames = new Set([
    manifest.source_archive.filename,
    manifest.source_archive.checksum_filename,
    `echo-context-${manifest.version}-source.manifest.json`,
  ]);
  for (const entry of manifest.inventory) {
    if (generatedNames.has(entry.path)) fail(`sidecar/generated artifact must not be an archive member: ${entry.path}`);
  }
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

function gitBlobAt(cwd, commit, path) {
  const oid = gitText(['rev-parse', `${commit}:${path}`], cwd);
  requireString(oid, SHA_PATTERN, `Git blob OID for ${path}`);
  return { oid, bytes: git(['cat-file', 'blob', oid], { cwd }).stdout };
}

function parseGitTree(raw, cwd) {
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
      fail(`source tree contains unsupported ${header[1]} ${header[2]}`);
    }
    let path;
    try {
      path = decoder.decode(record.subarray(tab + 1));
    } catch (error) {
      fail(`source tree path is not valid UTF-8: ${error.message}`);
    }
    assertSafePath(path, 'source tree path');
    assertSourceOnlyPath(path);
    entries.push({ path, pathBytes: Buffer.from(record.subarray(tab + 1)), mode: header[1] === '100755' ? '0755' : '0644', oid: header[3] });
  }
  if (start !== raw.length) fail('git ls-tree output lacks its final NUL');
  entries.sort((left, right) => Buffer.compare(left.pathBytes, right.pathBytes));
  return entries.map((entry) => {
    const bytes = git(['cat-file', 'blob', entry.oid], { cwd }).stdout;
    return {
      path: entry.path,
      mode: entry.mode,
      blob_oid: entry.oid,
      size: bytes.length,
      content_sha256: sha256(bytes),
      bytes,
    };
  });
}

function verifyGitIdentity(repoRoot, manifest) {
  const resolved = gitText(['rev-parse', '--verify', `${manifest.source.commit}^{commit}`], repoRoot);
  if (resolved !== manifest.source.commit) fail('manifest source commit does not resolve exactly to that commit object');
  const sourceTree = gitText(['rev-parse', `${manifest.source.commit}^{tree}`], repoRoot);
  if (sourceTree !== manifest.source.tree) fail('manifest source tree differs from the source commit tree');
  const timestamp = Number(gitText(['show', '-s', '--format=%ct', manifest.source.commit], repoRoot));
  if (timestamp !== manifest.source.committer_timestamp) fail('manifest source timestamp differs from Git');

  const baseline = gitBlobAt(repoRoot, manifest.source.commit, BASELINE_PATH);
  if (sha256(baseline.bytes) !== manifest.extraction_baseline.record_sha256) {
    fail('manifest extraction baseline record hash differs from committed record bytes');
  }
  let baselineRecord;
  try {
    baselineRecord = JSON.parse(decoder.decode(baseline.bytes));
  } catch (error) {
    fail(`committed extraction baseline is invalid JSON/UTF-8: ${error.message}`);
  }
  if (
    baselineRecord.schema !== 'extraction-baseline.v1' ||
    baselineRecord.baseline_commit !== manifest.extraction_baseline.commit ||
    baselineRecord.baseline_tree !== manifest.extraction_baseline.tree
  ) {
    fail('manifest extraction baseline identity differs from the committed baseline record');
  }
  const baselineResolved = gitText(['rev-parse', '--verify', `${manifest.extraction_baseline.commit}^{commit}`], repoRoot);
  if (baselineResolved !== manifest.extraction_baseline.commit) fail('baseline commit does not resolve exactly');
  const baselineTree = gitText(['rev-parse', `${manifest.extraction_baseline.commit}^{tree}`], repoRoot);
  if (baselineTree !== manifest.extraction_baseline.tree) fail('baseline tree differs from baseline commit');
  const ancestry = git(
    ['merge-base', '--is-ancestor', manifest.extraction_baseline.commit, manifest.source.commit],
    { cwd: repoRoot, allowStatus: [0, 1] },
  );
  if (ancestry.status !== 0) fail('extraction baseline is not an ancestor of source commit');

  const packageBlob = gitBlobAt(repoRoot, manifest.source.commit, 'package.json');
  const lockBlob = gitBlobAt(repoRoot, manifest.source.commit, 'package-lock.json');
  let packageJson;
  let packageLock;
  try {
    packageJson = JSON.parse(decoder.decode(packageBlob.bytes));
    packageLock = JSON.parse(decoder.decode(lockBlob.bytes));
  } catch (error) {
    fail(`committed package/lock JSON is invalid: ${error.message}`);
  }
  if (packageJson.name !== 'echo-context' || packageJson.private !== true || packageJson.version !== manifest.version) {
    fail('manifest version or package identity differs from committed package.json');
  }
  for (const lifecycle of ['preinstall', 'install', 'postinstall']) {
    if (Object.hasOwn(packageJson.scripts ?? {}, lifecycle)) fail(`committed package.json defines forbidden ${lifecycle} lifecycle`);
  }
  if (
    packageLock.name !== 'echo-context' ||
    packageLock.version !== manifest.version ||
    packageLock.packages?.['']?.name !== 'echo-context' ||
    packageLock.packages?.['']?.version !== manifest.version
  ) {
    fail('committed package-lock.json root identity/version differs from package.json and manifest');
  }
  if (sha256(lockBlob.bytes) !== manifest.lock_hash) {
    fail('manifest lock identity differs from committed package-lock.json');
  }

  const actualInventory = parseGitTree(
    git(['ls-tree', '-r', '-z', '--full-tree', manifest.source.commit], { cwd: repoRoot }).stdout,
    repoRoot,
  );
  if (actualInventory.length !== manifest.inventory.length) fail('manifest inventory length differs from source tree');
  for (let index = 0; index < actualInventory.length; index += 1) {
    const actual = actualInventory[index];
    const declared = manifest.inventory[index];
    for (const key of ['path', 'mode', 'blob_oid', 'size', 'content_sha256']) {
      if (actual[key] !== declared[key]) fail(`manifest inventory ${key} differs from Git at index ${index}`);
    }
  }
  return actualInventory;
}

function readNulField(header, offset, length, label) {
  const field = header.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  const end = nul < 0 ? field.length : nul;
  if (nul >= 0 && field.subarray(nul).some((byte) => byte !== 0)) fail(`${label} has nonzero bytes after NUL`);
  try {
    return decoder.decode(field.subarray(0, end));
  } catch (error) {
    fail(`${label} is not valid UTF-8: ${error.message}`);
  }
}

function parseOctal(header, offset, length, label) {
  const field = header.subarray(offset, offset + length);
  if (field.at(-1) !== 0) fail(`${label} lacks NUL terminator`);
  const digits = field.subarray(0, -1).toString('ascii');
  if (!/^[0-7]+$/u.test(digits)) fail(`${label} is not canonical octal`);
  const value = Number.parseInt(digits, 8);
  if (!Number.isSafeInteger(value)) fail(`${label} exceeds safe integer range`);
  return value;
}

function splitUstarPath(path) {
  if (Buffer.byteLength(path, 'utf8') <= 100) return { name: path, prefix: '' };
  for (let offset = path.lastIndexOf('/'); offset > 0; offset = path.lastIndexOf('/', offset - 1)) {
    const prefix = path.slice(0, offset);
    const name = path.slice(offset + 1);
    if (Buffer.byteLength(prefix, 'utf8') <= 155 && Buffer.byteLength(name, 'utf8') <= 100) return { name, prefix };
  }
  fail(`path does not fit USTAR fields: ${JSON.stringify(path)}`);
}

function writeOctal(header, offset, length, value) {
  const octal = value.toString(8);
  if (octal.length > length - 1) fail('USTAR numeric field overflow');
  header.write(`${octal.padStart(length - 1, '0')}\0`, offset, length, 'ascii');
}

function expectedHeader(path, mode, size, mtime) {
  const header = Buffer.alloc(512);
  const { name, prefix } = splitUstarPath(path);
  Buffer.from(name, 'utf8').copy(header, 0);
  writeOctal(header, 100, 8, Number.parseInt(mode, 8));
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, mtime);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  Buffer.from(prefix, 'utf8').copy(header, 345);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

function parseTar(tarBytes) {
  if (tarBytes.length < 1024 || tarBytes.length % 512 !== 0) fail('tar byte length is not canonical 512-byte framing');
  const members = [];
  let offset = 0;
  while (offset < tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      const second = tarBytes.subarray(offset + 512, offset + 1024);
      if (second.length !== 512 || !second.every((byte) => byte === 0) || offset + 1024 !== tarBytes.length) {
        fail('tar must end with exactly two zero blocks');
      }
      return members;
    }
    const name = readNulField(header, 0, 100, 'USTAR name');
    const prefix = readNulField(header, 345, 155, 'USTAR prefix');
    const path = prefix ? `${prefix}/${name}` : name;
    assertSafePath(path, 'USTAR member path');
    const modeNumber = parseOctal(header, 100, 8, 'USTAR mode');
    const mode = modeNumber === 0o644 ? '0644' : modeNumber === 0o755 ? '0755' : fail(`USTAR member mode is unsupported: ${modeNumber.toString(8)}`);
    const size = parseOctal(header, 124, 12, 'USTAR size');
    const mtime = parseOctal(header, 136, 12, 'USTAR mtime');
    const canonicalHeader = expectedHeader(path, mode, size, mtime);
    if (!header.equals(canonicalHeader)) fail(`USTAR header is not canonical for ${path}`);
    offset += 512;
    if (size > tarBytes.length - offset) fail(`USTAR member exceeds archive length: ${path}`);
    const bytes = tarBytes.subarray(offset, offset + size);
    offset += size;
    const padding = (512 - (size % 512)) % 512;
    if (offset + padding > tarBytes.length || tarBytes.subarray(offset, offset + padding).some((byte) => byte !== 0)) {
      fail(`USTAR member has invalid nonzero padding: ${path}`);
    }
    offset += padding;
    members.push({ path, mode, size, mtime, bytes: Buffer.from(bytes) });
  }
  fail('tar lacks its two terminal zero blocks');
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

function canonicalGzip(bytes) {
  const header = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0xff]);
  const compressed = deflateRawSync(bytes, { level: 9 });
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(bytes), 0);
  trailer.writeUInt32LE(bytes.length >>> 0, 4);
  return Buffer.concat([header, compressed, trailer]);
}

function readRegularFile(path, label) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`);
  return readFileSync(path);
}

export function verifySourceArtifact({
  cwd = process.cwd(),
  archive,
  checksum,
  manifest: manifestPath,
  expectedManifestHash,
}) {
  requireString(expectedManifestHash, DIGEST_PATTERN, 'expected manifest hash');
  const archivePath = resolve(archive);
  const checksumPath = resolve(checksum);
  const resolvedManifestPath = resolve(manifestPath);
  if (new Set([archivePath, checksumPath, resolvedManifestPath]).size !== 3) fail('artifact paths must be distinct');

  const manifestBytes = readRegularFile(resolvedManifestPath, 'manifest');
  const actualManifestHash = sha256(manifestBytes);
  if (actualManifestHash !== expectedManifestHash) {
    fail(`manifest hash ${actualManifestHash} does not equal expected manifest hash ${expectedManifestHash}`);
  }
  const manifest = parseCanonicalJsonBytes(manifestBytes, 'source artifact manifest');
  validateManifest(manifest);
  const expectedManifestFilename = `echo-context-${manifest.version}-source.manifest.json`;
  if (basename(resolvedManifestPath) !== expectedManifestFilename) fail(`manifest path basename must be ${expectedManifestFilename}`);
  if (basename(archivePath) !== manifest.source_archive.filename) fail('archive path basename differs from manifest');
  if (basename(checksumPath) !== manifest.source_archive.checksum_filename) fail('checksum path basename differs from manifest');

  const archiveBytes = readRegularFile(archivePath, 'archive');
  const sourceArchiveSha256 = sha256(archiveBytes);
  if (archiveBytes.length !== manifest.source_archive.size) fail('source archive size differs from manifest');
  if (sourceArchiveSha256 !== manifest.source_archive.source_archive_sha256) fail('source-archive SHA-256 differs from manifest');
  const checksumBytes = readRegularFile(checksumPath, 'checksum');
  const expectedChecksum = Buffer.from(`${sourceArchiveSha256}  ${manifest.source_archive.filename}\n`, 'utf8');
  if (!checksumBytes.equals(expectedChecksum)) fail('checksum sidecar is not exact coreutils sha256sum format/content');

  if (archiveBytes.length < 18 || !archiveBytes.subarray(0, 10).equals(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x02, 0xff]))) {
    fail('gzip header is not canonical or contains name/timestamp/flag metadata');
  }
  let tarBytes;
  try {
    tarBytes = gunzipSync(archiveBytes);
  } catch (error) {
    fail(`source archive is not a valid gzip stream: ${error.message}`);
  }
  if (!canonicalGzip(tarBytes).equals(archiveBytes)) fail('source archive gzip stream is not canonical deterministic encoding');

  const repoRoot = gitText(['rev-parse', '--show-toplevel'], cwd);
  const gitInventory = verifyGitIdentity(repoRoot, manifest);
  const members = parseTar(tarBytes);
  if (members.length !== manifest.tar.member_count) fail('tar member count differs from manifest');
  for (let index = 0; index < members.length; index += 1) {
    const member = members[index];
    const declared = manifest.tar.members[index];
    const gitEntry = gitInventory[index];
    for (const key of ['path', 'mode', 'size', 'mtime']) {
      if (member[key] !== declared[key]) fail(`tar member ${key} differs from manifest at index ${index}`);
    }
    if (!member.bytes.equals(gitEntry.bytes)) fail(`tar member bytes differ from committed Git blob for ${gitEntry.path}`);
  }
  return { manifest, manifestHash: actualManifestHash, sourceArchiveSha256 };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = verifySourceArtifact({
    archive: args.archive,
    checksum: args.checksum,
    manifest: args.manifest,
    expectedManifestHash: args.expectedManifestHash,
  });
  process.stdout.write(`verify-source-artifact OK: manifest_hash=${result.manifestHash} source_archive_sha256=${result.sourceArchiveSha256}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`verify-source-artifact: ${error.message}\n`);
    process.exitCode = 1;
  }
}
