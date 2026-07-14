// codex-config.ts — TOML mutator for ~/.codex/config.toml.
//
// TOML strategy: key-targeted byte-range editor (primary path). Per codex r1
// review (2026-05-25), smol-toml@1.6.1 does not preserve comments through
// parse + stringify. Therefore comment-preserving parse-and-restringify is
// infeasible with the libraries on this project's dependency surface.
//
// We use string-range surgery for the target slice. smol-toml is only invoked
// as a value-comparator on the parsed slice ({ mcp_servers: { echo: {...} } }).
// JSON-with-comments handling for cursor-config.ts has the same shape; see
// cursor-config.ts header for that tradeoff note.

import { existsSync, readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { atomicWrite } from './atomic-write.js';

export interface CodexConfigOpts {
  filePath: string;
  serverConfig: { url: string; enabled?: boolean; [k: string]: unknown };
  previousServerConfig?: Record<string, unknown>;
  force?: boolean;
}

export type CodexAction = 'add' | 'update' | 'noop' | 'conflict';

export interface CodexConfigConflict {
  kind: 'config';
  filePath: string;
  currentValue?: unknown;
  expectedValue?: unknown;
  proposedValue?: unknown;
  unifiedDiff?: string;
}

export class RenderError extends Error {
  constructor(
    public readonly code: 'UNSUPPORTED_VALUE',
    public readonly field: string,
    public readonly typeName: string,
  ) {
    super(`unsupported value type for field ${field}: ${typeName}`);
    this.name = 'RenderError';
  }
}

export class TomlParseError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly firstLine: string,
  ) {
    super(`TOML parse failed: ${firstLine}`);
    this.name = 'TomlParseError';
  }
}

export type CodexConfigResult =
  | { action: 'add' }
  | { action: 'update' }
  | { action: 'noop' }
  | { action: 'conflict'; conflict: CodexConfigConflict };

const TARGET_HEADER = '[mcp_servers.echo]';
const TARGET_TABLE_NAME = 'mcp_servers.echo';

function escapeBasicString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function renderValue(value: unknown, field: string): string {
  if (typeof value === 'string') {
    return `"${escapeBasicString(value)}"`;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new RenderError('UNSUPPORTED_VALUE', field, 'non-finite-number');
    }
    return String(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (typeof value[i] !== 'string') {
        throw new RenderError('UNSUPPORTED_VALUE', `${field}[${i}]`, typeof value[i]);
      }
    }
    const parts = value.map((s) => `"${escapeBasicString(s as string)}"`);
    return `[${parts.join(', ')}]`;
  }
  throw new RenderError('UNSUPPORTED_VALUE', field, value === null ? 'null' : typeof value);
}

/**
 * Render the inner keys of an mcp_servers.echo block as dotted-key TOML lines.
 *
 * Supported value vocabulary (V1):
 *   string, number (finite), boolean, string[], Record<string, string>
 *
 * Anything else throws RenderError, which the adapter surfaces as
 * AdapterError code 'UNSUPPORTED_VALUE'.
 */
export function renderInlineKeys(config: Record<string, unknown>): string {
  const lines: string[] = [];
  const keys = Object.keys(config).sort();
  for (const key of keys) {
    const value = config[key];
    if (isPlainObject(value)) {
      const subKeys = Object.keys(value).sort();
      for (const subKey of subKeys) {
        const subValue = value[subKey];
        if (typeof subValue !== 'string') {
          throw new RenderError(
            'UNSUPPORTED_VALUE',
            `${key}.${subKey}`,
            subValue === null ? 'null' : typeof subValue,
          );
        }
        lines.push(`${key}.${subKey} = "${escapeBasicString(subValue)}"`);
      }
    } else {
      lines.push(`${key} = ${renderValue(value, key)}`);
    }
  }
  return lines.join('\n');
}

/**
 * Find the byte range [start, end) of the target slice in the file's raw text.
 *
 * The slice starts at the [mcp_servers.echo] header line and extends until the
 * next non-descendant table header line (or EOF). A descendant is any header
 * whose dotted name begins with `mcp_servers.echo.` — those subtables stay
 * inside the slice.
 *
 * Returns null if the header is not present.
 */
function findTargetSlice(text: string): { start: number; end: number } | null {
  const lines: { content: string; start: number; end: number }[] = [];
  let pos = 0;
  while (pos < text.length) {
    let nl = text.indexOf('\n', pos);
    if (nl === -1) nl = text.length;
    lines.push({ content: text.slice(pos, nl), start: pos, end: nl + 1 });
    pos = nl + 1;
  }

  // Extract table header name from a line if it is a header. Returns null for
  // non-headers (assignments, comments, blanks). Recognizes `[name]` followed
  // optionally by whitespace + `# comment`. Excludes array-of-tables `[[name]]`.
  function tableHeaderName(line: string): string | null {
    const t = line.trim();
    if (t.length === 0 || t.startsWith('#')) return null;
    if (!t.startsWith('[') || t.startsWith('[[')) return null;
    const close = t.indexOf(']');
    if (close === -1) return null;
    // After the closing bracket, allow only whitespace + optional `# ...`.
    const rest = t.slice(close + 1);
    const restTrim = rest.trimStart();
    if (restTrim.length > 0 && !restTrim.startsWith('#')) return null;
    return t.slice(1, close).trim();
  }

  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const name = tableHeaderName(lines[i].content);
    if (name === TARGET_TABLE_NAME) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return null;

  const start = lines[headerIdx].start;
  let end = text.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const name = tableHeaderName(lines[i].content);
    if (name === null) continue;
    if (name === TARGET_TABLE_NAME || name.startsWith(`${TARGET_TABLE_NAME}.`)) {
      continue; // descendant — stays inside slice
    }
    end = lines[i].start;
    break;
  }
  return { start, end };
}

function parseSliceUnwrap(slice: string, filePath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseToml(slice);
  } catch (err) {
    const firstLine = (err as Error).message.split('\n')[0];
    throw new TomlParseError(filePath, firstLine);
  }
  if (!isPlainObject(parsed)) {
    throw new TomlParseError(filePath, 'parsed slice was not a table');
  }
  const mcpServers = parsed['mcp_servers'];
  if (!isPlainObject(mcpServers)) {
    throw new TomlParseError(filePath, 'missing mcp_servers section in parsed slice');
  }
  const echo = mcpServers['echo'];
  if (!isPlainObject(echo)) {
    throw new TomlParseError(filePath, 'missing mcp_servers.echo section in parsed slice');
  }
  return echo;
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

function renderTargetBlock(config: Record<string, unknown>): string {
  const inner = renderInlineKeys(config);
  return `${TARGET_HEADER}\n${inner}\n`;
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

export function syncCodexMcpBlock(opts: CodexConfigOpts): CodexConfigResult {
  const { filePath, serverConfig, previousServerConfig, force = false } = opts;

  if (!existsSync(filePath)) {
    ensureParentDir(filePath);
    const content = renderTargetBlock(serverConfig);
    atomicWrite({ filePath, content, secretSensitive: true, followSymlink: true });
    return { action: 'add' };
  }

  const original = readFileSync(filePath, 'utf8');
  const slice = findTargetSlice(original);

  if (slice === null) {
    // Add branch: append the target table.
    const prefix = original.endsWith('\n\n')
      ? original
      : original.endsWith('\n')
        ? `${original}\n`
        : `${original}\n\n`;
    const content = `${prefix}${renderTargetBlock(serverConfig)}`;
    atomicWrite({ filePath, content, secretSensitive: true, followSymlink: true });
    return { action: 'add' };
  }

  const sliceText = original.slice(slice.start, slice.end);
  const currentEcho = parseSliceUnwrap(sliceText, filePath);

  if (deepEqual(currentEcho, serverConfig)) {
    return { action: 'noop' };
  }

  const proposedEcho = mergeWithUserOwnedKeys(currentEcho, previousServerConfig, serverConfig);
  if (deepEqual(currentEcho, proposedEcho)) {
    return { action: 'noop' };
  }

  if (
    previousServerConfig !== undefined &&
    previousKeysUnchanged(currentEcho, previousServerConfig)
  ) {
    const rendered = renderTargetBlock(proposedEcho);
    // Preserve trailing newline structure: if original slice ended with \n\n,
    // keep one of those; rendered already ends with \n.
    const newContent = `${original.slice(0, slice.start)}${rendered}${original.slice(slice.end)}`;
    atomicWrite({ filePath, content: newContent, secretSensitive: true, followSymlink: true });
    return { action: 'update' };
  }

  if (force) {
    const rendered = renderTargetBlock(serverConfig);
    const newContent = `${original.slice(0, slice.start)}${rendered}${original.slice(slice.end)}`;
    atomicWrite({ filePath, content: newContent, secretSensitive: true, followSymlink: true });
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
