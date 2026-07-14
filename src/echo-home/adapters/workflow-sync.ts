import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from './atomic-write.js';
import type { AdapterErrorShape } from './role-sync.js';

export interface WorkflowSyncOpts {
  sourceDir: string;
  targetDir: string;
  defaults: readonly string[];
}

export type WorkflowPerFileAction =
  | 'copied'
  | 'noop'
  | 'user-modified'
  | 'source-missing'
  | 'error';

export interface WorkflowPerFileConflict {
  filePath: string;
  sourceBytes: Buffer | null;
  userBytes: Buffer | null;
  targetIsSymlink?: boolean;
}

export type WorkflowPerFileResult =
  | { workflow: string; action: 'copied' }
  | { workflow: string; action: 'noop' }
  | { workflow: string; action: 'user-modified'; conflict: WorkflowPerFileConflict }
  | { workflow: string; action: 'source-missing' }
  | { workflow: string; action: 'error'; error: AdapterErrorShape };

export interface WorkflowSyncResult {
  results: WorkflowPerFileResult[];
  workflowsErrors: AdapterErrorShape[];
}

function errnoCode(err: unknown): string {
  if (err instanceof Error && 'code' in err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (typeof code === 'string') return code;
  }
  return 'UNKNOWN';
}

export function syncDefaultWorkflows(opts: WorkflowSyncOpts): WorkflowSyncResult {
  const { sourceDir, targetDir, defaults } = opts;
  const results: WorkflowPerFileResult[] = [];
  const workflowsErrors: AdapterErrorShape[] = [];

  try {
    mkdirSync(targetDir, { recursive: true });
  } catch (err) {
    const e: AdapterErrorShape = {
      code: errnoCode(err),
      file: targetDir,
      operation: 'mkdir',
      message: `mkdir ${targetDir} failed: ${(err as Error).message}`,
    };
    for (const workflow of defaults) {
      results.push({ workflow, action: 'error', error: e });
    }
    workflowsErrors.push(e);
    return { results, workflowsErrors };
  }

  for (const workflow of defaults) {
    const srcPath = join(sourceDir, workflow);
    const tgtPath = join(targetDir, workflow);

    let sourceBytes: Buffer;
    try {
      sourceBytes = readFileSync(srcPath);
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') {
        results.push({ workflow, action: 'source-missing' });
        continue;
      }
      const e: AdapterErrorShape = {
        code: errnoCode(err),
        file: srcPath,
        operation: 'read',
        message: `read source workflow ${workflow} failed: ${(err as Error).message}`,
      };
      results.push({ workflow, action: 'error', error: e });
      workflowsErrors.push(e);
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
          message: `lstat target workflow ${workflow} failed: ${(err as Error).message}`,
        };
        results.push({ workflow, action: 'error', error: e });
        workflowsErrors.push(e);
        continue;
      }
    }

    if (targetExists) {
      if (targetIsSymlink) {
        results.push({
          workflow,
          action: 'user-modified',
          conflict: {
            filePath: tgtPath,
            sourceBytes: null,
            userBytes: null,
            targetIsSymlink: true,
          },
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
          message: `read target workflow ${workflow} failed: ${(err as Error).message}`,
        };
        results.push({ workflow, action: 'error', error: e });
        workflowsErrors.push(e);
        continue;
      }
      if (userBytes.equals(sourceBytes)) {
        results.push({ workflow, action: 'noop' });
      } else {
        results.push({
          workflow,
          action: 'user-modified',
          conflict: { filePath: tgtPath, sourceBytes, userBytes },
        });
      }
      continue;
    }

    try {
      atomicWrite({ filePath: tgtPath, content: sourceBytes });
      results.push({ workflow, action: 'copied' });
    } catch (err) {
      const e: AdapterErrorShape = {
        code: errnoCode(err),
        file: tgtPath,
        operation: 'write',
        message: `write workflow ${workflow} failed: ${(err as Error).message}`,
      };
      results.push({ workflow, action: 'error', error: e });
      workflowsErrors.push(e);
    }
  }

  return { results, workflowsErrors };
}
