// V1.6 (item 030) acceptance #9 — apples-to-apples envelope test for the
// find_clusters + get_atoms decomposition vs the compound get_recent_work_context.
//
// Assertion shape (verbatim from spec):
//   bytes(find_clusters(since=now-24h, format='skeleton'))
//     + bytes(get_atoms(materialized_ids, format='minimal'))
//     ≤ bytes(get_recent_work_context(since=now-24h, format='minimal'))
//
// where materialized_ids is the same atom_id set the compound call materializes
// for the rank-1 cluster at format='minimal' (NOT all atom_ids in the cluster —
// the compound call may already truncate atoms inside the cluster's atom_ids[]
// when computing its `atoms[id]` body map). Use a fully-materialized fixture
// (atom count ≤ compound's per-cluster atom limit) to make the comparison fair.
//
// The point: targeted dive saves bytes vs compound call ON THE SAME EFFECTIVE
// PAYLOAD.

import { describe, expect, it } from 'vitest';
import { findClusters } from '../../src/mcp/tools/find-clusters.js';
import { getAtoms } from '../../src/mcp/tools/get-atoms.js';
import { getRecentWorkContext } from '../../src/mcp/tools/recent-work-context.js';
import { MemoryStorage } from '../../src/storage/memory.js';
import type { CaptureEvent } from '../../src/storage/interface.js';

const PROJECT_ECHO = '/Users/redacted/Desktop/Project_echo';

function ccTurn(
  i: number,
  filePath: string,
  ts: string,
): Omit<CaptureEvent, 'id'> {
  // Realistic-density: claude_code turn shape with non-trivial content
  // body and tool_calls metadata (the dominant byte source pre-projector).
  return {
    source: `fs:/Users/redacted/.claude/projects/sess-${i}.jsonl`,
    timestamp: ts,
    content:
      `USER: question ${i} about ${filePath}\n\n` +
      `ASSISTANT: ` +
      'a'.repeat(800), // ~870 chars — under match_content (2k), well under minimal_action (500) post-clip
    metadata: {
      session_id: `sess-${i}`,
      turn_index: i,
      cwd: PROJECT_ECHO,
      files_referenced: [filePath],
      git_state: { branch: 'main', head_sha: 'deadbeef' },
      // Smaller than realistic to keep one cluster fully materialized — the
      // get_recent_work_context per-cluster atom limit (DEFAULT_LIMIT=20) is
      // what bounds materialization, so we use 15 atoms to stay under it.
      tool_calls: Array.from({ length: 5 }, () => ({
        name: 'Bash',
        args: 'a'.repeat(200),
        output: 'b'.repeat(200),
      })),
    },
  };
}

describe('envelope: find_clusters + get_atoms ≤ get_recent_work_context (apples-to-apples)', () => {
  it('the chain envelope on a fully-materialized fixture stays within the compound call (acceptance #9)', async () => {
    const store = new MemoryStorage();
    const file = `${PROJECT_ECHO}/src/feature.ts`;
    const N = 15; // ≤ DEFAULT_LIMIT=20 so the compound call materializes every atom_id
    const now = new Date('2026-05-09T20:00:00.000Z');
    for (let i = 0; i < N; i++) {
      const minutesAgo = (N - i) * 10; // spread over ~150 minutes inside 24h
      const ts = new Date(now.getTime() - minutesAgo * 60_000).toISOString();
      await store.append(ccTurn(i, file, ts));
    }
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const until = now.toISOString();

    // 1) Compound call: get_recent_work_context(since=now-24h, format='minimal').
    const rwc = await getRecentWorkContext(
      store,
      { since, until, format: 'minimal' },
      now,
    );
    const compoundBytes = JSON.stringify(rwc).length;

    // Materialized atom_ids = the IDs the compound call actually surfaced
    // bodies for in `atoms` (not all cluster atom_ids — DEFAULT_LIMIT
    // truncation may have dropped some). With N=15 and DEFAULT_LIMIT=20,
    // every atom should be present, so this set is the entire fixture.
    const materializedIds = Object.keys(rwc.atoms);
    expect(materializedIds.length).toBe(N);

    // 2) Decomposed call A: find_clusters(since=now-24h, format='skeleton').
    const fc = await findClusters(store, { since, until, format: 'skeleton' }, now);
    const findBytes = JSON.stringify(fc).length;

    // 3) Decomposed call B: get_atoms(materialized_ids, format='minimal').
    //    materializedIds.length === N === 15 ≤ MAX (50), so single call.
    const ga = await getAtoms(store, {
      atom_ids: materializedIds,
      format: 'minimal',
    });
    const getBytes = JSON.stringify(ga).length;

    const chainBytes = findBytes + getBytes;

    // Load-bearing assertion: chain ≤ compound. The decomposition's
    // promise is "two targeted calls cost less than one compound call."
    expect(chainBytes).toBeLessThanOrEqual(compoundBytes);

    // Sanity: each piece is well under the 25k consumer ceiling on its own.
    expect(findBytes).toBeLessThan(25_000);
    expect(getBytes).toBeLessThan(25_000);
  });

  it('find_clusters cost target — < 10k chars on a 24h lookback (cheap-discovery class)', async () => {
    const store = new MemoryStorage();
    const file = `${PROJECT_ECHO}/src/x.ts`;
    const now = new Date('2026-05-09T20:00:00.000Z');
    for (let i = 0; i < 30; i++) {
      const ts = new Date(now.getTime() - i * 10 * 60_000).toISOString();
      await store.append(ccTurn(i, file, ts));
    }
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const fc = await findClusters(
      store,
      { since, until: now.toISOString(), format: 'skeleton' },
      now,
    );
    expect(JSON.stringify(fc).length).toBeLessThan(10_000);
  });
});
