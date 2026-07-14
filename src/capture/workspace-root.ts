import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, parse, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export const GIT_PROBE_TIMEOUT_MS = 1_500;

const PROJECT_ANCHORS = [
  '.git',
  'package.json',
  'go.mod',
  'Cargo.toml',
  'pyproject.toml',
  'pnpm-workspace.yaml',
] as const;

interface CanonicalizeOptions {
  caseInsensitiveFilesystem?: boolean;
}

export async function gitToplevel(path: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', ['-C', path, 'rev-parse', '--show-toplevel'], {
      timeout: GIT_PROBE_TIMEOUT_MS,
      maxBuffer: 1_024 * 1_024,
    });
    const out = stdout.trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export async function resolveCanonicalRoot(path: string): Promise<string> {
  try {
    const toplevel = await gitToplevel(path);
    if (toplevel !== null) return canonicalizePath(toplevel);

    const anchorRoot = await findAnchorRoot(path);
    if (anchorRoot !== null) return canonicalizePath(anchorRoot);

    return canonicalizePath(path);
  } catch {
    return canonicalizePath(path);
  }
}

export async function canonicalizePath(path: string): Promise<string> {
  return canonicalizePathInternal(path, {});
}

export async function _canonicalizePathForTest(
  path: string,
  options: CanonicalizeOptions,
): Promise<string> {
  return canonicalizePathInternal(path, options);
}

async function canonicalizePathInternal(
  path: string,
  options: CanonicalizeOptions,
): Promise<string> {
  const absolute = normalize(isAbsolute(path) ? path : resolve(path));
  const { existing, missing } = await longestExistingPrefix(absolute);
  let canonical = existing;
  if (missing.length > 0) canonical = normalize(join(existing, ...missing));

  const caseInsensitive =
    options.caseInsensitiveFilesystem ?? (await isCaseInsensitiveFilesystem(existing));
  return caseInsensitive ? canonical.toLowerCase() : canonical;
}

async function longestExistingPrefix(
  absolutePath: string,
): Promise<{ existing: string; missing: string[] }> {
  let cur = absolutePath;
  const missing: string[] = [];
  for (;;) {
    try {
      return { existing: await realpath(cur), missing };
    } catch {
      const parent = dirname(cur);
      if (parent === cur) {
        return { existing: cur, missing };
      }
      missing.unshift(basename(cur));
      cur = parent;
    }
  }
}

async function isCaseInsensitiveFilesystem(existingPath: string): Promise<boolean> {
  const alternate = firstCaseVariant(existingPath);
  if (alternate === null || alternate === existingPath) return false;
  try {
    const [a, b] = await Promise.all([realpath(existingPath), realpath(alternate)]);
    return a === b;
  } catch {
    return false;
  }
}

function firstCaseVariant(path: string): string | null {
  for (let i = 0; i < path.length; i++) {
    const ch = path[i] as string;
    const lower = ch.toLowerCase();
    const upper = ch.toUpperCase();
    if (lower !== upper) {
      return `${path.slice(0, i)}${ch === lower ? upper : lower}${path.slice(i + 1)}`;
    }
  }
  return null;
}

async function findAnchorRoot(startPath: string): Promise<string | null> {
  const start = normalize(isAbsolute(startPath) ? startPath : resolve(startPath));
  const home = await resolvedHome();
  const homeCeilingApplies = home !== null && pathContainsOrEquals(start, home);
  let cur = start;

  for (;;) {
    const currentIsHomeCeiling = homeCeilingApplies && home !== null && samePath(cur, home);
    const currentIsAmbient = isAmbientRoot(cur, home);
    if (!currentIsAmbient && (await hasProjectAnchor(cur))) return cur;
    if (currentIsHomeCeiling) return null;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

async function hasProjectAnchor(dir: string): Promise<boolean> {
  for (const anchor of PROJECT_ANCHORS) {
    try {
      await stat(join(dir, anchor));
      return true;
    } catch {
      // Missing or unreadable anchors are ordinary in daemon capture paths.
    }
  }
  return false;
}

async function resolvedHome(): Promise<string | null> {
  const home = process.env['HOME'];
  if (home === undefined || home.length === 0) return null;
  try {
    return normalize(await realpath(home));
  } catch {
    return null;
  }
}

function isAmbientRoot(path: string, home: string | null): boolean {
  const normalized = normalize(path);
  const root = parse(normalized).root;
  return (
    normalized === root ||
    normalized === '/tmp' ||
    normalized === '/private/tmp' ||
    (home !== null && samePath(normalized, home))
  );
}

function samePath(a: string, b: string): boolean {
  return normalize(a) === normalize(b);
}

function pathContainsOrEquals(path: string, root: string): boolean {
  const normalizedPath = normalize(path);
  const normalizedRoot = normalize(root);
  if (normalizedPath === normalizedRoot) return true;
  return normalizedPath.startsWith(
    normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`,
  );
}
