import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Write `lines` as a JSONL file at `path`, replacing any existing content. */
export function writeJsonl<T>(path: string, lines: T[]): void {
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : ''));
}

/** Append `lines` to an existing JSONL file. */
export function appendJsonl<T>(path: string, lines: T[]): void {
  appendFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : ''));
}

/** Make a fresh temp directory under the OS tmpdir. */
export function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Poll `predicate` every 25ms until it returns truthy or `timeoutMs` elapses. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('waitFor: timeout');
}
