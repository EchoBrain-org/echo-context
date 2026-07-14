import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from './atomic-write.js';

export interface RoleSyncOpts {
  sourceDir: string;
  targetDir: string;
  defaults: readonly string[];
}

export type RolePerFileAction = 'copied' | 'noop' | 'user-modified' | 'source-missing' | 'error';

export interface RolePerFileConflict {
  filePath: string;
  sourceBytes: Buffer | null;
  userBytes: Buffer | null;
  targetIsSymlink?: boolean;
}

export interface AdapterErrorShape {
  code: string;
  file: string;
  operation: 'read' | 'parse' | 'write' | 'rename' | 'stat' | 'link' | 'mkdir';
  message: string;
}

export type RolePerFileResult =
  | { role: string; action: 'copied' }
  | { role: string; action: 'noop' }
  | { role: string; action: 'user-modified'; conflict: RolePerFileConflict }
  | { role: string; action: 'source-missing' }
  | { role: string; action: 'error'; error: AdapterErrorShape };

export interface RoleSyncResult {
  results: RolePerFileResult[];
  rolesErrors: AdapterErrorShape[];
}

function errnoCode(err: unknown): string {
  if (err instanceof Error && 'code' in err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (typeof code === 'string') return code;
  }
  return 'UNKNOWN';
}

export function syncDefaultRoles(opts: RoleSyncOpts): RoleSyncResult {
  const { sourceDir, targetDir, defaults } = opts;
  const results: RolePerFileResult[] = [];
  const rolesErrors: AdapterErrorShape[] = [];

  try {
    mkdirSync(targetDir, { recursive: true });
  } catch (err) {
    const e: AdapterErrorShape = {
      code: errnoCode(err),
      file: targetDir,
      operation: 'mkdir',
      message: `mkdir ${targetDir} failed: ${(err as Error).message}`,
    };
    // All roles fail with this error.
    for (const role of defaults) {
      results.push({ role, action: 'error', error: e });
    }
    rolesErrors.push(e);
    return { results, rolesErrors };
  }

  for (const role of defaults) {
    const srcPath = join(sourceDir, role);
    const tgtPath = join(targetDir, role);

    let sourceBytes: Buffer;
    try {
      sourceBytes = readFileSync(srcPath);
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') {
        results.push({ role, action: 'source-missing' });
        continue;
      }
      const e: AdapterErrorShape = {
        code: errnoCode(err),
        file: srcPath,
        operation: 'read',
        message: `read source role ${role} failed: ${(err as Error).message}`,
      };
      results.push({ role, action: 'error', error: e });
      rolesErrors.push(e);
      continue;
    }

    let targetExists = false;
    let targetIsSymlink = false;
    if (existsSync(tgtPath)) {
      try {
        const lst = lstatSync(tgtPath);
        if (lst.isSymbolicLink()) {
          targetIsSymlink = true;
        }
        targetExists = true;
      } catch (err) {
        const e: AdapterErrorShape = {
          code: errnoCode(err),
          file: tgtPath,
          operation: 'stat',
          message: `lstat target ${role} failed: ${(err as Error).message}`,
        };
        results.push({ role, action: 'error', error: e });
        rolesErrors.push(e);
        continue;
      }
    }

    if (targetExists) {
      if (targetIsSymlink) {
        results.push({
          role,
          action: 'user-modified',
          conflict: { filePath: tgtPath, sourceBytes: null, userBytes: null, targetIsSymlink: true },
        });
        continue;
      }
      let userBytes: Buffer;
      try {
        userBytes = readFileSync(tgtPath);
      } catch (err) {
        const e: AdapterErrorShape = {
          code: errnoCode(err),
          file: tgtPath,
          operation: 'read',
          message: `read target role ${role} failed: ${(err as Error).message}`,
        };
        results.push({ role, action: 'error', error: e });
        rolesErrors.push(e);
        continue;
      }
      if (userBytes.equals(sourceBytes)) {
        results.push({ role, action: 'noop' });
      } else {
        results.push({
          role,
          action: 'user-modified',
          conflict: { filePath: tgtPath, sourceBytes, userBytes },
        });
      }
      continue;
    }

    try {
      atomicWrite({ filePath: tgtPath, content: sourceBytes });
      results.push({ role, action: 'copied' });
    } catch (err) {
      const e: AdapterErrorShape = {
        code: errnoCode(err),
        file: tgtPath,
        operation: 'write',
        message: `write role ${role} failed: ${(err as Error).message}`,
      };
      results.push({ role, action: 'error', error: e });
      rolesErrors.push(e);
    }
  }

  return { results, rolesErrors };
}
