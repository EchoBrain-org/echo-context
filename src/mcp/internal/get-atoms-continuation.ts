import { createHash } from 'node:crypto';
import type { CaptureEvent } from '../../storage/interface.js';

export const GET_ATOMS_CURSOR_MAX_CHARS = 2_048;

export interface GetAtomsCursor {
  version: 1;
  request_digest: string;
  process_digest: string;
  next_process_index: number;
}

interface CompactGetAtomsCursorBody {
  v: 1;
  r: string;
  p: string;
  o: number;
}

interface CompactGetAtomsCursor extends CompactGetAtomsCursorBody {
  c: string;
}

export class GetAtomsCursorError extends Error {
  constructor(code: 'INVALID' | 'MISMATCH' | 'STALE', detail: string) {
    super(
      `[GET_ATOMS_CURSOR_${code}] ${detail}; repeat the original atom_ids and projection options with the prior next_cursor verbatim`,
    );
    this.name = 'GetAtomsCursorError';
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

export function getAtomsRequestDigest(input: {
  atom_ids: readonly string[];
  fields: readonly string[] | undefined;
  prefer: 'as_requested' | 'newest_first';
  view: 'compact' | 'rich';
}): string {
  return digest({
    atom_ids: input.atom_ids,
    fields:
      input.fields === undefined
        ? null
        : [...new Set(input.fields)].sort((left, right) => left.localeCompare(right)),
    prefer: input.prefer,
    view: input.view,
  });
}

export function getAtomsProcessDigest(
  processOrder: readonly string[],
  fetchedById: ReadonlyMap<string, CaptureEvent>,
): string {
  return digest(
    processOrder.map((id) => [id, fetchedById.get(id)?.timestamp ?? null]),
  );
}

export function encodeGetAtomsCursor(cursor: GetAtomsCursor): string {
  const body: CompactGetAtomsCursorBody = {
    v: 1,
    r: cursor.request_digest,
    p: cursor.process_digest,
    o: cursor.next_process_index,
  };
  const compact: CompactGetAtomsCursor = { ...body, c: digest(body) };
  const encoded = Buffer.from(JSON.stringify(compact), 'utf8').toString('base64url');
  if (encoded.length > GET_ATOMS_CURSOR_MAX_CHARS) {
    throw new GetAtomsCursorError('INVALID', 'cursor exceeds its bounded wire size');
  }
  return encoded;
}

export function decodeGetAtomsCursor(raw: string): GetAtomsCursor {
  if (
    raw.length === 0 ||
    raw.length > GET_ATOMS_CURSOR_MAX_CHARS ||
    !/^[A-Za-z0-9_-]+$/.test(raw)
  ) {
    throw new GetAtomsCursorError('INVALID', 'cursor is not bounded base64url');
  }

  let parsed: unknown;
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== raw) {
      throw new Error('non-canonical base64url');
    }
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    throw new GetAtomsCursorError('INVALID', 'cursor does not decode to canonical JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new GetAtomsCursorError('INVALID', 'cursor JSON is not an object');
  }

  const obj = parsed as Partial<CompactGetAtomsCursor>;
  const allowedKeys = new Set(['v', 'r', 'p', 'o', 'c']);
  if (
    Object.keys(obj).some((key) => !allowedKeys.has(key)) ||
    obj.v !== 1 ||
    typeof obj.r !== 'string' ||
    !/^[0-9a-f]{64}$/.test(obj.r) ||
    typeof obj.p !== 'string' ||
    !/^[0-9a-f]{64}$/.test(obj.p) ||
    !Number.isInteger(obj.o) ||
    (obj.o ?? -1) < 1 ||
    (obj.o ?? 51) > 50
  ) {
    throw new GetAtomsCursorError('INVALID', 'cursor fields are invalid');
  }
  if (typeof obj.c !== 'string' || !/^[0-9a-f]{64}$/.test(obj.c)) {
    throw new GetAtomsCursorError('INVALID', 'cursor integrity tag is invalid');
  }
  const { c: integrityTag, ...integrityBody } = obj;
  if (integrityTag !== digest(integrityBody)) {
    throw new GetAtomsCursorError('INVALID', 'cursor integrity check failed');
  }

  return {
    version: 1,
    request_digest: obj.r,
    process_digest: obj.p,
    next_process_index: obj.o!,
  };
}
