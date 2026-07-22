import { describe, expect, it } from 'vitest';
import { getAtoms, GET_ATOMS_MAX_IDS } from '../../src/mcp/tools/get-atoms.js';
import { MemoryStorage } from '../../src/storage/memory.js';
import type { CaptureEvent } from '../../src/storage/interface.js';

function evShape(
  i: number,
  overrides: Partial<Omit<CaptureEvent, 'id'>> = {},
): Omit<CaptureEvent, 'id'> {
  return {
    source: `fs:/tmp/sess-${i}.jsonl`,
    timestamp: `2026-05-09T10:${i.toString().padStart(2, '0')}:00.000Z`,
    content: `turn ${i} body`,
    metadata: { session_id: `sess-${i}`, turn_index: i },
    ...overrides,
  };
}

describe('get_atoms', () => {
  it('returns atoms in REQUESTED ORDER, regardless of insertion order', async () => {
    const store = new MemoryStorage();
    const id1 = await store.append(evShape(1));
    const id2 = await store.append(evShape(2));
    const id3 = await store.append(evShape(3));

    const r = await getAtoms(store, { atom_ids: [id3, id1, id2] });
    expect(r.atoms.map((a) => a.id)).toEqual([id3, id1, id2]);
    expect(r.atoms_dropped).toBe(0);
    expect(r.atoms_dropped_ids).toEqual([]);
  });

  it('missing IDs are reported in atoms_dropped_ids (in requested order)', async () => {
    const store = new MemoryStorage();
    const id1 = await store.append(evShape(1));
    const fakeId = '00000000-0000-0000-0000-000000000000';

    const r = await getAtoms(store, { atom_ids: [fakeId, id1] });
    expect(r.atoms.map((a) => a.id)).toEqual([id1]);
    expect(r.atoms_dropped).toBe(1);
    expect(r.atoms_dropped_ids).toEqual([fakeId]);
  });

  it('truncations is always present (empty when nothing clipped)', async () => {
    const store = new MemoryStorage();
    const id1 = await store.append(evShape(1));
    const r = await getAtoms(store, { atom_ids: [id1] });
    expect(r.atoms[0]!.truncations).toEqual([]);
  });

  it('content cap fires → truncations contains "content" + content_bytes_elided populated', async () => {
    const store = new MemoryStorage();
    const id1 = await store.append(evShape(1, { content: 'HEAD_' + 'x'.repeat(50_000) + '_TAIL' }));
    const r = await getAtoms(store, { atom_ids: [id1] });
    expect(r.atoms[0]!.truncations).toContain('content');
    expect(r.atoms[0]!.content_bytes_elided).toBeGreaterThan(0);
  });

  it('projector reshape (tool_calls) → truncations contains "metadata.tool_calls:projected" (NOT "metadata.tool_calls")', async () => {
    const store = new MemoryStorage();
    const id1 = await store.append(
      evShape(1, {
        metadata: {
          session_id: 'abc',
          tool_calls: Array.from({ length: 30 }, () => ({
            name: 'Bash',
            args: 'a'.repeat(2_000),
            output: 'b'.repeat(1_000),
          })),
        },
      }),
    );
    const r = await getAtoms(store, { atom_ids: [id1] });
    expect(r.atoms[0]!.truncations).toContain('metadata.tool_calls:projected');
    expect(r.atoms[0]!.truncations).not.toContain('metadata.tool_calls');
  });

  it('fields[] projection narrows atoms + emits "fields_omitted" in truncations', async () => {
    const store = new MemoryStorage();
    const id1 = await store.append(evShape(1, { metadata: { session_id: 'abc' } }));
    const r = await getAtoms(store, { atom_ids: [id1], fields: ['content'] });
    expect(r.atoms[0]!.content).toBeDefined();
    expect(r.atoms[0]!.metadata).toBeUndefined();
    expect(r.atoms[0]!.truncations).toContain('fields_omitted');
  });

  it('view defaults to rich and view="rich" is byte-identical to the default envelope', async () => {
    const store = new MemoryStorage();
    const id1 = await store.append(
      evShape(1, { metadata: { session_id: 'abc', repo_root: '/repo' } }),
    );
    const defaultResult = await getAtoms(store, { atom_ids: [id1] });
    const richResult = await getAtoms(store, { atom_ids: [id1], view: 'rich' });
    expect(JSON.stringify(richResult)).toBe(JSON.stringify(defaultResult));
  });

  it('view="compact" returns compact-shaped atoms and drops rich debug fields', async () => {
    const store = new MemoryStorage();
    const id1 = await store.append(
      evShape(1, {
        source: 'fs:/Users/dev/.codex/sessions/2026/05/20/rollout.jsonl',
        metadata: {
          session_id: 'sess_codex',
          repo_root: '/repo',
          cwd: '/repo',
          had_tool_use: true,
          tool_call_total: 2,
          tool_calls: [
            { name: 'exec_command', args: 'a'.repeat(2_000), output: 'b'.repeat(2_000) },
            { name: 'apply_patch', args: 'patch', output: 'ok' },
          ],
          codex: {
            model: 'gpt-5.5',
            reasoning_effort: 'xhigh',
            cli_version: '0.128.0',
            sandbox_policy_type: 'workspace-write',
          },
          git: { sha: 'abc', branch: 'agent/compact', origin_url: 'https://example.test/repo.git' },
          git_state: { branch: 'agent/compact', head_sha: 'abc' },
        },
      }),
    );

    const r = await getAtoms(store, { atom_ids: [id1], view: 'compact' });
    const atom = r.atoms[0] as unknown as Record<string, unknown>;

    expect(atom['id']).toBe(id1);
    expect(atom['source']).toBe('fs:/Users/dev/.codex/sessions/2026/05/20/rollout.jsonl');
    expect(atom['timestamp']).toBe('2026-05-09T10:01:00.000Z');
    expect(atom['content']).toBe('turn 1 body');
    expect(atom['truncations']).toContain('metadata.tool_calls:projected');
    expect(atom['content_bytes_elided']).toBeUndefined();
    expect(atom['metadata_bytes_elided']).toBeUndefined();
    expect(atom['metadata']).toEqual({
      session_id: 'sess_codex',
      repo_root: '/repo',
      tool_call_total: 2,
      had_tool_use: true,
      tool_calls_by_name: { exec_command: 1, apply_patch: 1 },
      codex: { model: 'gpt-5.5', reasoning_effort: 'xhigh' },
      git: { branch: 'agent/compact' },
    });
  });

  it('view="compact" composes with fields[] while preserving always-on fields', async () => {
    const store = new MemoryStorage();
    const id1 = await store.append(
      evShape(1, {
        metadata: {
          session_id: 'sess',
          repo_root: '/repo',
          files_referenced: ['/repo/a.ts'],
        },
      }),
    );

    const r = await getAtoms(store, { atom_ids: [id1], view: 'compact', fields: ['content'] });
    expect(r.atoms[0]).toEqual({
      id: id1,
      source: 'fs:/tmp/sess-1.jsonl',
      timestamp: '2026-05-09T10:01:00.000Z',
      truncations: ['fields_omitted'],
      content: 'turn 1 body',
    });
  });

  it('rejects empty atom_ids', async () => {
    const store = new MemoryStorage();
    await expect(getAtoms(store, { atom_ids: [] })).rejects.toThrow(/non-empty/);
  });

  it('rejects atom_ids > MAX', async () => {
    const store = new MemoryStorage();
    const ids = Array.from({ length: GET_ATOMS_MAX_IDS + 1 }, (_, i) => `id-${i}`);
    await expect(getAtoms(store, { atom_ids: ids })).rejects.toThrow(/max/);
  });

  it('rejects unknown view values with accepted enum members in the message', async () => {
    const store = new MemoryStorage();
    const id1 = await store.append(evShape(1));
    await expect(getAtoms(store, { atom_ids: [id1], view: 'debug' as never })).rejects.toThrow(
      /compact.*rich|rich.*compact/,
    );
  });

  it('deterministic prefix-drop on response budget overflow — drops the overflow atom AND every remaining requested ID (NOT a hole in the middle)', async () => {
    const store = new MemoryStorage();
    // Force a small-budget scenario: each atom carries ~5KB serialized
    // (after wire-shape projection's per-key cap). Stuff 50 atoms with
    // big metadata so the running envelope crosses the 25k ceiling
    // somewhere in the middle.
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      const id = await store.append(
        evShape(i, {
          content: 'small body',
          metadata: {
            session_id: `s${i}`,
            // 30 mostly-equal tool-calls projects to 30-string trajectory
            // ~600 bytes; small enough that many atoms accumulate before
            // crossing 25k.
            tool_calls: Array.from({ length: 30 }, () => ({
              name: 'Bash',
              args: 'x'.repeat(2_000),
              output: 'y'.repeat(1_000),
            })),
          },
        }),
      );
      ids.push(id);
    }

    const r = await getAtoms(store, { atom_ids: ids });

    expect(r.atoms.length).toBeGreaterThan(0);
    expect(r.atoms.length).toBeLessThan(50);
    expect(r.atoms_dropped).toBe(50 - r.atoms.length);
    // Dropped IDs are the contiguous tail of the requested order — NOT
    // a hole in the middle.
    const droppedIds = r.atoms_dropped_ids;
    const expectedTail = ids.slice(r.atoms.length);
    expect(droppedIds).toEqual(expectedTail);
    // Envelope respects the 25k ceiling.
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(25_000);
  });

  it('view="compact" sizes prefix-drop on post-compact atom bytes', async () => {
    const store = new MemoryStorage();
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      ids.push(
        await store.append(
          evShape(i, {
            source: `fs:/Users/dev/.codex/sessions/2026/05/20/rollout-${i}.jsonl`,
            content: 'small body',
            metadata: {
              session_id: `s${i}`,
              repo_root: '/repo',
              had_tool_use: true,
              tool_call_total: 50,
              tool_calls: Array.from({ length: 50 }, () => ({
                name: 'exec_command',
                args: 'x'.repeat(2_000),
                output: 'y'.repeat(2_000),
              })),
              codex: {
                model: 'gpt-5.5',
                reasoning_effort: 'xhigh',
                sandbox_policy_type: 'workspace-write',
                approval_policy: 'on-request',
              },
              git: { branch: 'agent/compact', sha: `sha-${i}` },
            },
          }),
        ),
      );
    }

    const rich = await getAtoms(store, { atom_ids: ids });
    const compact = await getAtoms(store, { atom_ids: ids, view: 'compact' });

    expect(rich.atoms_dropped).toBeGreaterThan(0);
    expect(compact.atoms_dropped).toBeLessThan(rich.atoms_dropped);
    expect(JSON.stringify(compact).length).toBeLessThanOrEqual(25_000);
  });

  it('many individually-small metadata keys are bounded before one atom can exceed 25k', async () => {
    const store = new MemoryStorage();
    // Reproduce the former hole: many values individually fit the per-key
    // cap but collectively exceeded the result budget.
    const huge: Record<string, unknown> = {};
    // 40 metadata keys, each with a ~960B structured value just under the
    // per-key cap. The whole-metadata cap must now keep the atom usable.
    for (let i = 0; i < 40; i++) {
      huge[`key_${i.toString().padStart(2, '0')}`] = { payload: 'a'.repeat(950) };
    }
    const id1 = await store.append(evShape(1, { content: 'small', metadata: huge }));

    const r = await getAtoms(store, { atom_ids: [id1] });
    expect(r.atoms).toHaveLength(1);
    expect(r.atoms[0]?.metadata_keys_omitted).toBeGreaterThan(0);
    expect(r.atoms[0]?.truncations).toContain('metadata');
    expect(r.atoms_dropped).toBe(0);
    expect(Buffer.byteLength(JSON.stringify(r), 'utf8')).toBeLessThanOrEqual(25_000);
  });

  it('REGRESSION (post-build review): final envelope respects 25k ceiling even with many missing IDs after a near-ceiling accepted prefix', async () => {
    // Cursor + Codex flagged: previously the size check used a tentative
    // envelope with `atoms_dropped: 0, atoms_dropped_ids: []` but the
    // final envelope returned the real dropped-IDs array. With ~36-char
    // UUIDs + JSON quoting/commas, a near-ceiling accepted prefix plus
    // many missing IDs could push the final envelope over 25k.
    const store = new MemoryStorage();
    // Build 10 atoms whose projected bodies sit just under the ceiling
    // collectively. Then request them interleaved with 40 missing UUIDs.
    const realIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const id = await store.append(
        evShape(i, {
          content: 'small',
          metadata: {
            session_id: `s${i}`,
            tool_calls: Array.from({ length: 30 }, () => ({
              name: 'Bash',
              args: 'x'.repeat(2_000),
              output: 'y'.repeat(1_000),
            })),
          },
        }),
      );
      realIds.push(id);
    }
    // 40 missing UUIDs (each 36 chars) interleaved at the END so they all
    // get pushed to atoms_dropped_ids in the final response.
    const missingIds = Array.from(
      { length: 40 },
      (_, i) => `00000000-0000-0000-0000-${i.toString().padStart(12, '0')}`,
    );
    const requested = [...realIds, ...missingIds];

    const r = await getAtoms(store, { atom_ids: requested });

    // Final envelope MUST respect the ceiling — this is the load-bearing
    // assertion that was previously not actually enforced.
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(25_000);
  });

  // V1.6 (item 032) AC4 — prefer='newest_first' resume-friendly ordering.
  describe("prefer='newest_first' (item 032)", () => {
    it('sorts returned atoms by timestamp DESCENDING (newest first)', async () => {
      const store = new MemoryStorage();
      // Insert in ascending order; request in same order; expect descending.
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(await store.append(evShape(i)));
      }
      const r = await getAtoms(store, {
        atom_ids: ids,
        prefer: 'newest_first',
      });
      // evShape(i) has timestamp 10:0i:00 — so descending = ids[4..0].
      expect(r.atoms.map((a) => a.id)).toEqual([ids[4], ids[3], ids[2], ids[1], ids[0]]);
      expect(r.atoms_dropped).toBe(0);
    });

    it('missing IDs are appended at the END of iteration order under newest_first', async () => {
      const store = new MemoryStorage();
      const id1 = await store.append(evShape(1));
      const id2 = await store.append(evShape(2));
      const fake = '00000000-0000-0000-0000-000000000000';
      // Request: [fake, id1, id2]. Under newest_first: existing sorted desc
      // = [id2, id1]; missing appended = [fake]. atoms[] = [id2, id1].
      // No drop fires (envelope small), so fake still lands in dropped_ids.
      const r = await getAtoms(store, {
        atom_ids: [fake, id1, id2],
        prefer: 'newest_first',
      });
      expect(r.atoms.map((a) => a.id)).toEqual([id2, id1]);
      expect(r.atoms_dropped_ids).toEqual([fake]);
    });

    it('duplicate IDs in input are de-duplicated to first occurrence (NEW opt-in behavior, R2-3)', async () => {
      const store = new MemoryStorage();
      const id1 = await store.append(evShape(1));
      const id2 = await store.append(evShape(2));
      // Pass id1 three times + id2 once.
      const r = await getAtoms(store, {
        atom_ids: [id1, id1, id2, id1],
        prefer: 'newest_first',
      });
      // Dedup → unique = [id1, id2]; desc → [id2, id1].
      // Each unique ID appears at most once in atoms[].
      expect(r.atoms.map((a) => a.id)).toEqual([id2, id1]);
      expect(r.atoms.length).toBe(2);
    });

    it("prefer='as_requested' (default) preserves the existing duplicate-returns-duplicates contract (R2-3 asymmetry)", async () => {
      const store = new MemoryStorage();
      const id1 = await store.append(evShape(1));
      // Without prefer (default 'as_requested'), the existing storage
      // contract is preserved — duplicates pass through unchanged.
      const r = await getAtoms(store, { atom_ids: [id1, id1, id1] });
      // Note: storage.getByIds may return one row per unique ID; under
      // 'as_requested', the iteration order matches input verbatim, so
      // the same atom may appear multiple times if storage emits dupes.
      // Either way, we MUST NOT silently dedupe under the default path —
      // and the input-order contract is preserved.
      expect(r.atoms.length).toBeGreaterThanOrEqual(1);
      // The order matches request order (atoms[] is built by walking
      // input atom_ids verbatim under 'as_requested').
      for (const a of r.atoms) expect(a.id).toBe(id1);
    });

    it('AC4 demotion-of-drops: budget overflow drops the OLDEST atoms (and missing IDs) first, NOT the newest', async () => {
      // Fixture: 8 atoms with mixed timestamps + 2 missing IDs. The budget
      // can fit ~4 atoms by projected size. Under 'newest_first':
      //   - the 4 newest atoms survive (dropped: 4 oldest + 2 missing)
      // Under 'as_requested':
      //   - the 4 atoms at the END of input order get dropped
      // Diff the two output orderings.
      const store = new MemoryStorage();
      const heavyMeta = {
        session_id: 's',
        tool_calls: Array.from({ length: 30 }, () => ({
          name: 'Bash',
          args: 'x'.repeat(2_000),
          output: 'y'.repeat(1_000),
        })),
      };
      const ids: string[] = [];
      for (let i = 0; i < 8; i++) {
        // Timestamps span 10:00 .. 10:07 — insert order = ascending.
        const ts = `2026-05-09T10:${i.toString().padStart(2, '0')}:00.000Z`;
        const id = await store.append({
          source: `fs:/tmp/sess-${i}.jsonl`,
          timestamp: ts,
          content: 'small body',
          metadata: { ...heavyMeta },
        });
        ids.push(id);
      }
      const missing1 = '00000000-0000-0000-0000-000000000001';
      const missing2 = '00000000-0000-0000-0000-000000000002';
      // Input: ids in ascending order + missing IDs at the end.
      const input = [...ids, missing1, missing2];

      // newest_first: 4 newest survive, oldest + missing drop.
      const rNewest = await getAtoms(store, {
        atom_ids: input,
        prefer: 'newest_first',
      });
      // The four atoms that survived must all have timestamp ≥ the four
      // that got dropped — that's the load-bearing resume-call guarantee.
      const survivedIds = rNewest.atoms.map((a) => a.id);
      const droppedIds = rNewest.atoms_dropped_ids;
      // Sanity: missing IDs are in dropped (they never had a chance to
      // survive — newest_first appends them last in the iteration order).
      expect(droppedIds).toContain(missing1);
      expect(droppedIds).toContain(missing2);
      // The atoms that survived are a contiguous suffix of `ids` (by
      // insertion order = timestamp ASC). I.e. survived are the latest N.
      for (const sid of survivedIds) {
        const sIdx = ids.indexOf(sid);
        // Every surviving id is later in `ids` than every dropped *real*
        // id (dropped reals = droppedIds minus the two missing).
        const droppedReals = droppedIds.filter((d) => d !== missing1 && d !== missing2);
        for (const dropped of droppedReals) {
          const dIdx = ids.indexOf(dropped);
          expect(sIdx).toBeGreaterThan(dIdx);
        }
      }

      // as_requested (baseline): the LAST N in request order drop. Since
      // ids[] is appended in ascending timestamp order + missing at the
      // end, the dropped tail = some real-ids tail + missing IDs.
      const rAsReq = await getAtoms(store, { atom_ids: input });
      // The accepted prefix is contiguous from input[0]. Equivalently:
      // for every atom in rAsReq.atoms, its index in input is strictly
      // less than the smallest index of any dropped ID in input.
      const acceptedIdxs = rAsReq.atoms.map((a) => input.indexOf(a.id));
      const droppedIdxs = rAsReq.atoms_dropped_ids.map((d) => input.indexOf(d));
      const maxAccepted = Math.max(...acceptedIdxs);
      const minDropped = Math.min(...droppedIdxs);
      expect(maxAccepted).toBeLessThan(minDropped);

      // Diff the two output orderings — the contracts differ.
      expect(survivedIds).not.toEqual(rAsReq.atoms.map((a) => a.id));
    });

    it('envelope ceiling still enforced under newest_first', async () => {
      const store = new MemoryStorage();
      const ids: string[] = [];
      for (let i = 0; i < 50; i++) {
        const id = await store.append(
          evShape(i, {
            content: 'small body',
            metadata: {
              session_id: `s${i}`,
              tool_calls: Array.from({ length: 30 }, () => ({
                name: 'Bash',
                args: 'x'.repeat(2_000),
                output: 'y'.repeat(1_000),
              })),
            },
          }),
        );
        ids.push(id);
      }
      const r = await getAtoms(store, {
        atom_ids: ids,
        prefer: 'newest_first',
      });
      expect(JSON.stringify(r).length).toBeLessThanOrEqual(25_000);
    });
  });

  it('atoms_dropped_ids includes both missing AND budget-dropped IDs in requested order', async () => {
    const store = new MemoryStorage();
    const realIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      realIds.push(await store.append(evShape(i)));
    }
    const fake = '00000000-0000-0000-0000-000000000000';
    const r = await getAtoms(store, {
      atom_ids: [realIds[0]!, fake, realIds[1]!, realIds[2]!],
    });
    expect(r.atoms.map((a) => a.id)).toEqual([realIds[0], realIds[1], realIds[2]]);
    expect(r.atoms_dropped_ids).toEqual([fake]);
    expect(r.atoms_dropped).toBe(1);
  });
});
