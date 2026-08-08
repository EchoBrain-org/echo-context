import { createHash } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const ARTIFACT_MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_FILES = 4_096;
const MAX_MANIFEST_FILE_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_TOTAL_BYTES = 256 * 1024 * 1024;
const PROMOTION_ARTIFACT_MAX_BYTES = 512 * 1024 * 1024;
const PROMOTION_RECEIPT_MAX_BYTES = 64 * 1024;
const PROMOTION_RECEIPT_RELATIVE_PATH = 'share/echo-context/promotion-receipt.json';
const PROMOTION_TREE_MAX_BYTES = 512 * 1024 * 1024;
const PROMOTION_TREE_MAX_DEPTH = 32;
const PROMOTION_TREE_MAX_ENTRIES = 20_000;
const PROMOTION_TREE_MAX_FILE_BYTES = 64 * 1024 * 1024;
const PROMOTION_TREE_MAX_PATH_BYTES = 4 * 1024;
const PROMOTION_TREE_MAX_TOTAL_PATH_BYTES = 16 * 1024 * 1024;
const RECEIPT_KEYS = [
  'artifact',
  'artifactDigest',
  'artifactSha256',
  'cliPath',
  'installedPrefix',
  'installedTreeBytes',
  'installedTreeDigest',
  'installedTreeEntries',
  'installedTreeFiles',
  'nodeExecutable',
  'nodeVersion',
  'packageRoot',
  'schemaVersion',
  'smoke',
  'sourceCommit',
  'version',
];
const SHA_40 = /^[a-f0-9]{40}$/u;
const SHA_64 = /^[a-f0-9]{64}$/u;
const STREAM_BUFFER_BYTES = 64 * 1024;

function fail(message) {
  throw new Error(`beta promotion evidence: ${message}`);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function sameOpenedFile(expected, observed) {
  return (
    observed.isFile() &&
    observed.dev === expected.dev &&
    observed.ino === expected.ino &&
    observed.size === expected.size
  );
}

function sameEntryMetadata(before, after) {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

function openRegularFile(path, maximumBytes, expectedStat) {
  const expected = lstatSync(path);
  if (!expected.isFile()) fail(`not a regular file: ${path}`);
  if (expectedStat && !sameEntryMetadata(expectedStat, expected)) {
    fail(`file changed before hashing: ${path}`);
  }
  if (expected.size > maximumBytes) fail(`file exceeds byte budget: ${path}`);
  const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
  const fd = openSync(path, constants.O_RDONLY | noFollow);
  const observed = fstatSync(fd);
  if (!sameOpenedFile(expected, observed)) {
    closeSync(fd);
    fail(`file changed while opening: ${path}`);
  }
  return { fd, stat: observed };
}

function assertUnchangedAfterRead(path, before, after, bytesRead) {
  if (
    !after.isFile() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    bytesRead !== before.size
  ) {
    fail(`file changed while hashing: ${path}`);
  }
}

function hashOpenedRegularFile(path, maximumBytes, hash, buffer, expectedStat) {
  const opened = openRegularFile(path, maximumBytes, expectedStat);
  let bytesRead = 0;
  try {
    while (bytesRead < opened.stat.size) {
      const count = readSync(
        opened.fd,
        buffer,
        0,
        Math.min(buffer.byteLength, opened.stat.size - bytesRead),
        null,
      );
      if (count === 0) break;
      bytesRead += count;
      hash.update(buffer.subarray(0, count));
    }
    if (readSync(opened.fd, buffer, 0, 1, null) !== 0) {
      fail(`file grew while hashing: ${path}`);
    }
    assertUnchangedAfterRead(path, opened.stat, fstatSync(opened.fd), bytesRead);
    return bytesRead;
  } finally {
    closeSync(opened.fd);
  }
}

function digestRegularFileBounded(path, maximumBytes) {
  const hash = createHash('sha256');
  const bytes = hashOpenedRegularFile(
    path,
    maximumBytes,
    hash,
    Buffer.allocUnsafe(STREAM_BUFFER_BYTES),
  );
  return { bytes, digest: hash.digest('hex') };
}

function readRegularFileBounded(path, maximumBytes) {
  const opened = openRegularFile(path, maximumBytes);
  const bytes = Buffer.alloc(opened.stat.size);
  let bytesRead = 0;
  try {
    while (bytesRead < opened.stat.size) {
      const count = readSync(
        opened.fd,
        bytes,
        bytesRead,
        Math.min(STREAM_BUFFER_BYTES, opened.stat.size - bytesRead),
        null,
      );
      if (count === 0) break;
      bytesRead += count;
    }
    const extra = Buffer.allocUnsafe(1);
    if (readSync(opened.fd, extra, 0, 1, null) !== 0) {
      fail(`file grew while reading: ${path}`);
    }
    assertUnchangedAfterRead(path, opened.stat, fstatSync(opened.fd), bytesRead);
    return bytes;
  } finally {
    closeSync(opened.fd);
  }
}

function canonicalRelative(root, path) {
  const value = relative(root, path).split('\\').join('/');
  if (value.startsWith('../') || value === '..' || value.startsWith('/')) {
    fail(`installed-tree entry escapes prefix: ${path}`);
  }
  return value;
}

export function digestStagedInstalledTree(prefix) {
  const root = realpathSync(prefix);
  if (!lstatSync(root).isDirectory()) fail(`installed prefix is not a directory: ${root}`);
  const hash = createHash('sha256');
  hash.update('echo-context-installed-tree-v1\0');
  const buffer = Buffer.allocUnsafe(STREAM_BUFFER_BYTES);
  const state = { bytes: 0, entries: 0, files: 0, pathBytes: 0 };

  const visit = (directory, depth) => {
    if (depth > PROMOTION_TREE_MAX_DEPTH) {
      fail(`installed-tree depth exceeds budget: ${directory}`);
    }
    const directoryBefore = lstatSync(directory);
    if (!directoryBefore.isDirectory()) {
      fail(`installed-tree directory changed type: ${directory}`);
    }
    const dir = opendirSync(directory);
    const names = [];
    try {
      for (;;) {
        const entry = dir.readSync();
        if (entry === null) break;
        const path = join(directory, entry.name);
        const relativePath = canonicalRelative(root, path);
        if (relativePath === PROMOTION_RECEIPT_RELATIVE_PATH) continue;
        state.entries += 1;
        if (state.entries > PROMOTION_TREE_MAX_ENTRIES) {
          fail('installed-tree entry budget exceeded');
        }
        const pathBytes = Buffer.byteLength(relativePath);
        if (pathBytes === 0 || pathBytes > PROMOTION_TREE_MAX_PATH_BYTES) {
          fail(`installed-tree path exceeds budget: ${relativePath}`);
        }
        state.pathBytes += pathBytes;
        if (state.pathBytes > PROMOTION_TREE_MAX_TOTAL_PATH_BYTES) {
          fail('installed-tree cumulative path budget exceeded');
        }
        names.push(entry.name);
      }
    } finally {
      dir.closeSync();
    }

    names.sort();
    for (const name of names) {
      const path = join(directory, name);
      const relativePath = canonicalRelative(root, path);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        hash.update(`D\0${relativePath}\0`);
        visit(path, depth + 1);
        continue;
      }
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(path);
        const after = lstatSync(path);
        if (!after.isSymbolicLink() || !sameEntryMetadata(stat, after)) {
          fail(`installed-tree symlink changed while hashing: ${relativePath}`);
        }
        const targetBytes = Buffer.byteLength(target);
        if (targetBytes > PROMOTION_TREE_MAX_PATH_BYTES) {
          fail(`installed-tree symlink target exceeds budget: ${relativePath}`);
        }
        const relativeTarget = relative(root, realpathSync(path));
        if (
          relativeTarget === '..' ||
          relativeTarget.startsWith(`..${sep}`) ||
          isAbsolute(relativeTarget)
        ) {
          fail(`installed-tree symlink escapes prefix: ${relativePath}`);
        }
        state.files += 1;
        hash.update(`L\0${relativePath}\0${targetBytes}\0${target}`);
        continue;
      }
      if (!stat.isFile()) fail(`unsupported installed-tree entry: ${path}`);
      if (stat.size > PROMOTION_TREE_MAX_FILE_BYTES) {
        fail(`installed-tree file exceeds byte budget: ${relativePath}`);
      }
      if (state.bytes + stat.size > PROMOTION_TREE_MAX_BYTES) {
        fail('installed-tree aggregate byte budget exceeded');
      }
      state.files += 1;
      hash.update(`F\0${relativePath}\0${stat.size}\0`);
      state.bytes += hashOpenedRegularFile(
        path,
        PROMOTION_TREE_MAX_FILE_BYTES,
        hash,
        buffer,
        stat,
      );
    }
    const directoryAfter = lstatSync(directory);
    if (!directoryAfter.isDirectory() || !sameEntryMetadata(directoryBefore, directoryAfter)) {
      fail(`installed-tree directory changed while hashing: ${directory}`);
    }
  };

  visit(root, 0);
  return {
    bytes: state.bytes,
    digest: hash.digest('hex'),
    entries: state.entries,
    files: state.files,
  };
}

function verifyRuntimeArtifact(packageRoot) {
  const manifestPath = join(packageRoot, 'dist', 'artifact-manifest.json');
  const bytes = readRegularFileBounded(manifestPath, ARTIFACT_MANIFEST_MAX_BYTES);
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail(`runtime artifact manifest is invalid JSON: ${manifestPath}`);
  }
  if (
    !exactKeys(manifest, ['digest', 'files', 'packageVersion', 'schemaVersion', 'sourceCommit']) ||
    manifest.schemaVersion !== 1 ||
    typeof manifest.packageVersion !== 'string' ||
    !SHA_40.test(manifest.sourceCommit ?? '') ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0 ||
    manifest.files.length > MAX_MANIFEST_FILES ||
    !SHA_64.test(manifest.digest ?? '')
  ) {
    fail(`runtime artifact manifest is invalid: ${manifestPath}`);
  }
  const digest = sha256(
    JSON.stringify({
      schemaVersion: manifest.schemaVersion,
      packageVersion: manifest.packageVersion,
      sourceCommit: manifest.sourceCommit,
      files: manifest.files,
    }),
  );
  if (digest !== manifest.digest) fail('runtime artifact manifest digest mismatch');
  let totalBytes = 0;
  let previousPath = '';
  for (const entry of manifest.files) {
    if (
      !exactKeys(entry, ['bytes', 'path', 'sha256']) ||
      typeof entry.path !== 'string' ||
      entry.path.length === 0 ||
      isAbsolute(entry.path) ||
      entry.path <= previousPath ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      entry.bytes > MAX_MANIFEST_FILE_BYTES ||
      !SHA_64.test(entry.sha256 ?? '')
    ) {
      fail(`invalid runtime artifact entry: ${String(entry?.path)}`);
    }
    previousPath = entry.path;
    const filePath = resolve(packageRoot, entry.path);
    const relativePath = relative(packageRoot, filePath);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      fail(`runtime artifact entry escapes package root: ${entry.path}`);
    }
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size !== entry.bytes) {
      fail(`runtime artifact size mismatch: ${entry.path}`);
    }
    totalBytes += stat.size;
    if (totalBytes > MAX_MANIFEST_TOTAL_BYTES) {
      fail('runtime artifact exceeds total verification byte budget');
    }
    if (digestRegularFileBounded(filePath, MAX_MANIFEST_FILE_BYTES).digest !== entry.sha256) {
      fail(`runtime artifact content mismatch: ${entry.path}`);
    }
  }
  return {
    digest: manifest.digest,
    packageRoot,
    packageVersion: manifest.packageVersion,
    sourceCommit: manifest.sourceCommit,
  };
}

function canonicalReceiptObject(receipt) {
  return {
    schemaVersion: receipt.schemaVersion,
    artifact: receipt.artifact,
    artifactSha256: receipt.artifactSha256,
    artifactDigest: receipt.artifactDigest,
    sourceCommit: receipt.sourceCommit,
    version: receipt.version,
    nodeVersion: receipt.nodeVersion,
    nodeExecutable: receipt.nodeExecutable,
    installedPrefix: receipt.installedPrefix,
    cliPath: receipt.cliPath,
    packageRoot: receipt.packageRoot,
    installedTreeDigest: receipt.installedTreeDigest,
    installedTreeEntries: receipt.installedTreeEntries,
    installedTreeFiles: receipt.installedTreeFiles,
    installedTreeBytes: receipt.installedTreeBytes,
    smoke: receipt.smoke,
  };
}

function parseCanonicalReceipt(bytes) {
  let receipt;
  try {
    receipt = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('promotion receipt is not valid JSON');
  }
  if (
    !exactKeys(receipt, RECEIPT_KEYS) ||
    receipt.schemaVersion !== 1 ||
    receipt.smoke !== 'passed' ||
    !SHA_64.test(receipt.artifactSha256 ?? '') ||
    !SHA_64.test(receipt.artifactDigest ?? '') ||
    !SHA_64.test(receipt.installedTreeDigest ?? '') ||
    !SHA_40.test(receipt.sourceCommit ?? '') ||
    !Number.isSafeInteger(receipt.installedTreeEntries) ||
    receipt.installedTreeEntries < 0 ||
    receipt.installedTreeEntries > PROMOTION_TREE_MAX_ENTRIES ||
    !Number.isSafeInteger(receipt.installedTreeFiles) ||
    receipt.installedTreeFiles < 0 ||
    receipt.installedTreeFiles > receipt.installedTreeEntries ||
    !Number.isSafeInteger(receipt.installedTreeBytes) ||
    receipt.installedTreeBytes < 0 ||
    receipt.installedTreeBytes > PROMOTION_TREE_MAX_BYTES
  ) {
    fail('promotion receipt shape or identity is invalid');
  }
  for (const field of [
    'artifact',
    'nodeExecutable',
    'installedPrefix',
    'cliPath',
    'packageRoot',
  ]) {
    const value = receipt[field];
    if (
      typeof value !== 'string' ||
      !isAbsolute(value) ||
      value.includes('\0') ||
      Buffer.byteLength(value) > PROMOTION_TREE_MAX_PATH_BYTES
    ) {
      fail(`promotion receipt ${field} is invalid`);
    }
  }
  for (const field of ['version', 'nodeVersion']) {
    const value = receipt[field];
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.includes('\0') ||
      Buffer.byteLength(value) > 128
    ) {
      fail(`promotion receipt ${field} is invalid`);
    }
  }
  const canonical = Buffer.from(`${JSON.stringify(canonicalReceiptObject(receipt), null, 2)}\n`);
  if (!canonical.equals(bytes)) fail('promotion receipt bytes are not canonical');
  return receipt;
}

function assertRealPath(recorded, expected, field) {
  if (recorded !== expected || realpathSync(recorded) !== recorded) {
    fail(`promotion receipt ${field} realpath mismatch`);
  }
}

/** Verify staged promotion evidence without importing or executing candidate code. */
export function verifyStagedPromotion(smoke) {
  if (
    !smoke ||
    typeof smoke.promotionReceipt !== 'string' ||
    !SHA_64.test(smoke.promotionReceiptDigest ?? '')
  ) {
    fail('promotion result lacks its receipt identity');
  }
  const receiptBytes = readRegularFileBounded(
    smoke.promotionReceipt,
    PROMOTION_RECEIPT_MAX_BYTES,
  );
  if (sha256(receiptBytes) !== smoke.promotionReceiptDigest) {
    fail('promotion receipt byte digest does not match the promotion result');
  }
  const receipt = parseCanonicalReceipt(receiptBytes);
  if (JSON.stringify(receipt) !== JSON.stringify(canonicalReceiptObject(smoke))) {
    fail('promotion result differs from the canonical receipt');
  }
  const prefix = realpathSync(smoke.installedPrefix);
  const expectedPackageRoot = join(prefix, 'lib', 'node_modules', 'echo-context');
  const packageRoot = realpathSync(expectedPackageRoot);
  if (packageRoot !== expectedPackageRoot) {
    fail('echo-context package is not in the canonical promoted-prefix layout');
  }
  const receiptPath = join(prefix, PROMOTION_RECEIPT_RELATIVE_PATH);
  assertRealPath(smoke.installedPrefix, prefix, 'installedPrefix');
  assertRealPath(smoke.packageRoot, packageRoot, 'packageRoot');
  assertRealPath(smoke.promotionReceipt, receiptPath, 'promotionReceipt');
  const cliPath = realpathSync(join(prefix, 'bin', 'echo-context'));
  assertRealPath(smoke.cliPath, cliPath, 'cliPath');
  if (cliPath !== join(packageRoot, 'dist', 'cli.js')) {
    fail('promoted CLI path is invalid');
  }
  if (process.platform !== 'win32') {
    try {
      accessSync(cliPath, constants.X_OK);
    } catch {
      fail('promoted CLI is not executable by the current operator');
    }
  }
  assertRealPath(smoke.nodeExecutable, realpathSync(process.execPath), 'nodeExecutable');
  if (smoke.nodeVersion !== process.versions.node) {
    fail('running Node version does not match the promotion receipt');
  }
  const runtime = verifyRuntimeArtifact(packageRoot);
  if (
    runtime.digest !== smoke.artifactDigest ||
    runtime.packageVersion !== smoke.version ||
    runtime.sourceCommit !== smoke.sourceCommit
  ) {
    fail('promotion receipt package manifest identity mismatch');
  }
  const artifactPath = realpathSync(smoke.artifact);
  assertRealPath(smoke.artifact, artifactPath, 'artifact');
  if (
    digestRegularFileBounded(artifactPath, PROMOTION_ARTIFACT_MAX_BYTES).digest !==
    smoke.artifactSha256
  ) {
    fail('promotion receipt package tarball digest mismatch');
  }
  const installedTree = digestStagedInstalledTree(prefix);
  if (
    installedTree.digest !== smoke.installedTreeDigest ||
    installedTree.entries !== smoke.installedTreeEntries ||
    installedTree.files !== smoke.installedTreeFiles ||
    installedTree.bytes !== smoke.installedTreeBytes
  ) {
    fail('installed tree does not match the promotion receipt');
  }
  return { installedTree, receipt, receiptDigest: smoke.promotionReceiptDigest };
}
