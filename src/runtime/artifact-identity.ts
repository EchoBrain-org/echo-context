import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const MAX_MANIFEST_FILES = 4096;
const MAX_MANIFEST_FILE_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_TOTAL_BYTES = 256 * 1024 * 1024;
export const ARTIFACT_MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/;

interface ArtifactManifestEntry {
  path: string;
  bytes: number;
  sha256: string;
}

interface ArtifactManifest {
  schemaVersion: 1;
  packageVersion: string;
  sourceCommit: string;
  files: ArtifactManifestEntry[];
  digest: string;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function packageRootFrom(startPath: string): string {
  let current = statSync(startPath).isDirectory()
    ? resolve(startPath)
    : dirname(resolve(startPath));
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(current, "dist", "artifact-manifest.json")))
      return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`runtime artifact manifest not found from ${startPath}`);
}

function canonicalManifestBody(manifest: ArtifactManifest): string {
  return JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    packageVersion: manifest.packageVersion,
    sourceCommit: manifest.sourceCommit,
    files: manifest.files,
  });
}

/** Verify every package-owned file recorded by the build manifest. */
export function verifyRuntimeArtifact(startPath: string): {
  packageRoot: string;
  digest: string;
  packageVersion: string;
  sourceCommit: string;
} {
  const packageRoot = packageRootFrom(startPath);
  const manifestPath = join(packageRoot, "dist", "artifact-manifest.json");
  const manifestStat = lstatSync(manifestPath);
  if (!manifestStat.isFile()) {
    throw new Error(
      `runtime artifact manifest is not a regular file: ${manifestPath}`,
    );
  }
  if (manifestStat.size > ARTIFACT_MANIFEST_MAX_BYTES) {
    throw new Error(
      `runtime artifact manifest exceeds byte budget: ${manifestStat.size} > ${ARTIFACT_MANIFEST_MAX_BYTES}`,
    );
  }
  const manifest = JSON.parse(
    readFileSync(manifestPath, "utf8"),
  ) as ArtifactManifest;
  if (
    manifest.schemaVersion !== 1 ||
    typeof manifest.packageVersion !== "string" ||
    !/^[a-f0-9]{40}$/.test(manifest.sourceCommit) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0 ||
    manifest.files.length > MAX_MANIFEST_FILES ||
    !SHA256_RE.test(manifest.digest)
  ) {
    throw new Error(`invalid runtime artifact manifest: ${manifestPath}`);
  }
  const expectedDigest = sha256(canonicalManifestBody(manifest));
  if (expectedDigest !== manifest.digest) {
    throw new Error("runtime artifact manifest digest mismatch");
  }

  let totalBytes = 0;
  let previousPath = "";
  for (const entry of manifest.files) {
    if (
      typeof entry.path !== "string" ||
      entry.path.length === 0 ||
      isAbsolute(entry.path) ||
      entry.path <= previousPath ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      entry.bytes > MAX_MANIFEST_FILE_BYTES ||
      !SHA256_RE.test(entry.sha256)
    ) {
      throw new Error(`invalid runtime artifact entry: ${String(entry.path)}`);
    }
    previousPath = entry.path;
    const filePath = resolve(packageRoot, entry.path);
    if (relative(packageRoot, filePath).startsWith("..")) {
      throw new Error(
        `runtime artifact entry escapes package root: ${entry.path}`,
      );
    }
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size !== entry.bytes) {
      throw new Error(`runtime artifact size mismatch: ${entry.path}`);
    }
    totalBytes += stat.size;
    if (totalBytes > MAX_MANIFEST_TOTAL_BYTES) {
      throw new Error(
        "runtime artifact exceeds total verification byte budget",
      );
    }
    if (sha256(readFileSync(filePath)) !== entry.sha256) {
      throw new Error(`runtime artifact content mismatch: ${entry.path}`);
    }
  }
  return {
    packageRoot,
    digest: manifest.digest,
    packageVersion: manifest.packageVersion,
    sourceCommit: manifest.sourceCommit,
  };
}

export function databaseIdentityDigest(dbPath: string): string {
  const stat = statSync(dbPath);
  return sha256(`${realpathSync(dbPath)}\0${stat.dev}\0${stat.ino}`);
}
