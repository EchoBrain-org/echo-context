// V1.6 (item 033) — `get_atom`: full-atom recovery escape hatch.
//
// Sibling to `get_atoms` (plural). Where `get_atoms` is the cost-bounded
// targeted body-fetch (content + metadata both projected through
// WIRE_SHAPE_CAPS so 50 IDs at once stays under the 25k envelope),
// `get_atom` is the verbatim-content recovery for ONE atom — used when a
// consumer saw `truncations: ["content"]` on a prior call and needs the
// full original content body.
//
// Contract (per item 033 R1+R2 spec revisions):
//   - content:    VERBATIM (no WIRE_SHAPE_CAPS.match_content clip).
//   - metadata:   PROJECTED via the shared `projectMatch` pipeline —
//                 per-key cap (WIRE_SHAPE_CAPS.metadata_value) + tool_calls
//                 trajectory reshape. This is load-bearing: Codex atoms
//                 carry 120-130KB raw `tool_calls` (Bug A2 scale, journal
//                 line 737); verbatim metadata would always blow the
//                 envelope on the exact M1-3 recovery case the tool is
//                 supposed to fix.
//   - embedding:  EXCLUDED (projectMatch already drops it from the wire
//                 shape; we reuse that exclusion).
//   - truncations: returned ARRAY reflects the metadata projections that
//                 DID fire on this atom; `"content"` is filtered out of
//                 the carry-over from projectMatch because content is no
//                 longer clipped after the verbatim override.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Storage } from '../../storage/interface.js';
import { jsonByteLength } from '../wire-shape/bytes.js';
import { projectMatch } from '../wire-shape/match.js';

const SCHEMA_VERSION = 1;

// Hard envelope ceiling for `JSON.stringify(success_envelope)`. Same value
// as GET_ATOMS_RESPONSE_BYTE_CEILING but a separate constant so a future
// tightening of one doesn't accidentally tighten the other (item 033
// Implementation Notes).
export const GET_ATOM_RESPONSE_BYTE_CEILING = 25_000;

export const GET_ATOM_DESCRIPTION =
  'Fetch one known atom with verbatim content. Use this only after `search_memories` or `get_atoms` reports truncation; routine hydration belongs in `get_atoms`. Metadata remains bounded/projected and embeddings are omitted. If the full result cannot fit the 25,000-byte budget, `error_code="atom_too_large_for_wire"` returns the source pointer. `atom_not_found` means the ID is stale or invalid.';

export interface GetAtomParams {
  id: string;
}

/** Atom shape on the wire — content verbatim, metadata projected,
 *  embedding excluded. `truncations` reflects only the metadata-side
 *  projections that fired on this atom (any `"content"` carry-over from
 *  `projectMatch` is filtered, since content is unclipped here). */
export interface GetAtomAtom {
  id: string;
  source: string;
  timestamp: string;
  content: string;
  metadata?: Record<string, unknown>;
  truncations: string[];
}

export interface GetAtomSuccessResult {
  schema_version: 1;
  tool: 'get_atom';
  atom: GetAtomAtom;
  atom_size_bytes: number;
  warnings: string[];
}

export interface GetAtomErrorResult {
  schema_version: 1;
  tool: 'get_atom';
  atom: null;
  atom_size_bytes: number;
  error_code: 'atom_too_large_for_wire' | 'atom_not_found';
  source: string | null;
  warnings: string[];
}

export type GetAtomResult = GetAtomSuccessResult | GetAtomErrorResult;

const NOT_FOUND_WARNING = (id: string): string =>
  `No atom with id=${id} exists in storage. ` +
  'Verify the id was obtained from a current find_clusters / search_memories / get_atoms response — ' +
  'atom IDs are storage row IDs and cannot be guessed.';

const TOO_LARGE_WARNING =
  'Atom JSON exceeds 25_000-byte MCP envelope ceiling ' +
  'even with metadata projection; cannot transmit over MCP. ' +
  'Read source path directly to recover full content.';

export async function getAtom(storage: Storage, params: GetAtomParams): Promise<GetAtomResult> {
  const { id } = params;
  if (id === undefined || id === null || typeof id !== 'string' || id.length === 0) {
    throw new Error('get_atom: id is required and must be a non-empty string');
  }

  const fetched = await storage.getByIds([id]);
  if (fetched.length === 0) {
    // atom_not_found: short-circuit before projection / size check. The
    // ID is wrong or stale; do NOT project a synthetic shape.
    const err: GetAtomErrorResult = {
      schema_version: SCHEMA_VERSION,
      tool: 'get_atom',
      atom: null,
      atom_size_bytes: 0,
      error_code: 'atom_not_found',
      source: null,
      warnings: [NOT_FOUND_WARNING(id)],
    };
    return err;
  }

  const ev = fetched[0]!;

  // Project for metadata + embedding-strip. Then override content with
  // verbatim and filter "content" out of truncations because the
  // verbatim-content override invalidates that carry-over (R2 Finding 1).
  const projected = projectMatch(ev);
  const truncations = projected.truncations.filter((t) => t !== 'content');

  const atom: GetAtomAtom = {
    id: projected.id,
    source: projected.source,
    timestamp: projected.timestamp,
    content: ev.content,
    truncations,
  };
  if (projected.metadata !== undefined) {
    atom.metadata = projected.metadata;
  }

  const atomBytes = jsonByteLength(atom);

  const envelope: GetAtomSuccessResult = {
    schema_version: SCHEMA_VERSION,
    tool: 'get_atom',
    atom,
    atom_size_bytes: atomBytes,
    warnings: [],
  };
  const envBytes = jsonByteLength(envelope);

  if (envBytes > GET_ATOM_RESPONSE_BYTE_CEILING) {
    // Content (alone) is too large to fit even with projected metadata.
    // Surface the source path so the consumer knows where to read the
    // JSONL/SQLite fallback. atom_size_bytes carries the would-be size
    // for diagnostic purposes.
    const err: GetAtomErrorResult = {
      schema_version: SCHEMA_VERSION,
      tool: 'get_atom',
      atom: null,
      atom_size_bytes: atomBytes,
      error_code: 'atom_too_large_for_wire',
      source: ev.source,
      warnings: [TOO_LARGE_WARNING],
    };
    return err;
  }

  return envelope;
}

const getAtomAtomSchema = z.object({
  id: z.string(),
  source: z.string(),
  timestamp: z.string(),
  content: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  truncations: z.array(z.string()),
});

const getAtomOutputSchema = {
  schema_version: z.literal(1),
  tool: z.literal('get_atom'),
  atom: getAtomAtomSchema.nullable(),
  atom_size_bytes: z.number().int().nonnegative(),
  error_code: z.enum(['atom_too_large_for_wire', 'atom_not_found']).optional(),
  source: z.string().nullable().optional(),
  warnings: z.array(z.string()),
};

export function registerGetAtom(server: McpServer, storage: Storage): void {
  server.registerTool(
    'get_atom',
    {
      description: GET_ATOM_DESCRIPTION,
      inputSchema: {
        id: z.string().min(1).max(128),
      },
      outputSchema: getAtomOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const params = input as GetAtomParams;
      let result: GetAtomResult;
      try {
        result = await getAtom(storage, params);
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
