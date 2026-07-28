import { describe, expect, it } from 'vitest';
import { getAtom, GET_ATOM_RESPONSE_BYTE_CEILING } from '../../src/mcp/tools/get-atom.js';
import { MemoryStorage } from '../../src/storage/memory.js';
import type { CaptureEvent } from '../../src/storage/interface.js';
import { WIRE_SHAPE_CAPS } from '../../src/mcp/wire-shape/caps.js';

function evShape(
  i: number,
  overrides: Partial<Omit<CaptureEvent, 'id'>> = {},
): Omit<CaptureEvent, 'id'> {
  return {
    source: `fs:/tmp/sess-${i}.jsonl`,
    timestamp: `2026-05-10T22:${i.toString().padStart(2, '0')}:00.000Z`,
    content: `turn ${i} body`,
    metadata: { session_id: `sess-${i}`, turn_index: i },
    ...overrides,
  };
}

describe('get_atom', () => {
  it('AC4 unit #1 — content verbatim + metadata projected + truncations cleanup', async () => {
    // Insert an atom with content longer than WIRE_SHAPE_CAPS.match_content
    // (so projectMatch's content-clip would have set truncations:["content"]
    // — we MUST filter that out after the verbatim override) plus metadata
    // mixing a small key (passes verbatim) and a large `tool_calls` array
    // (projected to trajectory).
    const longContent = 'HEAD_' + 'L'.repeat(WIRE_SHAPE_CAPS.match_content + 3_000) + '_TAIL';
    const store = new MemoryStorage();
    const id = await store.append(
      evShape(1, {
        content: longContent,
        metadata: {
          session_id: 'abc',
          git_state: { branch: 'main', dirty: false },
          tool_calls: Array.from({ length: 30 }, () => ({
            name: 'Bash',
            args: 'a'.repeat(2_000),
            output: 'b'.repeat(1_000),
          })),
        },
      }),
    );

    const r = await getAtom(store, { id });
    expect(r.atom).not.toBeNull();
    if (r.atom === null) return; // narrowing for TS — never reached after assertion

    // Content verbatim — byte-for-byte equal to input.
    expect(r.atom.content).toBe(longContent);

    // tool_calls projected (NOT verbatim 8KB+).
    const md = r.atom.metadata!;
    expect(Array.isArray(md.tool_calls)).toBe(true);
    // The trajectory projection yields strings (one per call), not raw objects.
    expect(typeof (md.tool_calls as unknown[])[0]).toBe('string');

    // Small keys pass verbatim.
    expect(md.session_id).toBe('abc');
    expect(md.git_state).toEqual({ branch: 'main', dirty: false });

    // Embedding excluded.
    expect((r.atom as unknown as Record<string, unknown>).embedding).toBeUndefined();

    // truncations: "content" filtered out (load-bearing R2 Finding 1).
    expect(r.atom.truncations).not.toContain('content');
    expect(r.atom.truncations).toContain('metadata.tool_calls:projected');

    // atom_size_bytes matches JSON.stringify(atom).length.
    expect(r.atom_size_bytes).toBe(JSON.stringify(r.atom).length);
  });

  it('AC4 unit #2 — Codex-realistic recovery (10KB content + 130KB tool_calls metadata)', async () => {
    // The load-bearing test: a Codex long turn with content above the
    // match_content cap (so truncations:["content"] would have fired) AND
    // metadata.tool_calls at the documented Bug A2 scale (~130KB raw).
    // get_atom MUST: succeed (NOT atom_too_large), return content verbatim
    // (10KB), project tool_calls so the envelope fits the 25k ceiling.
    const codexContent = 'C'.repeat(10_000);
    const huge_tool_calls = Array.from({ length: 200 }, (_, i) => ({
      name: i % 3 === 0 ? 'Bash' : i % 3 === 1 ? 'Read' : 'Grep',
      args: 'arg'.repeat(100),
      output: 'out'.repeat(100),
    }));
    // sanity: tool_calls JSON should be ~130KB territory
    expect(JSON.stringify(huge_tool_calls).length).toBeGreaterThan(120_000);

    const store = new MemoryStorage();
    const id = await store.append(
      evShape(2, {
        content: codexContent,
        metadata: {
          session_id: 'codex-1',
          tool_calls: huge_tool_calls,
        },
      }),
    );

    const r = await getAtom(store, { id });
    // Success path — NOT atom_too_large.
    expect(r.atom).not.toBeNull();
    if (r.atom === null) return;
    expect((r as { error_code?: string }).error_code).toBeUndefined();

    // Content verbatim.
    expect(r.atom.content).toBe(codexContent);

    // truncations: no "content" (load-bearing), but metadata.tool_calls projected.
    expect(r.atom.truncations).not.toContain('content');
    expect(r.atom.truncations).toContain('metadata.tool_calls:projected');

    // Envelope fits the ceiling.
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(GET_ATOM_RESPONSE_BYTE_CEILING);
  });

  it('AC4 unit #3 — content too large → atom_too_large_for_wire with source populated', async () => {
    // Content alone exceeds the 25k ceiling. metadata is minimal so
    // projection can't rescue it.
    const giant = 'X'.repeat(30_000);
    const store = new MemoryStorage();
    const id = await store.append(evShape(3, { content: giant, metadata: { session_id: 'big' } }));

    const r = await getAtom(store, { id });
    expect(r.atom).toBeNull();
    if (r.atom !== null) return;

    expect((r as { error_code?: string }).error_code).toBe('atom_too_large_for_wire');
    expect((r as { source?: string | null }).source).toBe(`fs:/tmp/sess-3.jsonl`);
    // atom_size_bytes ≈ giant.length + envelope overhead
    expect(r.atom_size_bytes).toBeGreaterThan(30_000);
    expect(r.atom_size_bytes).toBeLessThan(31_000);
    expect(r.warnings.some((w) => w.includes('25_000-byte'))).toBe(true);
  });

  it('keeps the too-large error bounded when the source is escape-heavy', async () => {
    const store = new MemoryStorage();
    const source = 'fs:/' + '\\"'.repeat(7_000);
    const id = await store.append(
      evShape(3, {
        source,
        content: 'X'.repeat(50_000),
        metadata: { session_id: 'escape-heavy' },
      }),
    );

    const result = await getAtom(store, { id });
    expect(result.atom).toBeNull();
    if (result.atom !== null) return;
    expect(result.error_code).toBe('atom_too_large_for_wire');
    expect(result.source).not.toBe(source);
    expect(result.warnings).toContainEqual(
      expect.stringContaining('[GET_ATOM_SOURCE_CAP]'),
    );
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(
      GET_ATOM_RESPONSE_BYTE_CEILING,
    );
  });

  it('AC4 unit #4 — content just-fits (22KB content + minimal metadata) → success path', async () => {
    // Validates the size check is precise enough to land 22KB content
    // under the 25k ceiling without spurious refusal.
    const fits = 'F'.repeat(22_000);
    const store = new MemoryStorage();
    const id = await store.append(
      evShape(4, { content: fits, metadata: { session_id: 'just-fits' } }),
    );

    const r = await getAtom(store, { id });
    expect(r.atom).not.toBeNull();
    if (r.atom === null) return;
    expect((r as { error_code?: string }).error_code).toBeUndefined();
    expect(r.atom.content).toBe(fits);
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(GET_ATOM_RESPONSE_BYTE_CEILING);
  });

  it('AC4 unit #5 — missing ID → atom_not_found (distinct from atom_too_large_for_wire)', async () => {
    const store = new MemoryStorage();
    const r = await getAtom(store, {
      id: '00000000-0000-0000-0000-000000000000',
    });
    expect(r.atom).toBeNull();
    if (r.atom !== null) return;

    expect((r as { error_code?: string }).error_code).toBe('atom_not_found');
    expect((r as { source?: string | null }).source).toBeNull();
    expect(r.atom_size_bytes).toBe(0);
    expect(r.warnings.some((w) => w.includes('No atom with id='))).toBe(true);
  });

  it('AC4 integration — round-trip from search-style truncations: ["content"]', async () => {
    // Insert atom with content > match_content cap. projectMatch (as used
    // by search_memories) would clip and emit truncations:["content"].
    // get_atom must return the atom with verbatim content AND with
    // "content" NOT in truncations.
    const original = 'PROBE_' + 'p'.repeat(WIRE_SHAPE_CAPS.match_content + 1_500) + '_END';
    const store = new MemoryStorage();
    const id = await store.append(evShape(5, { content: original }));

    // Verify projectMatch (the search/tail path) DOES clip.
    const { projectMatch } = await import('../../src/mcp/wire-shape/match.js');
    const fetched = await store.getByIds([id]);
    const projected = projectMatch(fetched[0]!);
    expect(projected.truncations).toContain('content');

    // Now the recovery: get_atom returns verbatim content with truncations
    // NOT including "content" — the trust signal correctly reflects that
    // the recovery call is no longer clipping content.
    const r = await getAtom(store, { id });
    expect(r.atom).not.toBeNull();
    if (r.atom === null) return;
    expect(r.atom.content).toBe(original);
    expect(r.atom.truncations).not.toContain('content');
  });

  it('rejects empty id', async () => {
    const store = new MemoryStorage();
    await expect(getAtom(store, { id: '' })).rejects.toThrow(/required/);
  });

  it('atom with no metadata → atom returned without metadata field, truncations empty', async () => {
    const store = new MemoryStorage();
    const id = await store.append({
      source: 'fs:/tmp/no-md.jsonl',
      timestamp: '2026-05-10T22:30:00.000Z',
      content: 'tiny',
    });
    const r = await getAtom(store, { id });
    expect(r.atom).not.toBeNull();
    if (r.atom === null) return;
    expect(r.atom.content).toBe('tiny');
    expect(r.atom.metadata).toBeUndefined();
    expect(r.atom.truncations).toEqual([]);
  });
});
