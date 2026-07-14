// cursor-config.ts — JSON mutator for ~/.cursor/mcp.json.
//
// We parse with JSON.parse, mutate the target subtree, write back with
// JSON.stringify(obj, null, 2). Tradeoff: whitespace exotica (tabs, trailing
// commas) is not preserved because no widely-used JSON-with-comments parser
// is in the project's dependency surface. Cursor's writer uses 2-space JSON
// by convention, so this is acceptable for V1.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWrite } from './atomic-write.js';

export interface CursorConfigOpts {
  filePath: string;
  serverConfig: { url: string; headers?: Record<string, string>; [k: string]: unknown };
  previousServerConfig?: Record<string, unknown>;
  force?: boolean;
}

export type CursorAction = 'add' | 'update' | 'noop' | 'conflict';

export interface CursorConfigConflict {
  kind: 'config';
  filePath: string;
  currentValue?: unknown;
  expectedValue?: unknown;
  proposedValue?: unknown;
  unifiedDiff?: string;
}

export class CursorJsonParseError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly firstLine: string,
  ) {
    super(`JSON parse failed: ${firstLine}`);
    this.name = 'CursorJsonParseError';
  }
}

export type CursorConfigResult =
  | { action: 'add' }
  | { action: 'update' }
  | { action: 'noop' }
  | { action: 'conflict'; conflict: CursorConfigConflict };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

function simpleUnifiedDiff(a: unknown, b: unknown): string {
  const aStr = JSON.stringify(a, null, 2);
  const bStr = JSON.stringify(b, null, 2);
  const aLines = aStr.split('\n');
  const bLines = bStr.split('\n');
  const lines: string[] = ['--- current', '+++ proposed'];
  const aSet = new Set(aLines);
  const bSet = new Set(bLines);
  for (const line of aLines) if (!bSet.has(line)) lines.push(`- ${line}`);
  for (const line of bLines) if (!aSet.has(line)) lines.push(`+ ${line}`);
  return lines.join('\n');
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function previousKeysUnchanged(
  current: Record<string, unknown>,
  previous: Record<string, unknown>,
): boolean {
  for (const [key, value] of Object.entries(previous)) {
    if (!hasOwn(current, key) || !deepEqual(current[key], value)) return false;
  }
  return true;
}

function mergeWithUserOwnedKeys(
  current: Record<string, unknown>,
  previous: Record<string, unknown> | undefined,
  desired: Record<string, unknown>,
): Record<string, unknown> {
  const preserved: Record<string, unknown> = {};
  const previousKeys = previous ?? {};
  for (const [key, value] of Object.entries(current)) {
    if (!hasOwn(previousKeys, key)) preserved[key] = value;
  }
  return { ...preserved, ...desired };
}

function ensureParentDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

export function syncCursorMcpEntry(opts: CursorConfigOpts): CursorConfigResult {
  const { filePath, serverConfig, previousServerConfig, force = false } = opts;

  if (!existsSync(filePath)) {
    ensureParentDir(filePath);
    const doc = { mcpServers: { echo: serverConfig } };
    atomicWrite({
      filePath,
      content: `${JSON.stringify(doc, null, 2)}\n`,
      secretSensitive: true,
      followSymlink: true,
    });
    return { action: 'add' };
  }

  const raw = readFileSync(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const firstLine = (err as Error).message.split('\n')[0];
    throw new CursorJsonParseError(filePath, firstLine);
  }

  if (!isPlainObject(parsed)) {
    throw new CursorJsonParseError(filePath, 'root must be an object');
  }
  const root = parsed;
  if (root['mcpServers'] !== undefined && !isPlainObject(root['mcpServers'])) {
    throw new CursorJsonParseError(filePath, 'mcpServers must be an object');
  }
  const mcpServers = (root['mcpServers'] as Record<string, unknown>) ?? {};
  const currentEcho = mcpServers['echo'];

  if (currentEcho === undefined) {
    const newDoc: Record<string, unknown> = { ...root };
    newDoc['mcpServers'] = { ...mcpServers, echo: serverConfig };
    atomicWrite({
      filePath,
      content: `${JSON.stringify(newDoc, null, 2)}\n`,
      secretSensitive: true,
      followSymlink: true,
    });
    return { action: 'add' };
  }

  if (deepEqual(currentEcho, serverConfig)) {
    return { action: 'noop' };
  }

  if (!isPlainObject(currentEcho)) {
    if (force) {
      const newDoc: Record<string, unknown> = { ...root };
      newDoc['mcpServers'] = { ...mcpServers, echo: serverConfig };
      atomicWrite({
        filePath,
        content: `${JSON.stringify(newDoc, null, 2)}\n`,
        secretSensitive: true,
        followSymlink: true,
      });
      return { action: 'update' };
    }
    return {
      action: 'conflict',
      conflict: {
        kind: 'config',
        filePath,
        currentValue: currentEcho,
        expectedValue: previousServerConfig,
        proposedValue: serverConfig,
        unifiedDiff: simpleUnifiedDiff(currentEcho, serverConfig),
      },
    };
  }

  const proposedEcho = mergeWithUserOwnedKeys(currentEcho, previousServerConfig, serverConfig);
  if (deepEqual(currentEcho, proposedEcho)) {
    return { action: 'noop' };
  }

  if (
    previousServerConfig !== undefined &&
    previousKeysUnchanged(currentEcho, previousServerConfig)
  ) {
    const newDoc: Record<string, unknown> = { ...root };
    newDoc['mcpServers'] = { ...mcpServers, echo: proposedEcho };
    atomicWrite({
      filePath,
      content: `${JSON.stringify(newDoc, null, 2)}\n`,
      secretSensitive: true,
      followSymlink: true,
    });
    return { action: 'update' };
  }

  if (force) {
    const newDoc: Record<string, unknown> = { ...root };
    newDoc['mcpServers'] = { ...mcpServers, echo: serverConfig };
    atomicWrite({
      filePath,
      content: `${JSON.stringify(newDoc, null, 2)}\n`,
      secretSensitive: true,
      followSymlink: true,
    });
    return { action: 'update' };
  }

  return {
    action: 'conflict',
    conflict: {
      kind: 'config',
      filePath,
      currentValue: currentEcho,
      expectedValue: previousServerConfig,
      proposedValue: proposedEcho,
      unifiedDiff: simpleUnifiedDiff(currentEcho, proposedEcho),
    },
  };
}
