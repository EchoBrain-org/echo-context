import { createHash } from 'node:crypto';
import type { EventId } from './interface.js';

export const STORAGE_MAX_DEDUPE_KEY_BYTES = 1_024;

export function eventIdForDedupeKey(dedupeKey: string): EventId {
  if (dedupeKey.length === 0) throw new RangeError('append dedupeKey must not be empty');
  const keyBytes = Buffer.byteLength(dedupeKey);
  if (keyBytes > STORAGE_MAX_DEDUPE_KEY_BYTES) {
    throw new RangeError(`append dedupeKey exceeds ${STORAGE_MAX_DEDUPE_KEY_BYTES} UTF-8 bytes`);
  }
  const digest = createHash('sha256')
    .update('echo-context:event-dedupe:v1\0', 'utf8')
    .update(dedupeKey, 'utf8')
    .digest('hex');
  return `dedupe:v1:${digest}`;
}

export function embeddingBytes(embedding: readonly number[] | undefined): Buffer | null {
  return embedding === undefined ? null : Buffer.from(new Float32Array(embedding).buffer);
}
