import { describe, expect, it } from 'vitest';
import {
  findClusters,
  FIND_CLUSTERS_RESPONSE_BYTE_CEILING,
} from '../../src/mcp/tools/find-clusters.js';
import { MemoryStorage } from '../../src/storage/memory.js';
import { normalizeEvent } from '../../src/context-adapters/normalization.js';
import { buildRecentWorkContext } from '../../src/trace/index.js';
import type { CaptureEvent } from '../../src/storage/interface.js';

// V1.6 (item 030) — find_clusters tests.
//
// Acceptance #1 contract for worksets within the trace builder's bounded
// MAX_LIMIT: same inputs → same set of clusters when each cluster is
// identified by the sorted `atom_ids[]` membership, AND ranks match.
// Explicitly NOT comparing against `buildSkeletonResponse` (which clips
// atom_ids[] at 50 — the very thing find_clusters fixes).

const PROJECT_ECHO = '/Users/redacted/Desktop/Project_echo';

function claudeCodeTurn(i: number, filePath: string, ts: string): Omit<CaptureEvent, 'id'> {
  // Mirror the shape claude_code/extractor produces: a USER+ASSISTANT pair
  // bag with a `files_referenced` artifact keying the cluster.
  const rootThreadId = `fixture-root:${filePath}`;
  return {
    source: `fs:/Users/redacted/.claude/projects/-Users-redacted-Desktop-Project-echo/sess-${i}.jsonl`,
    timestamp: ts,
    content: `USER: question ${i}\n\nASSISTANT: working on ${filePath}`,
    metadata: {
      surface: 'claude_code',
      files_referenced: [filePath],
      cwd: PROJECT_ECHO,
      session_id: rootThreadId,
      thread_id: rootThreadId,
      root_thread_id: rootThreadId,
      thread_kind: 'root',
      observation_kind: 'original',
      initiator: 'human',
      turn_index: 0,
    },
  };
}

function gitCommit(i: number, filePath: string, ts: string): Omit<CaptureEvent, 'id'> {
  return {
    source: `git:${PROJECT_ECHO}`,
    timestamp: ts,
    content: `commit ${i}: edit ${filePath}`,
    metadata: {
      surface: 'git',
      files_referenced: [filePath],
      sha: `c0ffee${i.toString().padStart(2, '0')}`,
    },
  };
}

describe('find_clusters', () => {
  it('returns FULL atom_ids per cluster — fails the skeleton-wire 50-cap when cluster size > 50 (the load-bearing fix)', async () => {
    // Build a cluster of >50 atoms by funneling them all through the SAME
    // file artifact within the cluster-gap window. The trace builder will
    // group them into one component; the skeleton-wire 50-cap at the
    // existing rwc tool would clip atom_ids[] at 50 — find_clusters MUST
    // emit the FULL set.
    const store = new MemoryStorage();
    const sharedFile = `${PROJECT_ECHO}/src/big.ts`;
    const N = 75;
    for (let i = 0; i < N; i++) {
      const ts = `2026-05-09T10:${(i % 60).toString().padStart(2, '0')}:${Math.floor(i / 60)
        .toString()
        .padStart(2, '0')}.000Z`;
      await store.append(claudeCodeTurn(i, sharedFile, ts));
    }

    const r = await findClusters(store, {
      since: '2026-05-09T09:00:00.000Z',
      until: '2026-05-09T12:00:00.000Z',
    });

    // One dominant cluster bridging all atoms (same file, same window).
    const bigCluster = r.clusters.find((c) => c.atom_ids.length >= N);
    expect(bigCluster).toBeDefined();
    // Load-bearing: the FULL atom_ids set, not the skeleton-clipped 50.
    expect(bigCluster!.atom_ids.length).toBe(N);
    // No atom_ids_truncated flag — N=75 is below the per-cluster hard cap (200).
    expect(bigCluster!.atom_ids_truncated).toBeUndefined();
  });

  it('graph-membership equality with the un-clipped trace builder (acceptance #1)', async () => {
    // Same fixture. Compare find_clusters output to the trace builder's
    // raw output directly, using sorted atom_ids[] as the cluster
    // identity (NOT cluster_id strings, NOT skeleton-wire shape).
    const store = new MemoryStorage();
    const fileA = `${PROJECT_ECHO}/src/a.ts`;
    const fileB = `${PROJECT_ECHO}/src/b.ts`;
    // Cluster A: 5 claude_code turns + 1 git commit, all on fileA
    for (let i = 0; i < 5; i++) {
      await store.append(
        claudeCodeTurn(100 + i, fileA, `2026-05-09T10:${i.toString().padStart(2, '0')}:00.000Z`),
      );
    }
    await store.append(gitCommit(1, fileA, '2026-05-09T10:30:00.000Z'));
    // Cluster B: 3 claude_code turns on fileB, separate file → separate component
    for (let i = 0; i < 3; i++) {
      await store.append(
        claudeCodeTurn(200 + i, fileB, `2026-05-09T11:${i.toString().padStart(2, '0')}:00.000Z`),
      );
    }

    const since = '2026-05-09T09:00:00.000Z';
    const until = '2026-05-09T12:00:00.000Z';

    // Reference: raw trace builder (no skeleton, no atom-limit clipping).
    const events = await store.query({
      since,
      until,
      limit: 1000,
      exclude_metadata_surface: ['fs'],
    });
    const referenceRwc = buildRecentWorkContext(
      events,
      { since, until, limit: 500, format: 'full' },
      normalizeEvent,
    );

    const r = await findClusters(store, { since, until });

    // Cluster identity = sorted atom_ids set.
    const refIdentities = referenceRwc.clusters.map((c) => ({
      key: [...c.atom_ids].sort().join(','),
      rank: c.rank,
      size: c.atom_ids.length,
    }));
    const ourIdentities = r.clusters.map((c) => ({
      key: [...c.atom_ids].sort().join(','),
      rank: c.rank,
      size: c.atom_ids.length,
    }));

    // Graph-membership: same set of identity keys.
    expect(new Set(ourIdentities.map((c) => c.key))).toEqual(
      new Set(refIdentities.map((c) => c.key)),
    );
    // Ranks of corresponding clusters match (look up by identity key).
    const refByKey = new Map(refIdentities.map((c) => [c.key, c.rank]));
    for (const our of ourIdentities) {
      expect(our.rank).toBe(refByKey.get(our.key));
    }
  });

  it('cost target — < 10k chars envelope on a 24h-lookback, multi-cluster fixture', async () => {
    // Realistic-density: 5 active clusters, ~20 atoms each, across 24h.
    const store = new MemoryStorage();
    const baseHour = 10;
    for (let cluster = 0; cluster < 5; cluster++) {
      const file = `${PROJECT_ECHO}/src/feature_${cluster}.ts`;
      for (let i = 0; i < 20; i++) {
        const minute = i % 60;
        const second = i;
        const ts = `2026-05-09T${(baseHour + cluster).toString().padStart(2, '0')}:${minute
          .toString()
          .padStart(2, '0')}:${(second % 60).toString().padStart(2, '0')}.000Z`;
        await store.append(claudeCodeTurn(cluster * 100 + i, file, ts));
      }
    }

    const r = await findClusters(store, {
      since: '2026-05-09T00:00:00.000Z',
      until: '2026-05-10T00:00:00.000Z',
    });

    // The hard envelope ceiling for find_clusters is 25k; the cost target
    // for typical 24h lookback is < 10k.
    const envelopeBytes = JSON.stringify(r).length;
    expect(envelopeBytes).toBeLessThan(10_000);
    // At least some clusters returned.
    expect(r.clusters.length).toBeGreaterThan(0);
  });

  it('no-args 4h→24h auto-expand: empty-4h fixture returns the older content with [AUTO_EXPAND] warning', async () => {
    // Base content at 6h ago (outside 4h, inside 24h). With no since/until,
    // the 4h pass returns 0 clusters; the 24h retry catches it.
    const now = new Date('2026-05-09T20:00:00.000Z');
    const sixHoursAgo = '2026-05-09T14:00:00.000Z';
    const store = new MemoryStorage();
    await store.append(claudeCodeTurn(1, `${PROJECT_ECHO}/src/x.ts`, sixHoursAgo));
    await store.append(
      claudeCodeTurn(2, `${PROJECT_ECHO}/src/x.ts`, sixHoursAgo.replace('00.000', '30.000')),
    );

    const r = await findClusters(store, {}, now);

    expect(r.clusters.length).toBeGreaterThan(0);
    expect(r.warnings.some((w) => w.includes('[AUTO_EXPAND]'))).toBe(true);
  });

  it('result_caps mirrors the trace builder truncation summary (renamed from `truncation`)', async () => {
    const store = new MemoryStorage();
    const file = `${PROJECT_ECHO}/src/y.ts`;
    for (let i = 0; i < 8; i++) {
      await store.append(
        claudeCodeTurn(i, file, `2026-05-09T10:${i.toString().padStart(2, '0')}:00.000Z`),
      );
    }
    const r = await findClusters(store, {
      since: '2026-05-09T09:00:00.000Z',
      until: '2026-05-09T12:00:00.000Z',
    });
    expect(r.result_caps.clusters_returned).toBe(r.clusters.length);
    expect(r.result_caps.atoms_returned).toBe(
      r.clusters.reduce((s, c) => s + c.atom_ids.length, 0),
    );
    expect(typeof r.result_caps.clusters_total).toBe('number');
    expect(typeof r.result_caps.atoms_total_in_window).toBe('number');
    expect(typeof r.result_caps.truncated).toBe('boolean');
  });

  it('view defaults to rich and view="rich" is byte-identical to the default envelope', async () => {
    const store = new MemoryStorage();
    const file = `${PROJECT_ECHO}/src/rich-parity.ts`;
    for (let i = 0; i < 4; i++) {
      await store.append(
        claudeCodeTurn(i, file, `2026-05-09T10:${i.toString().padStart(2, '0')}:00.000Z`),
      );
    }

    const params = {
      since: '2026-05-09T09:00:00.000Z',
      until: '2026-05-09T12:00:00.000Z',
    };
    const defaultResult = await findClusters(store, params);
    const richResult = await findClusters(store, { ...params, view: 'rich' });

    expect(JSON.stringify(richResult)).toBe(JSON.stringify(defaultResult));
  });

  it('rejects unknown view values with accepted enum members in the message', async () => {
    const store = new MemoryStorage();
    await expect(findClusters(store, { view: 'debug' as never })).rejects.toThrow(
      /compact.*rich|rich.*compact/,
    );
  });

  it('view="compact" emits the compact envelope and cluster shape', async () => {
    const store = new MemoryStorage();
    const file = `${PROJECT_ECHO}/src/compact-shape.ts`;
    for (let i = 0; i < 3; i++) {
      const turn = claudeCodeTurn(i, file, `2026-05-09T10:0${i}:00.000Z`);
      turn.content = `USER: still open?\n\nASSISTANT: maybe?`;
      await store.append(turn);
    }

    const r = await findClusters(store, {
      since: '2026-05-09T09:00:00.000Z',
      until: '2026-05-09T12:00:00.000Z',
      view: 'compact',
    });

    expect(r.query).toMatchObject({ format: 'skeleton', repo_path: null });
    expect(r.result_caps).toMatchObject({ truncated: false });
    expect(r.warnings).toEqual([]);
    expect(r.clusters.length).toBeGreaterThan(0);
    const cluster = r.clusters[0] as unknown as Record<string, unknown>;
    expect(cluster['cluster_id']).toBeDefined();
    expect(cluster['atom_ids']).toBeDefined();
    expect(cluster['source_breakdown']).toBeDefined();
    expect(cluster['time_range']).toBeDefined();
    expect(cluster['open_loop_hints']).toBeDefined();
    expect(cluster['rank']).toBe(1);
    expect(cluster['rank_reason']).toEqual([
      'has_unresolved_open_loop',
      'code_session_anchor',
    ]);
  });

  it('view="compact" preserves open_loop_hints_omitted when hint capping fires', async () => {
    const store = new MemoryStorage();
    const file = `${PROJECT_ECHO}/src/compact-hints.ts`;
    for (let i = 0; i < 35; i++) {
      const turn = claudeCodeTurn(
        i,
        file,
        `2026-05-09T10:${i.toString().padStart(2, '0')}:00.000Z`,
      );
      turn.content = `USER: still confused?\n\nASSISTANT: iteration ${i}`;
      await store.append(turn);
    }

    const r = await findClusters(store, {
      since: '2026-05-09T09:00:00.000Z',
      until: '2026-05-09T12:00:00.000Z',
      view: 'compact',
    });

    const clipped = r.clusters.find((c) => (c.open_loop_hints_omitted ?? 0) > 0);
    expect(clipped).toBeDefined();
    expect(clipped!.open_loop_hints.length).toBe(30);
    expect(clipped!.open_loop_hints_omitted).toBe(5);
  });

  it('does not invent labels from opaque conversation UUIDs', async () => {
    const store = new MemoryStorage();
    const sessionId = '11111111-2222-3333-4444-555555555555';
    for (let i = 0; i < 2; i++) {
      await store.append({
        source: `fs:/Users/redacted/.claude/projects/-Users-redacted-Desktop-Project-echo/${sessionId}.jsonl`,
        timestamp: `2026-05-09T10:0${i}:00.000Z`,
        content: `USER: question ${i}\n\nASSISTANT: answer ${i}`,
        metadata: {
          session_id: sessionId,
          turn_index: i,
        },
      });
    }
    const params = {
      since: '2026-05-09T09:00:00.000Z',
      until: '2026-05-09T12:00:00.000Z',
    };

    const rich = await findClusters(store, { ...params, view: 'rich' });
    const compact = await findClusters(store, { ...params, view: 'compact' });

    expect(rich.clusters[0]!.label).toBeUndefined();
    expect((compact.clusters[0] as unknown as Record<string, unknown>)['label']).toBeUndefined();
  });

  it('per-cluster atom_ids hard cap fires only when cluster size exceeds PER_CLUSTER_ATOM_IDS_HARD_CAP (safety net, not routine)', async () => {
    const store = new MemoryStorage();
    const sharedFile = `${PROJECT_ECHO}/src/giant.ts`;
    // Build a cluster of >200 atoms (above PER_CLUSTER_ATOM_IDS_HARD_CAP).
    const N = 250;
    for (let i = 0; i < N; i++) {
      // Distribute across an hour to stay within cluster-gap
      const totalSeconds = i * 14;
      const minute = Math.floor(totalSeconds / 60);
      const second = totalSeconds % 60;
      const ts = `2026-05-09T10:${minute
        .toString()
        .padStart(2, '0')}:${second.toString().padStart(2, '0')}.000Z`;
      await store.append(claudeCodeTurn(i, sharedFile, ts));
    }

    const r = await findClusters(store, {
      since: '2026-05-09T09:00:00.000Z',
      until: '2026-05-09T12:00:00.000Z',
    });

    const giant = r.clusters.find((c) => c.atom_ids_truncated === true);
    expect(giant).toBeDefined();
    expect(giant!.atom_ids_total).toBe(N);
    // Cap engaged but kept head + tail.
    expect(giant!.atom_ids.length).toBe(200);
  });

  it('REGRESSION (post-build review): per-cluster atom_ids cap firing lifts result_caps.truncated to true', async () => {
    // Codex flagged: previously result_caps.truncated only mirrored the
    // upstream rwc.truncation.truncated, so a per-cluster atom_ids hard
    // cap firing produced atom_ids_truncated:true on the cluster but
    // result_caps.truncated:false — consumers checking the top-level
    // signal couldn't detect the partial coverage.
    const store = new MemoryStorage();
    const sharedFile = `${PROJECT_ECHO}/src/giant-truncation.ts`;
    const N = 250; // > PER_CLUSTER_ATOM_IDS_HARD_CAP (200)
    for (let i = 0; i < N; i++) {
      const totalSeconds = i * 14;
      const minute = Math.floor(totalSeconds / 60);
      const second = totalSeconds % 60;
      const ts = `2026-05-09T10:${minute
        .toString()
        .padStart(2, '0')}:${second.toString().padStart(2, '0')}.000Z`;
      await store.append(claudeCodeTurn(i, sharedFile, ts));
    }

    const r = await findClusters(store, {
      since: '2026-05-09T09:00:00.000Z',
      until: '2026-05-09T12:00:00.000Z',
    });

    // Per-cluster cap fired AND that gets surfaced at result_caps.truncated.
    expect(r.clusters.some((c) => c.atom_ids_truncated === true)).toBe(true);
    expect(r.result_caps.truncated).toBe(true);
  });

  it('keeps >500-atom cluster summaries and hints truthful to bounded retained membership', async () => {
    const store = new MemoryStorage();
    const sharedFile = `${PROJECT_ECHO}/src/over-trace-limit.ts`;
    const startMs = Date.parse('2026-05-09T10:00:00.000Z');
    const N = 510;
    for (let i = 0; i < N; i++) {
      const timestamp = new Date(startMs + i * 5_000).toISOString();
      const turn = claudeCodeTurn(i, sharedFile, timestamp);
      turn.content = `USER: we will follow up later on iteration ${i}\n\nASSISTANT: noted`;
      await store.append(turn);
    }

    const r = await findClusters(store, {
      since: '2026-05-09T09:00:00.000Z',
      until: '2026-05-09T12:00:00.000Z',
    });
    const cluster = r.clusters.find(
      (candidate) => candidate.atom_ids_truncated === true,
    );
    if (cluster === undefined) throw new Error('expected bounded giant cluster');

    // The trace builder retained the newest MAX_LIMIT=500 atoms, then the
    // bodyless response applied its independently signalled ID slice.
    expect(r.result_caps.atoms_total_in_window).toBe(N);
    expect(r.result_caps.truncated).toBe(true);
    expect(cluster.atom_ids_total).toBe(500);
    expect(cluster.source_breakdown).toEqual({ claude_code: 500 });
    expect(cluster.time_range).toEqual({
      from: new Date(startMs + 10 * 5_000).toISOString(),
      to: new Date(startMs + (N - 1) * 5_000).toISOString(),
    });

    const visibleIds = new Set(cluster.atom_ids);
    expect(cluster.open_loop_hints.length).toBeGreaterThan(0);
    for (const hint of cluster.open_loop_hints) {
      expect(visibleIds.has(hint.atom_id)).toBe(true);
    }
    expect(cluster.open_loop_hints_omitted).toBeGreaterThan(0);
  });

  it('REGRESSION (post-build review): response-level envelope ceiling actually enforced — trailing clusters trimmed when total exceeds 25k', async () => {
    // Cursor + Codex flagged: FIND_CLUSTERS_RESPONSE_BYTE_CEILING was
    // declared but never applied. Build many clusters with high
    // open-loop-hint density (each "?" turn contributes a hint) so the
    // un-trimmed envelope exceeds 25k. (Pure atom_ids inflation can't
    // cross 25k under MAX_LIMIT=500 + per-cluster-cap=200 — but
    // realistic question-heavy sessions across many files do.)
    const store = new MemoryStorage();
    const CLUSTERS = 10;
    const ATOMS_PER_CLUSTER = 60;
    for (let cluster = 0; cluster < CLUSTERS; cluster++) {
      const file = `${PROJECT_ECHO}/src/qheavy_${cluster}.ts`;
      const hour = 10 + cluster;
      for (let i = 0; i < ATOMS_PER_CLUSTER; i++) {
        const totalSeconds = i * 14;
        const minute = Math.floor(totalSeconds / 60);
        const second = totalSeconds % 60;
        const ts = `2026-05-09T${hour.toString().padStart(2, '0')}:${minute
          .toString()
          .padStart(2, '0')}:${second.toString().padStart(2, '0')}.000Z`;
        const t = claudeCodeTurn(cluster * 1000 + i, file, ts);
        // Question-ending content → triggers open_loop_hints, which
        // (unlike atom_ids) can grow per cluster up to the hint cap.
        t.content = `USER: still confused about ${file}?\n\nASSISTANT: not sure either, what about iteration ${i}?`;
        await store.append(t);
      }
    }

    const r = await findClusters(store, {
      since: '2026-05-09T00:00:00.000Z',
      until: '2026-05-10T00:00:00.000Z',
    });

    // Hard ceiling actually enforced.
    const envelopeBytes = JSON.stringify(r).length;
    expect(envelopeBytes).toBeLessThanOrEqual(FIND_CLUSTERS_RESPONSE_BYTE_CEILING);
    // Preserve the cluster headers and shrink membership before dropping a
    // sibling. (The upstream 500-atom work budget may already omit one.)
    expect(r.clusters.length).toBe(r.result_caps.clusters_returned);
    expect(r.clusters.length).toBeGreaterThanOrEqual(CLUSTERS - 1);
    expect(r.clusters.every((cluster) => cluster.atom_ids.length <= 50)).toBe(true);
    // The signal is surfaced at result_caps.truncated.
    expect(r.result_caps.truncated).toBe(true);
    // Warning surfaced so the consumer knows what happened.
    expect(r.warnings.some((w) => w.includes('[FIND_CLUSTERS_ID_BUDGET]'))).toBe(true);
  });

  it('view="compact" sizes the response cap after compact projection', async () => {
    const store = new MemoryStorage();
    const CLUSTERS = 10;
    const ATOMS_PER_CLUSTER = 60;
    for (let cluster = 0; cluster < CLUSTERS; cluster++) {
      const file = `${PROJECT_ECHO}/src/compact_budget_${cluster}.ts`;
      const hour = 10 + cluster;
      for (let i = 0; i < ATOMS_PER_CLUSTER; i++) {
        const totalSeconds = i * 14;
        const minute = Math.floor(totalSeconds / 60);
        const second = totalSeconds % 60;
        const ts = `2026-05-09T${hour.toString().padStart(2, '0')}:${minute
          .toString()
          .padStart(2, '0')}:${second.toString().padStart(2, '0')}.000Z`;
        const t = claudeCodeTurn(cluster * 1000 + i, file, ts);
        t.content = `USER: still confused about ${file}?\n\nASSISTANT: what about iteration ${i}?`;
        await store.append(t);
      }
    }

    const params = {
      since: '2026-05-09T00:00:00.000Z',
      until: '2026-05-10T00:00:00.000Z',
    };
    const rich = await findClusters(store, params);
    const compact = await findClusters(store, { ...params, view: 'compact' });

    expect(JSON.stringify(compact).length).toBeLessThanOrEqual(FIND_CLUSTERS_RESPONSE_BYTE_CEILING);
    expect(compact.clusters.length).toBeGreaterThanOrEqual(rich.clusters.length);
  });

  // V1.6 (item 032) AC4 — integration test: 24h-spanning fixture where 4h
  // has ONLY single-source-recent noise (calling session, 2 atoms last 5min)
  // and prior 4-24h has a multi-source work session (claude_code + git + codex,
  // 30+ min old). No-args find_clusters() must auto-expand with
  // [AUTO_EXPAND] single-source-recent, demote noise, and surface prior
  // work as clusters[0].
  it('no-args 4h→24h auto-expand: single-source-recent trigger demotes noise, prior multi-source work surfaces at clusters[0]', async () => {
    const now = new Date('2026-05-10T20:00:00.000Z');
    const NOW_MS = now.getTime();
    const store = new MemoryStorage();

    // Single-source noise: 2 claude_code atoms within the last 5 minutes.
    const noiseTs1 = new Date(NOW_MS - 2 * 60_000).toISOString();
    const noiseTs2 = new Date(NOW_MS - 1 * 60_000).toISOString();
    await store.append(claudeCodeTurn(900, `${PROJECT_ECHO}/src/active.ts`, noiseTs1));
    await store.append(claudeCodeTurn(901, `${PROJECT_ECHO}/src/active.ts`, noiseTs2));

    // Prior multi-source work session (~6h ago — outside 4h, inside 24h).
    // claude_code + git + codex on a shared file → multi-source cluster.
    const workTs = '2026-05-10T14:00:00.000Z';
    const workFile = `${PROJECT_ECHO}/src/feature.ts`;
    await store.append(claudeCodeTurn(800, workFile, workTs));
    await store.append({
      source: `git:${PROJECT_ECHO}`,
      timestamp: '2026-05-10T14:05:00.000Z',
      content: `commit deadbeef: edit ${workFile}`,
      metadata: {
        surface: 'git',
        files_referenced: [workFile],
        sha: 'deadbeef00',
      },
    });
    await store.append({
      source: `fs:/Users/redacted/.codex/sessions/sess-x.jsonl`,
      timestamp: '2026-05-10T14:10:00.000Z',
      content: `USER: where did we leave off on ${workFile}?\n\nASSISTANT: working on it`,
      metadata: {
        surface: 'codex',
        files_referenced: [workFile],
        cwd: PROJECT_ECHO,
        session_id: 'sess-x',
        turn_index: 0,
      },
    });

    const r = await findClusters(store, {}, now);

    // Auto-expand fired with the single-source-recent trigger.
    expect(
      r.warnings.some((w) => w.includes('[AUTO_EXPAND]') && w.includes('single-source-recent')),
    ).toBe(true);

    // clusters[0] is the prior multi-source work — NOT the noise cluster.
    expect(r.clusters.length).toBeGreaterThan(0);
    const top = r.clusters[0]!;
    const topSources = Object.keys(top.source_breakdown);
    expect(topSources.length).toBeGreaterThan(1);

    // Noise cluster is still present, ranked below the work cluster.
    const noise = r.clusters.find(
      (c) => Object.keys(c.source_breakdown).length === 1 && c.source_breakdown.claude_code === 2,
    );
    expect(noise).toBeDefined();
    expect(noise!.rank).toBeGreaterThan(top.rank);

    // Round-trip into get_atoms with prefer='newest_first': the newest
    // atom of the prior work cluster (the codex turn at 14:10) should
    // be in the returned atoms[], not dropped.
    const { getAtoms } = await import('../../src/mcp/tools/get-atoms.js');
    const atomsResp = await getAtoms(store, {
      atom_ids: top.atom_ids,
      prefer: 'newest_first',
    });
    expect(atomsResp.atoms.length).toBeGreaterThan(0);
    // Confirm the newest atom (latest timestamp) made it into atoms[]
    // — that is the resume-call contract.
    const newestTimestamp = atomsResp.atoms[0]!.timestamp;
    expect(newestTimestamp).toBe('2026-05-10T14:10:00.000Z');
  });

  it('no-args auto-expand warning carries the explicit trigger label (empty vs single-source-recent)', async () => {
    // Empty-trigger path: nothing in 4h, prior content in 24h.
    const now = new Date('2026-05-09T20:00:00.000Z');
    const sixHoursAgo = '2026-05-09T14:00:00.000Z';
    const store = new MemoryStorage();
    await store.append(claudeCodeTurn(1, `${PROJECT_ECHO}/src/x.ts`, sixHoursAgo));

    const r = await findClusters(store, {}, now);
    expect(r.warnings.some((w) => w.includes('[AUTO_EXPAND]') && w.includes('empty'))).toBe(true);
    // The empty-trigger path does NOT carry the single-source-recent label.
    expect(
      r.warnings.some((w) => w.includes('[AUTO_EXPAND]') && w.includes('single-source-recent')),
    ).toBe(false);
  });

  // Item 037 / AC4 — repo_path scoping.
  it('AC4: repo_path passes through to recent_work_context and scopes the candidate set', async () => {
    const store = new MemoryStorage();
    const targetRepo = '/Users/x/Desktop/Project_echo';
    const otherRepo = '/Users/x/Desktop/Other';
    const targetFile = `${targetRepo}/src/a.ts`;
    const otherFile = `${otherRepo}/src/b.ts`;
    // 3 turns in target repo (one cluster), 3 in other repo.
    for (let i = 0; i < 3; i++) {
      const ts = `2026-05-09T10:${(i * 5).toString().padStart(2, '0')}:00.000Z`;
      await store.append({
        source: `fs:/Users/redacted/.claude/projects/-Users-x-Desktop-Project-echo/sess-${i}.jsonl`,
        timestamp: ts,
        content: `USER: q${i}\n\nASSISTANT: a${i}`,
        metadata: {
          surface: 'claude_code',
          repo_root: targetRepo,
          files_referenced: [targetFile],
          cwd: targetRepo,
          session_id: `sess-${i}`,
        },
      });
      await store.append({
        source: `fs:/Users/redacted/.claude/projects/-Users-x-Desktop-Other/sess-${i + 100}.jsonl`,
        timestamp: ts,
        content: `USER: q${i}\n\nASSISTANT: a${i}`,
        metadata: {
          surface: 'claude_code',
          repo_root: otherRepo,
          files_referenced: [otherFile],
          cwd: otherRepo,
          session_id: `sess-${i + 100}`,
        },
      });
    }
    const r = await findClusters(store, {
      since: '2026-05-09T09:00:00.000Z',
      until: '2026-05-09T12:00:00.000Z',
      repo_path: targetRepo,
    });
    expect(r.query.repo_path).toBe(targetRepo);
    // No cluster should reference the other repo's atoms.
    const allAtomIds = r.clusters.flatMap((c) => c.atom_ids);
    const matching = await store.getByIds(allAtomIds);
    expect(matching.length).toBeGreaterThan(0);
    for (const a of matching) {
      expect(a.metadata?.['repo_root']).toBe(targetRepo);
    }
  });

  it('AC4: query.repo_path is null in baseline (no repo_path passed)', async () => {
    const store = new MemoryStorage();
    const r = await findClusters(store, {
      since: '2026-05-09T09:00:00.000Z',
      until: '2026-05-09T12:00:00.000Z',
    });
    expect(r.query.repo_path).toBeNull();
  });

  it('AC4: trailing-slash repo_path normalises to no-slash form', async () => {
    const store = new MemoryStorage();
    const targetRepo = '/Users/x/Project_echo';
    for (let i = 0; i < 2; i++) {
      const ts = `2026-05-09T10:${(i * 5).toString().padStart(2, '0')}:00.000Z`;
      await store.append({
        source: `fs:/Users/redacted/.claude/projects/sess-${i}.jsonl`,
        timestamp: ts,
        content: `USER: q${i}\n\nASSISTANT: a${i}`,
        metadata: {
          surface: 'claude_code',
          repo_root: targetRepo,
          files_referenced: [`${targetRepo}/a.ts`],
          cwd: targetRepo,
          session_id: `sess-${i}`,
        },
      });
    }
    const r = await findClusters(store, {
      since: '2026-05-09T09:00:00.000Z',
      until: '2026-05-09T12:00:00.000Z',
      repo_path: `${targetRepo}/`,
    });
    expect(r.query.repo_path).toBe(targetRepo);
    expect(r.clusters.length).toBeGreaterThan(0);
  });

  it('open_loop_hints stays capped at SKELETON_CLUSTER_OPEN_LOOP_HINTS_CAP (50-cap reused)', async () => {
    // Synthesize many open-loop hints by using "?" turn endings (the
    // ends_with_question hint trigger). Cluster size doesn't have to
    // exceed the per-cluster cap to test hint capping.
    const store = new MemoryStorage();
    const file = `${PROJECT_ECHO}/src/q.ts`;
    for (let i = 0; i < 60; i++) {
      // 60 question-ending turns → 60 raw open-loop hints
      const ts = `2026-05-09T10:${i.toString().padStart(2, '0')}:00.000Z`;
      const turn = claudeCodeTurn(i, file, ts);
      turn.content = `USER: still confused?\n\nASSISTANT: not sure either, what do you think?`;
      await store.append(turn);
    }
    const r = await findClusters(store, {
      since: '2026-05-09T09:00:00.000Z',
      until: '2026-05-09T12:00:00.000Z',
    });
    // At least one cluster has the hints clipped down at the 30-cap (the
    // existing SKELETON_CLUSTER_OPEN_LOOP_HINTS_CAP).
    const clipped = r.clusters.find((c) => (c.open_loop_hints_omitted ?? 0) > 0);
    expect(clipped).toBeDefined();
    expect(clipped!.open_loop_hints.length).toBeLessThanOrEqual(30);
  });
});

// Item 038 / AC3 regression test: find_clusters{repo_path} must still scope
// the candidate set to atoms with matching metadata.repo_root after the
// cluster engine moved to internal/. Mirrors the post-037 contract verbatim.
describe('Item 038 / AC3 — find_clusters({repo_path}) inherits 037 forwarding', () => {
  it('cross-source scopes by metadata.repo_root through the new internal engine', async () => {
    const store = new MemoryStorage();
    const repoA = PROJECT_ECHO;
    const repoB = '/Users/redacted/Desktop/Other_repo';
    // Three atoms in repoA + two atoms in repoB, all in the cluster window.
    for (let i = 0; i < 3; i++) {
      const ts = `2026-05-09T10:0${i}:00.000Z`;
      const ev = claudeCodeTurn(i, `${repoA}/src/x.ts`, ts);
      (ev.metadata as Record<string, unknown>)['repo_root'] = repoA;
      await store.append(ev);
    }
    for (let i = 0; i < 2; i++) {
      const ts = `2026-05-09T10:1${i}:00.000Z`;
      const ev = claudeCodeTurn(100 + i, `${repoB}/src/y.ts`, ts);
      (ev.metadata as Record<string, unknown>)['repo_root'] = repoB;
      // Adjust source so the find_clusters trace input picks both as cc atoms.
      ev.source = `fs:/Users/redacted/.claude/projects/-Users-redacted-Desktop-Other-repo/sess-${100 + i}.jsonl`;
      await store.append(ev);
    }

    const rA = await findClusters(store, {
      since: '2026-05-09T09:00:00.000Z',
      until: '2026-05-09T12:00:00.000Z',
      repo_path: repoA,
    });
    expect(rA.query.repo_path).toBe(repoA);
    const allAtomIdsA = rA.clusters.flatMap((c) => c.atom_ids);
    // RepoB atoms must not appear in the repo_path=repoA cluster set.
    // Build the inclusion check by checking that none of the repoB atom
    // signatures (sourced from .claude/projects/-Users-redacted-Desktop-Other-repo)
    // surface — we sanity-check that the atoms_returned count is bounded
    // by the repoA fixture size.
    expect(rA.result_caps.atoms_returned).toBeGreaterThan(0);
    expect(rA.result_caps.atoms_returned).toBeLessThanOrEqual(3);
    expect(allAtomIdsA.length).toBeLessThanOrEqual(3);
  });
});
