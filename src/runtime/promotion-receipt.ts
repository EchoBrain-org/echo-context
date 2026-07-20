import { createHash, type Hash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  readlinkSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { verifyRuntimeArtifact } from "./artifact-identity.js";

const SHA256_RE = /^[a-f0-9]{64}$/;
const SOURCE_COMMIT_RE = /^[a-f0-9]{40}$/;
const NODE_VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const STREAM_BUFFER_BYTES = 64 * 1024;

export const PROMOTION_RECEIPT_RELATIVE_PATH =
  "share/echo-context/promotion-receipt.json";
export const PROMOTION_RECEIPT_MAX_BYTES = 64 * 1024;
export const PROMOTION_ARTIFACT_MAX_BYTES = 512 * 1024 * 1024;
export const PROMOTION_TREE_MAX_ENTRIES = 20_000;
export const PROMOTION_TREE_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const PROMOTION_TREE_MAX_BYTES = 512 * 1024 * 1024;
export const PROMOTION_TREE_MAX_DEPTH = 32;
export const PROMOTION_TREE_MAX_PATH_BYTES = 4 * 1024;
export const PROMOTION_TREE_MAX_TOTAL_PATH_BYTES = 16 * 1024 * 1024;

const RECEIPT_KEYS = [
  "schemaVersion",
  "artifact",
  "artifactSha256",
  "artifactDigest",
  "sourceCommit",
  "version",
  "nodeVersion",
  "nodeExecutable",
  "installedPrefix",
  "cliPath",
  "packageRoot",
  "installedTreeDigest",
  "installedTreeEntries",
  "installedTreeFiles",
  "installedTreeBytes",
  "smoke",
] as const;

export interface PromotionReceipt {
  schemaVersion: 1;
  /** Real path of the exact npm package tarball that was installed. */
  artifact: string;
  artifactSha256: string;
  /** Digest of dist/artifact-manifest.json's canonical body. */
  artifactDigest: string;
  sourceCommit: string;
  version: string;
  nodeVersion: string;
  nodeExecutable: string;
  installedPrefix: string;
  cliPath: string;
  packageRoot: string;
  installedTreeDigest: string;
  installedTreeEntries: number;
  installedTreeFiles: number;
  installedTreeBytes: number;
  smoke: "passed";
}

export interface InstalledTreeDigest {
  digest: string;
  entries: number;
  files: number;
  bytes: number;
}

export interface VerifiedPromotionReceipt {
  receipt: PromotionReceipt;
  receiptPath: string;
  receiptDigest: string;
  installedTree: InstalledTreeDigest;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertBoundedAbsolutePath(
  value: unknown,
  field: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value.includes("\0") ||
    Buffer.byteLength(value) > PROMOTION_TREE_MAX_PATH_BYTES
  ) {
    throw new Error(
      `promotion receipt ${field} must be a bounded absolute path`,
    );
  }
}

function assertBoundedString(
  value: unknown,
  field: string,
  maxBytes: number,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value) > maxBytes
  ) {
    throw new Error(`promotion receipt ${field} is invalid`);
  }
}

function assertBoundedCount(
  value: unknown,
  field: string,
  maximum: number,
): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > maximum
  ) {
    throw new Error(`promotion receipt ${field} is outside its budget`);
  }
}

function assertPromotionReceipt(
  value: unknown,
): asserts value is PromotionReceipt {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("promotion receipt must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = [...RECEIPT_KEYS].sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error("promotion receipt has missing or unknown fields");
  }
  if (record["schemaVersion"] !== 1 || record["smoke"] !== "passed") {
    throw new Error("promotion receipt schema or smoke result is invalid");
  }
  assertBoundedAbsolutePath(record["artifact"], "artifact");
  assertBoundedAbsolutePath(record["nodeExecutable"], "nodeExecutable");
  assertBoundedAbsolutePath(record["installedPrefix"], "installedPrefix");
  assertBoundedAbsolutePath(record["cliPath"], "cliPath");
  assertBoundedAbsolutePath(record["packageRoot"], "packageRoot");
  assertBoundedString(record["version"], "version", 128);
  assertBoundedString(record["nodeVersion"], "nodeVersion", 128);
  if (!NODE_VERSION_RE.test(record["nodeVersion"])) {
    throw new Error("promotion receipt nodeVersion is invalid");
  }
  if (
    typeof record["artifactSha256"] !== "string" ||
    !SHA256_RE.test(record["artifactSha256"]) ||
    typeof record["artifactDigest"] !== "string" ||
    !SHA256_RE.test(record["artifactDigest"]) ||
    typeof record["installedTreeDigest"] !== "string" ||
    !SHA256_RE.test(record["installedTreeDigest"]) ||
    typeof record["sourceCommit"] !== "string" ||
    !SOURCE_COMMIT_RE.test(record["sourceCommit"])
  ) {
    throw new Error(
      "promotion receipt contains an invalid digest or source commit",
    );
  }
  assertBoundedCount(
    record["installedTreeEntries"],
    "installedTreeEntries",
    PROMOTION_TREE_MAX_ENTRIES,
  );
  assertBoundedCount(
    record["installedTreeFiles"],
    "installedTreeFiles",
    PROMOTION_TREE_MAX_ENTRIES,
  );
  assertBoundedCount(
    record["installedTreeBytes"],
    "installedTreeBytes",
    PROMOTION_TREE_MAX_BYTES,
  );
  if (record["installedTreeFiles"] > record["installedTreeEntries"]) {
    throw new Error("promotion receipt file count exceeds entry count");
  }
}

function canonicalReceiptObject(receipt: PromotionReceipt): PromotionReceipt {
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

/** Encode the only accepted receipt representation. Exact bytes are promoted. */
export function encodePromotionReceipt(receipt: PromotionReceipt): Buffer {
  assertPromotionReceipt(receipt);
  return Buffer.from(
    `${JSON.stringify(canonicalReceiptObject(receipt), null, 2)}\n`,
    "utf8",
  );
}

export function promotionReceiptDigest(receiptBytes: Buffer): string {
  if (receiptBytes.byteLength > PROMOTION_RECEIPT_MAX_BYTES) {
    throw new Error("promotion receipt exceeds its byte budget");
  }
  return sha256(receiptBytes);
}

function sameOpenedFile(expected: Stats, observed: Stats): boolean {
  return (
    observed.isFile() &&
    observed.dev === expected.dev &&
    observed.ino === expected.ino &&
    observed.size === expected.size
  );
}

function sameEntryMetadata(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

function openRegularFile(
  path: string,
  maximumBytes: number,
  expectedStat?: Stats,
): {
  fd: number;
  stat: Stats;
} {
  const expected = lstatSync(path);
  if (!expected.isFile()) throw new Error(`not a regular file: ${path}`);
  if (
    expectedStat !== undefined &&
    !sameEntryMetadata(expectedStat, expected)
  ) {
    throw new Error(`file changed before hashing: ${path}`);
  }
  if (expected.size > maximumBytes) {
    throw new Error(`file exceeds byte budget: ${path}`);
  }
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const fd = openSync(path, constants.O_RDONLY | noFollow);
  const observed = fstatSync(fd);
  if (!sameOpenedFile(expected, observed)) {
    closeSync(fd);
    throw new Error(`file changed while opening: ${path}`);
  }
  return { fd, stat: observed };
}

function assertUnchangedAfterRead(
  path: string,
  before: Stats,
  after: Stats,
  bytesRead: number,
): void {
  if (
    !after.isFile() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    bytesRead !== before.size
  ) {
    throw new Error(`file changed while hashing: ${path}`);
  }
}

function hashOpenedRegularFile(
  path: string,
  maximumBytes: number,
  hash: Hash,
  buffer: Buffer,
  expectedStat?: Stats,
): number {
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
    const extra = readSync(opened.fd, buffer, 0, 1, null);
    if (extra !== 0) throw new Error(`file grew while hashing: ${path}`);
    assertUnchangedAfterRead(
      path,
      opened.stat,
      fstatSync(opened.fd),
      bytesRead,
    );
    return bytesRead;
  } finally {
    closeSync(opened.fd);
  }
}

/** Hash one regular file without ever retaining its content in memory. */
export function digestRegularFileBounded(
  path: string,
  maximumBytes = PROMOTION_ARTIFACT_MAX_BYTES,
): { digest: string; bytes: number } {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new Error(
      "file hash byte budget must be a non-negative safe integer",
    );
  }
  const hash = createHash("sha256");
  const bytes = hashOpenedRegularFile(
    path,
    maximumBytes,
    hash,
    Buffer.allocUnsafe(STREAM_BUFFER_BYTES),
  );
  return { digest: hash.digest("hex"), bytes };
}

function readRegularFileBounded(path: string, maximumBytes: number): Buffer {
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
      throw new Error(`file grew while reading: ${path}`);
    }
    assertUnchangedAfterRead(
      path,
      opened.stat,
      fstatSync(opened.fd),
      bytesRead,
    );
    return bytes;
  } finally {
    closeSync(opened.fd);
  }
}

function assertRelativePathBudget(
  relativePath: string,
  pathBytes: number,
): number {
  const bytes = Buffer.byteLength(relativePath);
  if (bytes === 0 || bytes > PROMOTION_TREE_MAX_PATH_BYTES) {
    throw new Error(`installed-tree path exceeds budget: ${relativePath}`);
  }
  const next = pathBytes + bytes;
  if (next > PROMOTION_TREE_MAX_TOTAL_PATH_BYTES) {
    throw new Error("installed-tree cumulative path budget exceeded");
  }
  return next;
}

function canonicalRelative(root: string, path: string): string {
  const value = relative(root, path).split("\\").join("/");
  if (value.startsWith("../") || value === ".." || value.startsWith("/")) {
    throw new Error(`installed-tree entry escapes prefix: ${path}`);
  }
  return value;
}

/**
 * Digest the installed global prefix with hard entry, path, depth, per-file,
 * and aggregate byte budgets. The receipt file is the sole exclusion, so its
 * own write cannot invalidate the tree it attests.
 */
export function digestPromotionInstalledTree(
  prefix: string,
): InstalledTreeDigest {
  const root = realpathSync(prefix);
  if (!lstatSync(root).isDirectory()) {
    throw new Error(`installed prefix is not a directory: ${root}`);
  }
  const hash = createHash("sha256");
  hash.update("echo-context-installed-tree-v1\0");
  const buffer = Buffer.allocUnsafe(STREAM_BUFFER_BYTES);
  const state = { entries: 0, files: 0, bytes: 0, pathBytes: 0 };

  const visit = (directory: string, depth: number): void => {
    if (depth > PROMOTION_TREE_MAX_DEPTH) {
      throw new Error(`installed-tree depth exceeds budget: ${directory}`);
    }
    const directoryBefore = lstatSync(directory);
    if (!directoryBefore.isDirectory()) {
      throw new Error(`installed-tree directory changed type: ${directory}`);
    }
    const dir = opendirSync(directory);
    const names: string[] = [];
    try {
      for (;;) {
        const entry = dir.readSync();
        if (entry === null) break;
        const path = join(directory, entry.name);
        const relativePath = canonicalRelative(root, path);
        if (relativePath === PROMOTION_RECEIPT_RELATIVE_PATH) continue;
        state.entries += 1;
        if (state.entries > PROMOTION_TREE_MAX_ENTRIES) {
          throw new Error("installed-tree entry budget exceeded");
        }
        state.pathBytes = assertRelativePathBudget(
          relativePath,
          state.pathBytes,
        );
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
        const symlinkAfter = lstatSync(path);
        if (
          !symlinkAfter.isSymbolicLink() ||
          !sameEntryMetadata(stat, symlinkAfter)
        ) {
          throw new Error(
            `installed-tree symlink changed while hashing: ${relativePath}`,
          );
        }
        const targetBytes = Buffer.byteLength(target);
        if (targetBytes > PROMOTION_TREE_MAX_PATH_BYTES) {
          throw new Error(
            `installed-tree symlink target exceeds budget: ${relativePath}`,
          );
        }
        const resolvedTarget = realpathSync(path);
        const relativeTarget = relative(root, resolvedTarget);
        if (
          relativeTarget === ".." ||
          relativeTarget.startsWith(`..${sep}`) ||
          isAbsolute(relativeTarget)
        ) {
          throw new Error(
            `installed-tree symlink escapes prefix: ${relativePath}`,
          );
        }
        state.files += 1;
        hash.update(`L\0${relativePath}\0${targetBytes}\0${target}`);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`unsupported installed-tree entry: ${path}`);
      }
      if (stat.size > PROMOTION_TREE_MAX_FILE_BYTES) {
        throw new Error(
          `installed-tree file exceeds byte budget: ${relativePath}`,
        );
      }
      if (state.bytes + stat.size > PROMOTION_TREE_MAX_BYTES) {
        throw new Error("installed-tree aggregate byte budget exceeded");
      }
      state.files += 1;
      hash.update(`F\0${relativePath}\0${stat.size}\0`);
      const observedBytes = hashOpenedRegularFile(
        path,
        PROMOTION_TREE_MAX_FILE_BYTES,
        hash,
        buffer,
        stat,
      );
      state.bytes += observedBytes;
    }
    const directoryAfter = lstatSync(directory);
    if (
      !directoryAfter.isDirectory() ||
      !sameEntryMetadata(directoryBefore, directoryAfter)
    ) {
      throw new Error(
        `installed-tree directory changed while hashing: ${directory}`,
      );
    }
  };

  visit(root, 0);
  return {
    digest: hash.digest("hex"),
    entries: state.entries,
    files: state.files,
    bytes: state.bytes,
  };
}

export function promotionReceiptPathForPackageRoot(packageRoot: string): {
  prefix: string;
  receiptPath: string;
} {
  const realPackageRoot = realpathSync(packageRoot);
  const prefix = realpathSync(resolve(realPackageRoot, "../../.."));
  const expectedPackageRoot = realpathSync(
    join(prefix, "lib", "node_modules", "echo-context"),
  );
  if (expectedPackageRoot !== realPackageRoot) {
    throw new Error(
      "echo-context package is not in the promoted global-prefix layout",
    );
  }
  return {
    prefix,
    receiptPath: join(prefix, PROMOTION_RECEIPT_RELATIVE_PATH),
  };
}

function parsePromotionReceipt(bytes: Buffer): PromotionReceipt {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("promotion receipt is not valid JSON");
  }
  assertPromotionReceipt(value);
  const canonical = encodePromotionReceipt(value);
  if (!canonical.equals(bytes)) {
    throw new Error("promotion receipt bytes are not canonical");
  }
  return value;
}

function assertRealPath(
  recorded: string,
  expected: string,
  field: string,
): void {
  if (recorded !== expected || realpathSync(recorded) !== recorded) {
    throw new Error(`promotion receipt ${field} realpath mismatch`);
  }
}

/** Verify the externally selected receipt and every object it binds. */
export function verifyPromotionReceipt(input: {
  startPath: string;
  cliPath?: string;
  expectedArtifactDigest: string;
  expectedPromotionReceiptDigest: string;
}): VerifiedPromotionReceipt {
  if (!SHA256_RE.test(input.expectedArtifactDigest)) {
    throw new Error(
      "expected artifact digest must be 64 lowercase hex characters",
    );
  }
  if (!SHA256_RE.test(input.expectedPromotionReceiptDigest)) {
    throw new Error(
      "expected promotion receipt digest must be 64 lowercase hex characters",
    );
  }

  const artifact = verifyRuntimeArtifact(input.startPath);
  const packageRoot = realpathSync(artifact.packageRoot);
  const located = promotionReceiptPathForPackageRoot(packageRoot);
  const receiptBytes = readRegularFileBounded(
    located.receiptPath,
    PROMOTION_RECEIPT_MAX_BYTES,
  );
  const receiptDigest = promotionReceiptDigest(receiptBytes);
  if (receiptDigest !== input.expectedPromotionReceiptDigest) {
    throw new Error(
      "promotion receipt byte digest does not match expected digest",
    );
  }
  const receipt = parsePromotionReceipt(receiptBytes);

  if (
    artifact.digest !== input.expectedArtifactDigest ||
    receipt.artifactDigest !== input.expectedArtifactDigest ||
    receipt.artifactDigest !== artifact.digest
  ) {
    throw new Error("promotion receipt artifact digest mismatch");
  }
  if (
    receipt.version !== artifact.packageVersion ||
    receipt.sourceCommit !== artifact.sourceCommit
  ) {
    throw new Error("promotion receipt package manifest identity mismatch");
  }
  assertRealPath(receipt.installedPrefix, located.prefix, "installedPrefix");
  assertRealPath(receipt.packageRoot, packageRoot, "packageRoot");
  const installedCli = realpathSync(
    join(located.prefix, "bin", "echo-context"),
  );
  assertRealPath(receipt.cliPath, installedCli, "cliPath");
  if (
    input.cliPath !== undefined &&
    realpathSync(input.cliPath) !== receipt.cliPath
  ) {
    throw new Error("invoked CLI does not match the promotion receipt CLI");
  }
  const nodeExecutable = realpathSync(process.execPath);
  assertRealPath(receipt.nodeExecutable, nodeExecutable, "nodeExecutable");
  if (receipt.nodeVersion !== process.versions.node) {
    throw new Error(
      "running Node version does not match the promotion receipt",
    );
  }
  const artifactPath = realpathSync(receipt.artifact);
  assertRealPath(receipt.artifact, artifactPath, "artifact");
  const artifactFile = digestRegularFileBounded(
    artifactPath,
    PROMOTION_ARTIFACT_MAX_BYTES,
  );
  if (artifactFile.digest !== receipt.artifactSha256) {
    throw new Error("promotion receipt package tarball digest mismatch");
  }
  const installedTree = digestPromotionInstalledTree(located.prefix);
  if (
    installedTree.digest !== receipt.installedTreeDigest ||
    installedTree.entries !== receipt.installedTreeEntries ||
    installedTree.files !== receipt.installedTreeFiles ||
    installedTree.bytes !== receipt.installedTreeBytes
  ) {
    throw new Error("installed tree does not match the promotion receipt");
  }
  return {
    receipt,
    receiptPath: located.receiptPath,
    receiptDigest,
    installedTree,
  };
}
