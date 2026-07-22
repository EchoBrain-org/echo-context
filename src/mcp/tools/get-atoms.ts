// V1.6 (item 030) — `get_atoms`: targeted body fetch by atom_id.
//
// Counterpart to `find_clusters` (which returns cluster shape + atom_ids
// without bodies). The pair replaces the compound `get_recent_work_context`
// tool: discovery is one cheap call, body fetch is a second targeted call,
// and the consumer's judgment between them is the actual win.
//
// `atom_ids[]` is the load-bearing input — IDs come from
// `find_clusters.clusters[].atom_ids[]` or `search_memories.matches[].id`.
// Atom IDs are persisted (echo.db row IDs); cluster IDs are
// deterministic-ephemeral hashes (system-architecture.md:140) and would
// be the wrong primitive to base targeted-fetch on.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { CaptureEvent, Storage } from '../../storage/interface.js';
import { jsonByteLength } from '../wire-shape/bytes.js';
import { compactAtom, type CompactAtom, type ViewMode } from '../wire-shape/compact.js';
import { projectMatch, type ProjectedMatch } from '../wire-shape/match.js';

const SCHEMA_VERSION = 1;

// Hard interactive ceiling for `JSON.stringify(result)`. Matches the 25k
// convention enforced by search/tail/recent-work-context tests so a
// 50-id request can't become a footgun. Spec §2 deterministic-drop rule.
export const GET_ATOMS_RESPONSE_BYTE_CEILING = 25_000;

// Hard cap on atom_ids per call. Mirrors search_memories' MAX_LIMIT (50)
// and is the documented contract (spec §2). The cap is the SOFT bound;
// the response budget is the HARD bound — even at 50, a request with
// large projected metadata will deterministic-prefix-drop.
export const GET_ATOMS_MAX_IDS = 50;

export const GET_ATOMS_DESCRIPTION =
  'Fetch bodies for known atom IDs from `find_clusters` or `search_memories`. Send 1–50 IDs per call; chunk larger cluster lists. The default `prefer="as_requested"` preserves input order and duplicates. Use `prefer="newest_first"` for resume flows; it de-duplicates, sorts newest first, and puts missing IDs last.\n\n' +
  '`fields` accepts only `content` and `metadata`; identity fields and `truncations` are always returned. `view="rich"` is the default; `compact` removes low-value metadata. `format="minimal"` is accepted only for compatibility and can be omitted. The complete JSON result is capped at 25,000 UTF-8 bytes. On overflow, the tool keeps a deterministic atom prefix. `atoms_dropped` is always exact; `atoms_dropped_ids` is a bounded process-order prefix and `atoms_dropped_ids_omitted`, when present, counts ID values excluded from that list. Inspect coded warnings and per-atom `truncations`. Use `get_atom(id)` when one atom’s verbatim content is required; its metadata remains projected.';

const formatSchema = z.enum(['minimal']);
const preferSchema = z.enum(['as_requested', 'newest_first']);
const viewSchema = z.enum(['compact', 'rich']);

export type GetAtomsPrefer = 'as_requested' | 'newest_first';

export interface GetAtomsParams {
  atom_ids: string[];
  fields?: string[];
  format?: 'minimal';
  prefer?: GetAtomsPrefer;
  view?: ViewMode;
}

/** Atom shape on the wire. Mirrors ProjectedMatch but keeps the spec's
 *  spec §2 field set explicitly. `truncations` is always present. */
export interface GetAtomsAtom {
  id: string;
  source: string;
  timestamp: string;
  /** Present unless caller's `fields[]` excluded. */
  content?: string;
  /** Present unless caller's `fields[]` excluded. */
  metadata?: Record<string, unknown>;
  /** Carries any per-key `metadata.<key>` or `metadata.<key>:projected`
   *  entries even when `metadata` itself is omitted from output, plus
   *  `content`, `fields_omitted`. ALWAYS present. */
  truncations: string[];
  /** Set only when `content` was clipped (mirrors search/tail). */
  content_bytes_elided?: number;
  /** Optional metadata-bytes elided count (sum across cap + projector). */
  metadata_bytes_elided?: number;
  /** Count of metadata keys omitted by the whole-metadata budget. */
  metadata_keys_omitted?: number;
}

export interface GetAtomsResult {
  schema_version: 1;
  tool: 'get_atoms';
  atoms: GetAtomsAtom[];
  atoms_dropped: number;
  /** Requested IDs that didn't make it into `atoms[]`, in the iteration order
   *  used by the caller's `prefer` mode (requested order under "as_requested";
   *  processed/newest-first order under "newest_first"). Includes both missing
   *  IDs (not in storage) and budget-dropped IDs. */
  atoms_dropped_ids: string[];
  /** Number of dropped ID values excluded from `atoms_dropped_ids` solely
   *  to keep the complete response inside its hard byte ceiling. The exact
   *  dropped-entry count remains available in `atoms_dropped`. */
  atoms_dropped_ids_omitted?: number;
  warnings: string[];
}

/** Shape a result while prioritizing useful atom bodies over an arbitrarily
 *  expensive echo of caller-supplied ID strings. `atoms_dropped` remains
 *  exact; only the tail of the redundant dropped-ID value list may be
 *  omitted. JSON escaping can make a 128-character ID cost up to 768 bytes,
 *  so character-count input limits alone cannot enforce the wire ceiling. */
function buildBoundedResult(
  atoms: GetAtomsAtom[],
  allDroppedIds: readonly string[],
  warnings: readonly string[],
  byteCeiling: number,
): GetAtomsResult {
  const result: GetAtomsResult = {
    schema_version: SCHEMA_VERSION,
    tool: 'get_atoms',
    atoms: [...atoms],
    atoms_dropped: allDroppedIds.length,
    atoms_dropped_ids: [...allDroppedIds],
    warnings: [...warnings],
  };

  if (jsonByteLength(result) <= byteCeiling) return result;
  if (result.atoms_dropped_ids.length === 0) return result;

  result.warnings.push(
    '[GET_ATOMS_DROPPED_ID_CAP] atoms_dropped_ids is a bounded process-order prefix; atoms_dropped and atoms_dropped_ids_omitted retain exact omission counts',
  );
  result.atoms_dropped_ids_omitted = 0;
  while (result.atoms_dropped_ids.length > 0 && jsonByteLength(result) > byteCeiling) {
    result.atoms_dropped_ids.pop();
    result.atoms_dropped_ids_omitted += 1;
  }
  return result;
}

const ALWAYS_KEEP_FIELDS = new Set(['id', 'source', 'timestamp', 'truncations']);

function validateView(view: unknown): ViewMode {
  if (view === undefined) return 'rich';
  if (view === 'compact' || view === 'rich') return view;
  throw new Error('get_atoms: view must be one of "compact" or "rich"');
}

/** Project a CaptureEvent through the shared `projectMatch` (so caps +
 *  projector reshapes match search/tail), then optionally narrow to the
 *  caller's `fields[]`. Returns the atom shape AND its serialized byte
 *  cost so the caller can make budget decisions without re-stringifying. */
function projectAtom(
  e: CaptureEvent,
  fields: Set<string> | undefined,
  view: ViewMode,
): { atom: GetAtomsAtom; bytes: number } {
  const projected: ProjectedMatch = projectMatch(e);

  const truncations: string[] = [...projected.truncations];

  // V1.5.6's bytes_elided is on `content`; rename here to disambiguate
  // from `metadata_bytes_elided` per spec §2's response shape.
  const atom: GetAtomsAtom = {
    id: projected.id,
    source: projected.source,
    timestamp: projected.timestamp,
    truncations,
  };
  if (projected.bytes_elided !== undefined) {
    atom.content_bytes_elided = projected.bytes_elided;
  }
  if (projected.metadata_bytes_elided !== undefined) {
    atom.metadata_bytes_elided = projected.metadata_bytes_elided;
  }
  if (projected.metadata_keys_omitted !== undefined) {
    atom.metadata_keys_omitted = projected.metadata_keys_omitted;
  }

  // Populate content / metadata, then narrow by fields[] if present.
  const fullContent = projected.content;
  const fullMetadata = projected.metadata;

  let fieldsOmitted = false;
  if (fields !== undefined) {
    if (fields.has('content') || ALWAYS_KEEP_FIELDS.has('content')) {
      atom.content = fullContent;
    } else {
      fieldsOmitted = true;
    }
    if (fields.has('metadata')) {
      if (fullMetadata !== undefined) atom.metadata = fullMetadata;
    } else if (fullMetadata !== undefined) {
      fieldsOmitted = true;
    }
  } else {
    atom.content = fullContent;
    if (fullMetadata !== undefined) atom.metadata = fullMetadata;
  }

  if (fieldsOmitted) atom.truncations.push('fields_omitted');

  const shaped: GetAtomsAtom =
    view === 'compact' ? applyCompactFields(compactAtom(atom), fields) : atom;
  const bytes = jsonByteLength(shaped);
  return { atom: shaped, bytes };
}

function applyCompactFields(atom: CompactAtom, fields: Set<string> | undefined): GetAtomsAtom {
  if (fields === undefined) return atom;
  const out: CompactAtom = {
    id: atom.id,
    source: atom.source,
    timestamp: atom.timestamp,
    truncations: [...atom.truncations],
  };
  let fieldsOmitted = false;
  if (fields.has('content')) {
    if (atom.content !== undefined) out.content = atom.content;
  } else if (atom.content !== undefined) {
    fieldsOmitted = true;
  }
  if (fields.has('metadata')) {
    if (atom.metadata !== undefined) out.metadata = atom.metadata;
  } else if (atom.metadata !== undefined) {
    fieldsOmitted = true;
  }
  if (fieldsOmitted) out.truncations.push('fields_omitted');
  return out;
}

/** Build the iteration order for the prefix-drop loop, given the caller's
 *  `prefer` choice. The list returned here is the order atoms are processed
 *  AND the order their IDs land in `atoms_dropped_ids` when the budget runs
 *  out. Item 032 (`prefer="newest_first"`):
 *    - duplicate IDs in input are de-duplicated to first occurrence BEFORE
 *      sorting (NEW behavior — opt-in; preserves the existing duplicates-
 *      returned-as-repeated-entries contract under `as_requested`),
 *    - existing rows are sorted by `CaptureEvent.timestamp` DESCENDING
 *      (newest first; ties resolve to original input order via stable sort),
 *    - missing IDs (not in storage) are appended at the END preserving
 *      their relative request order so the prefix-drop loop drops them
 *      before any existing atom.
 *  Under `as_requested` (default), the iteration order is the input verbatim
 *  — duplicates pass through, missing IDs sit at their original position. */
function buildProcessOrder(
  atom_ids: readonly string[],
  fetchedById: Map<string, CaptureEvent>,
  prefer: GetAtomsPrefer,
): string[] {
  if (prefer === 'as_requested') {
    return [...atom_ids];
  }
  // newest_first: dedupe → split existing vs missing → stable-sort existing
  // by timestamp desc → append missing.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of atom_ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  const existing: string[] = [];
  const missing: string[] = [];
  for (const id of unique) {
    if (fetchedById.has(id)) existing.push(id);
    else missing.push(id);
  }
  // Stable timestamp-desc sort: decorate with original position, sort,
  // then strip. Date.parse on ISO strings; non-parsable timestamps sort
  // to the end (treated as -Infinity for "newest first" ordering).
  const decorated = existing.map((id, idx) => {
    const ev = fetchedById.get(id)!;
    const t = Date.parse(ev.timestamp);
    return { id, idx, t: Number.isNaN(t) ? -Infinity : t };
  });
  decorated.sort((a, b) => {
    if (a.t !== b.t) return b.t - a.t;
    return a.idx - b.idx;
  });
  return [...decorated.map((d) => d.id), ...missing];
}

export async function getAtoms(storage: Storage, params: GetAtomsParams): Promise<GetAtomsResult> {
  const { atom_ids, fields, format, prefer: preferIn } = params;
  // Schema-side validation runs at registerTool boundary; defense-in-depth
  // here for in-process callers (tests, future programmatic callers).
  if (atom_ids === undefined) {
    throw new Error('get_atoms: atom_ids is required');
  }
  if (atom_ids.length === 0) {
    throw new Error('get_atoms: atom_ids must be non-empty');
  }
  if (atom_ids.length > GET_ATOMS_MAX_IDS) {
    throw new Error(`get_atoms: atom_ids exceeds max ${GET_ATOMS_MAX_IDS} per call`);
  }
  if (fields !== undefined) {
    for (const field of fields) {
      if (field !== 'content' && field !== 'metadata') {
        throw new Error('get_atoms: fields entries must be "content" or "metadata"');
      }
    }
  }
  // V1.6 only ships 'minimal' — `format` is essentially a future-proofing
  // marker today.
  void format;

  const prefer: GetAtomsPrefer = preferIn ?? 'as_requested';
  const view = validateView(params.view);

  const fieldsSet = fields !== undefined && fields.length > 0 ? new Set(fields) : undefined;

  const fetched = await storage.getByIds(atom_ids);
  const fetchedById = new Map<string, CaptureEvent>();
  for (const e of fetched) {
    fetchedById.set(e.id, e);
  }

  const processOrder = buildProcessOrder(atom_ids, fetchedById, prefer);

  const atoms: GetAtomsAtom[] = [];
  const atomsDroppedIds: string[] = [];
  const warnings: string[] = [];
  let firstAtomOversize = false;
  let responseCapFired = false;
  const missingCount = processOrder.reduce(
    (count, id) => count + (fetchedById.has(id) ? 0 : 1),
    0,
  );

  // Build the response in PROCESS ORDER (which equals REQUESTED ORDER under
  // `as_requested`, and equals [newest…oldest, then missing] under
  // `newest_first`). Track the running envelope size by building a
  // tentative object and checking JSON.stringify length — accurate but
  // expensive. Keep tentative atoms in a list, recompute the envelope
  // size after each addition, and drop+halt if the next atom would push
  // us over the ceiling. Matches spec §2 step 3-5.
  for (let i = 0; i < processOrder.length; i++) {
    const id = processOrder[i]!;
    const ev = fetchedById.get(id);
    if (ev === undefined) {
      atomsDroppedIds.push(id);
      continue;
    }

    const { atom } = projectAtom(ev, fieldsSet, view);

    // Tentatively add; check envelope.
    atoms.push(atom);
    // Build a tentative result envelope to size-check. The envelope is
    // sized as the WORST-CASE final shape if we stop after this atom:
    // current `atomsDroppedIds` (real prior misses) PLUS every remaining
    // ID in the process order (which would be drained on rollback per
    // spec §2 step 4). This guarantees the actual final envelope — whether
    // we keep going or roll back next iter — fits under the ceiling.
    // Without the worst-case dropped list, an accepted near-ceiling prefix
    // plus many missing or remaining UUIDs (~36 chars each + JSON
    // quoting) can exceed 25k post-check (Cursor + Codex post-build
    // review, 2026-05-10).
    const worstCaseDroppedIds = atomsDroppedIds.concat(processOrder.slice(i + 1));
    const tentative = buildBoundedResult(
      atoms,
      worstCaseDroppedIds,
      warnings,
      GET_ATOMS_RESPONSE_BYTE_CEILING - 512,
    );
    const envBytes = jsonByteLength(tentative);
    if (envBytes > GET_ATOMS_RESPONSE_BYTE_CEILING - 512) {
      // Roll back this atom AND every remaining ID per spec §2 step 4 —
      // deterministic prefix drop in PROCESS order.
      atoms.pop();
      atomsDroppedIds.push(id);
      for (let j = i + 1; j < processOrder.length; j++) {
        atomsDroppedIds.push(processOrder[j]!);
      }
      // Detect the "first projected atom alone would exceed 25k" footgun
      // (spec §2 step 6) — surface a guidance warning.
      if (atoms.length === 0) {
        firstAtomOversize = true;
      }
      responseCapFired = true;
      break;
    }
  }

  if (firstAtomOversize) {
    warnings.push(
      '[GET_ATOMS_RESPONSE_CAP] even the first projected atom exceeded the response budget; retry with fields=["content"] or fields=["metadata"]',
    );
  } else if (responseCapFired) {
    warnings.push(
      `[GET_ATOMS_RESPONSE_CAP] returned a process-order prefix; ${atomsDroppedIds.length} IDs were omitted or missing`,
    );
  }
  if (missingCount > 0) {
    warnings.push(`[GET_ATOMS_MISSING_IDS] ${missingCount} requested ID entries were not found`);
  }

  return buildBoundedResult(
    atoms,
    atomsDroppedIds,
    warnings,
    GET_ATOMS_RESPONSE_BYTE_CEILING,
  );
}

const getAtomsAtomSchema = z.object({
  id: z.string(),
  source: z.string(),
  timestamp: z.string(),
  content: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  truncations: z.array(z.string()),
  content_bytes_elided: z.number().int().nonnegative().optional(),
  metadata_bytes_elided: z.number().int().nonnegative().optional(),
  metadata_keys_omitted: z.number().int().nonnegative().optional(),
});

const getAtomsOutputSchema = {
  schema_version: z.literal(1),
  tool: z.literal('get_atoms'),
  atoms: z.array(getAtomsAtomSchema),
  atoms_dropped: z.number().int().nonnegative(),
  atoms_dropped_ids: z.array(z.string()),
  atoms_dropped_ids_omitted: z.number().int().nonnegative().optional(),
  warnings: z.array(z.string()),
};

export function registerGetAtoms(server: McpServer, storage: Storage): void {
  server.registerTool(
    'get_atoms',
    {
      description: GET_ATOMS_DESCRIPTION,
      inputSchema: {
        atom_ids: z.array(z.string().min(1).max(128)).min(1).max(GET_ATOMS_MAX_IDS),
        fields: z.array(z.enum(['content', 'metadata'])).max(2).optional(),
        format: formatSchema
          .optional()
          .describe('Compatibility-only singleton; omit it. Minimal projection is always applied.'),
        prefer: preferSchema
          .optional()
          .describe('as_requested (default) or newest_first for resume-style hydration.'),
        view: viewSchema
          .optional()
          .describe('rich (default) or compact to retain only high-signal metadata.'),
      },
      outputSchema: getAtomsOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const params = input as GetAtomsParams;
      let result: GetAtomsResult;
      try {
        result = await getAtoms(storage, params);
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: (err as Error).message }],
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );
}
