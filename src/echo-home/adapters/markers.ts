import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWrite } from './atomic-write.js';

export const BEGIN_MARKER = '<!-- BEGIN ECHO -->';
export const END_MARKER = '<!-- END ECHO -->';

export interface MarkerOpts {
  filePath: string;
  echoSection: string;
  previousEchoSection?: string;
  force?: boolean;
}

export type MarkerAction = 'append' | 'replace' | 'noop' | 'conflict';

export interface MarkerConflictMarker {
  kind: 'marker';
  filePath: string;
  currentInside: string;
  expectedInside?: string;
  proposedInside: string;
  unifiedDiff: string;
}

export interface MarkerConflictTargetSymlink {
  kind: 'target-symlink';
  filePath: string;
  targetIsSymlink: true;
}

export interface MarkerConflictMalformed {
  kind: 'malformed-marker';
  filePath: string;
}

export type MarkerConflict =
  | MarkerConflictMarker
  | MarkerConflictTargetSymlink
  | MarkerConflictMalformed;

export type MarkerResult =
  | { action: 'append'; filePath: string }
  | { action: 'replace'; filePath: string }
  | { action: 'noop'; filePath: string }
  | { action: 'conflict'; filePath: string; conflict: MarkerConflict };

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

function simpleUnifiedDiff(label: string, a: string, b: string): string {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const aSet = new Set(aLines);
  const bSet = new Set(bLines);
  const lines: string[] = [`--- ${label}: current`, `+++ ${label}: proposed`];
  for (const line of aLines) if (!bSet.has(line)) lines.push(`- ${line}`);
  for (const line of bLines) if (!aSet.has(line)) lines.push(`+ ${line}`);
  return lines.join('\n');
}

function ensureParentDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

export function mergeWithMarkers(opts: MarkerOpts): MarkerResult {
  const { filePath, echoSection, previousEchoSection, force = false } = opts;

  // Pre-read symlink guard.
  if (existsSync(filePath)) {
    const lst = lstatSync(filePath);
    if (lst.isSymbolicLink()) {
      return {
        action: 'conflict',
        filePath,
        conflict: { kind: 'target-symlink', filePath, targetIsSymlink: true },
      };
    }
  }

  let original: string;
  let fileExists: boolean;
  try {
    original = readFileSync(filePath, 'utf8');
    fileExists = true;
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      original = '';
      fileExists = false;
    } else {
      throw err;
    }
  }

  const beginCount = countOccurrences(original, BEGIN_MARKER);
  const endCount = countOccurrences(original, END_MARKER);

  const noMarkers = beginCount === 0 && endCount === 0;
  const wellFormed =
    beginCount === 1 &&
    endCount === 1 &&
    original.indexOf(BEGIN_MARKER) < original.indexOf(END_MARKER);

  if (!noMarkers && !wellFormed) {
    return {
      action: 'conflict',
      filePath,
      conflict: { kind: 'malformed-marker', filePath },
    };
  }

  if (noMarkers) {
    ensureParentDir(filePath);
    if (!fileExists || original.length === 0) {
      const content = `${BEGIN_MARKER}\n${echoSection}\n${END_MARKER}\n`;
      atomicWrite({ filePath, content });
    } else {
      const content = `${original}\n${BEGIN_MARKER}\n${echoSection}\n${END_MARKER}\n`;
      atomicWrite({ filePath, content });
    }
    return { action: 'append', filePath };
  }

  // Well-formed pair. Extract inside content (between markers, trimming the
  // single newline directly following BEGIN and the single newline directly
  // preceding END if present — the writer always wraps with \n on both sides).
  const beginIdx = original.indexOf(BEGIN_MARKER);
  const endIdx = original.indexOf(END_MARKER);
  const afterBegin = beginIdx + BEGIN_MARKER.length;
  const innerWithSurroundingNewlines = original.slice(afterBegin, endIdx);
  // Strip exactly one leading \n and one trailing \n if present.
  let currentInside = innerWithSurroundingNewlines;
  if (currentInside.startsWith('\n')) currentInside = currentInside.slice(1);
  if (currentInside.endsWith('\n')) currentInside = currentInside.slice(0, -1);

  if (currentInside === echoSection) {
    return { action: 'noop', filePath };
  }

  if (previousEchoSection !== undefined && currentInside === previousEchoSection) {
    const before = original.slice(0, beginIdx + BEGIN_MARKER.length);
    const after = original.slice(endIdx);
    const newContent = `${before}\n${echoSection}\n${after}`;
    ensureParentDir(filePath);
    atomicWrite({ filePath, content: newContent });
    return { action: 'replace', filePath };
  }

  if (force) {
    const before = original.slice(0, beginIdx + BEGIN_MARKER.length);
    const after = original.slice(endIdx);
    const newContent = `${before}\n${echoSection}\n${after}`;
    ensureParentDir(filePath);
    atomicWrite({ filePath, content: newContent });
    return { action: 'replace', filePath };
  }

  return {
    action: 'conflict',
    filePath,
    conflict: {
      kind: 'marker',
      filePath,
      currentInside,
      expectedInside: previousEchoSection,
      proposedInside: echoSection,
      unifiedDiff: simpleUnifiedDiff('ECHO section', currentInside, echoSection),
    },
  };
}
