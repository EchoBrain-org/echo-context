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
  // discriminator one-liner per item 025
  "Use when you have a specific list of atom IDs (from `find_clusters.clusters[].atom_ids[]` or `search_memories.matches[].id`) and want their bodies. The targeted body-fetch counterpart to `find_clusters`' cheap discovery.\n\n" +
  // cost class
  'Cost: medium. Each returned atom passes through the same wire-shape projector as `search_memories` (per-content cap, per-key metadata cap, projector reshapes). Hard envelope ceiling: 25k chars; deterministic prefix-drop on overflow (see below).\n\n' +
  // shape
  'PARAMETERS:\n' +
  '  • `atom_ids: string[]` — required. Non-empty, ≤ ' +
  String(GET_ATOMS_MAX_IDS) +
  '. Atoms are returned in REQUESTED ORDER by default.\n' +
  '  • `fields?: string[]` — optional projection. When present, only the listed top-level fields are returned per atom (always-on: `id`, `source`, `timestamp`, `truncations`). Useful for cost reduction.\n' +
  '  • `format?: "minimal"` — V1.6 only ships "minimal" (applies WIRE_SHAPE_CAPS to content + per-key metadata). A future debug-only "full" mode is a separate item if real demand surfaces.\n' +
  '  • `prefer?: "as_requested" | "newest_first"` — default `"as_requested"` preserves the existing contract (atoms returned in input order; duplicate input IDs returned as repeated entries). Pass `"newest_first"` for resume-style queries: atoms are sorted by `CaptureEvent.timestamp` DESCENDING (newest first; ties resolve in input order), duplicate IDs are de-duplicated to first occurrence BEFORE sorting (NEW behavior — opt-in only), and missing IDs (not in storage) land at the END of the iteration order. Under the deterministic prefix-drop budget, that END is the FIRST thing dropped — so the freshest atoms survive overflow, matching the resume-call intent. If you have already ordered `atom_ids` intentionally, pass `"as_requested"` (or omit `prefer`) — `"newest_first"` will override your order.\n\n' +
  // truncations
  'TRUST SIGNAL — `truncations: string[]` is on EVERY returned atom. `[]` ⟺ everything verbatim. `["content"]` ⟺ content was clipped to the wire-shape cap. `["metadata.<key>"]` ⟺ per-key cap fired (LOSSY — opaqued out). `["metadata.<key>:projected"]` ⟺ projector reshaped (REFORMATTED, not clipped — e.g. tool_calls → trajectory). `["fields_omitted"]` ⟺ caller passed `fields[]` excluding some.\n\n' +
  // drop rule
  'DROP RULE — when the response would exceed 25k chars: deterministic prefix-drop. Atoms are appended in PROCESS ORDER (= requested order under `prefer="as_requested"` (default); = newest-first-then-missing under `prefer="newest_first"`) until the next atom would push the envelope over the ceiling; that atom AND every remaining ID in process order are dropped (NOT a hole in the middle). `atoms_dropped: N` + `atoms_dropped_ids: string[]` carry the omitted IDs in that same process order. Missing IDs (not in storage) are also reported in `atoms_dropped_ids`; under `prefer="newest_first"` they sort to the END of the process order so they are dropped first when the budget tightens.\n\n' +
  // when-too-big
  'If even a single projected atom alone would exceed 25k, the response is `{atoms: [], atoms_dropped: input_count, atoms_dropped_ids: [all]}` plus a warning telling the caller to retry with a narrower `fields[]` projection. We do NOT raise WIRE_SHAPE_CAPS to make this pass.';

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
  warnings: string[];
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
  const bytes = JSON.stringify(shaped).length;
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
    const tentative: GetAtomsResult = {
      schema_version: SCHEMA_VERSION,
      tool: 'get_atoms',
      atoms,
      atoms_dropped: worstCaseDroppedIds.length,
      atoms_dropped_ids: worstCaseDroppedIds,
      warnings,
    };
    const envBytes = JSON.stringify(tentative).length;
    if (envBytes > GET_ATOMS_RESPONSE_BYTE_CEILING) {
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
      break;
    }
  }

  if (firstAtomOversize) {
    warnings.push(
      'get_atoms: even the first projected atom alone exceeded the 25k response ceiling. ' +
        'Retry with a narrower `fields[]` projection (e.g. `fields=["content"]` to drop metadata).',
    );
  }

  return {
    schema_version: SCHEMA_VERSION,
    tool: 'get_atoms',
    atoms,
    atoms_dropped: atomsDroppedIds.length,
    atoms_dropped_ids: atomsDroppedIds,
    warnings,
  };
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
});

const getAtomsOutputSchema = {
  schema_version: z.literal(1),
  tool: z.literal('get_atoms'),
  atoms: z.array(getAtomsAtomSchema),
  atoms_dropped: z.number().int().nonnegative(),
  atoms_dropped_ids: z.array(z.string()),
  warnings: z.array(z.string()),
};

export function registerGetAtoms(server: McpServer, storage: Storage): void {
  server.registerTool(
    'get_atoms',
    {
      description: GET_ATOMS_DESCRIPTION,
      inputSchema: {
        atom_ids: z.array(z.string()).min(1).max(GET_ATOMS_MAX_IDS),
        fields: z.array(z.string()).optional(),
        format: formatSchema.optional(),
        prefer: preferSchema.optional(),
        view: viewSchema.optional(),
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
