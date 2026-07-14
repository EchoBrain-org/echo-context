import {
  closeSync,
  fchmodSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export type AtomicWriteErrorCode =
  | 'EACCES'
  | 'ENOSPC'
  | 'ENOTDIR'
  | 'ENOENT'
  | 'EISDIR'
  | 'EROFS'
  | 'EEXIST'
  | 'ELOOP'
  | 'UNKNOWN';

export class AtomicWriteError extends Error {
  constructor(
    public readonly code: AtomicWriteErrorCode,
    public readonly file: string,
    message: string,
  ) {
    super(message);
    this.name = 'AtomicWriteError';
  }
}

export interface AtomicWriteOpts {
  filePath: string;
  content: string | Buffer;
  secretSensitive?: boolean;
  followSymlink?: boolean;
}

let __testTempHook: ((tempPath: string) => void) | undefined;

/**
 * Test-only: register a hook called with each temp filename atomicWrite uses
 * (before the rename). Production code MUST NOT call this. Pass undefined to
 * clear. The hook is invoked synchronously before rename(); any throw escapes
 * to the caller. Used by the unique-temp pin test in AC9.
 */
export function __setAtomicWriteTestHook(
  hook: ((tempPath: string) => void) | undefined,
): void {
  __testTempHook = hook;
}

const SECRET_SENSITIVE_ALLOWLIST: readonly string[] = [
  resolve(homedir(), '.codex/config.toml'),
  resolve(homedir(), '.cursor/mcp.json'),
];

function isAllowlistedSecretPath(absPath: string): boolean {
  return SECRET_SENSITIVE_ALLOWLIST.includes(absPath);
}

function errnoCode(err: unknown): AtomicWriteErrorCode {
  if (err instanceof Error && 'code' in err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (
      code === 'EACCES' ||
      code === 'ENOSPC' ||
      code === 'ENOTDIR' ||
      code === 'ENOENT' ||
      code === 'EISDIR' ||
      code === 'EROFS' ||
      code === 'EEXIST' ||
      code === 'ELOOP'
    ) {
      return code;
    }
  }
  return 'UNKNOWN';
}

function bestEffortUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // best-effort
  }
}

export function atomicWrite(opts: AtomicWriteOpts): void {
  const absPath = resolve(opts.filePath);
  const followSymlink = opts.followSymlink === true;
  const secretSensitive = opts.secretSensitive === true;

  let existingMode: number | undefined;
  let writePath = absPath;
  let kind: 'missing' | 'regular' | 'symlink' = 'missing';

  try {
    const lst = lstatSync(absPath);
    if (lst.isSymbolicLink()) {
      kind = 'symlink';
    } else if (lst.isDirectory()) {
      throw new AtomicWriteError('EISDIR', absPath, `target is a directory: ${absPath}`);
    } else {
      kind = 'regular';
      existingMode = lst.mode & 0o777;
    }
  } catch (err) {
    if (err instanceof AtomicWriteError) throw err;
    const code = errnoCode(err);
    if (code === 'ENOENT') {
      kind = 'missing';
    } else {
      throw new AtomicWriteError(code, absPath, `lstat failed: ${(err as Error).message}`);
    }
  }

  if (kind === 'symlink') {
    if (!followSymlink) {
      throw new AtomicWriteError(
        'EEXIST',
        absPath,
        `refusing to write through symlink at ${absPath}`,
      );
    }
    try {
      writePath = realpathSync(absPath);
    } catch (err) {
      const code = errnoCode(err);
      throw new AtomicWriteError(
        code === 'UNKNOWN' ? 'ENOENT' : code,
        absPath,
        `realpath failed (broken or dangling symlink): ${(err as Error).message}`,
      );
    }
    try {
      const st = statSync(writePath);
      existingMode = st.mode & 0o777;
    } catch (err) {
      const code = errnoCode(err);
      if (code !== 'ENOENT') {
        throw new AtomicWriteError(
          code,
          writePath,
          `stat of resolved target failed: ${(err as Error).message}`,
        );
      }
      existingMode = undefined;
    }
  }

  let mode: number;
  let lockTo600 = false;
  if (existingMode !== undefined) {
    if (secretSensitive && (existingMode & 0o077) !== 0) {
      mode = 0o600;
      lockTo600 = true;
    } else {
      mode = existingMode;
    }
  } else if (secretSensitive || isAllowlistedSecretPath(writePath)) {
    mode = 0o600;
    lockTo600 = true;
  } else {
    mode = 0o666;
  }

  const tempPath = `${writePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;

  let fd: number | undefined;
  try {
    fd = openSync(tempPath, 'w', mode);
    const buffer =
      typeof opts.content === 'string' ? Buffer.from(opts.content, 'utf8') : opts.content;
    writeSync(fd, buffer, 0, buffer.length, 0);
    if (lockTo600) {
      fchmodSync(fd, 0o600);
    } else if (existingMode !== undefined) {
      // Re-apply existing mode in case the process umask stripped bits.
      fchmodSync(fd, existingMode);
    }
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best-effort
      }
      fd = undefined;
    }
    bestEffortUnlink(tempPath);
    if (err instanceof AtomicWriteError) throw err;
    const code = errnoCode(err);
    throw new AtomicWriteError(
      code,
      writePath,
      `failed to write temp file: ${(err as Error).message}`,
    );
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best-effort
      }
    }
  }

  if (__testTempHook !== undefined) {
    __testTempHook(tempPath);
  }

  try {
    renameSync(tempPath, writePath);
  } catch (err) {
    bestEffortUnlink(tempPath);
    const code = errnoCode(err);
    throw new AtomicWriteError(
      code,
      writePath,
      `rename to ${writePath} failed: ${(err as Error).message}`,
    );
  }
}
