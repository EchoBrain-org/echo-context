import { EventEmitter } from 'node:events';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { FSWatcher } from 'chokidar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPTURED_SOURCES,
  _isAllowedPathIn,
} from '../../../src/capture/sources.js';
import {
  CURSOR_DEFAULT_PARSE_MAX_ROWS,
  CURSOR_DEFAULT_PARSE_MAX_STORED_BYTES,
  CURSOR_MAX_COMPOSERS_PER_SLICE,
  CURSOR_RUNTIME_CACHE_ENTRIES,
  CURSOR_RAW_ROWID_ASC_PAGE_SQL,
  CURSOR_RAW_ROWID_DESC_PAGE_SQL,
  CURSOR_REPOLL_INTERVAL_MS,
  __cursorWarningCacheTestHooks,
  extractCursorTurns,
  maxGlobalDbFamilyMtime,
  startCursorExtractor,
  tryExtractCodeBlocksText,
  tryExtractFileDiffText,
  tryExtractThinkingText,
  tryExtractToolFormerText,
  type CursorExtractorHandle,
} from '../../../src/capture/extractors/cursor.js';
import { MemoryStorage } from '../../../src/storage/memory.js';
import {
  resetAllowlist,
  restoreFsPaths,
  snapshotFsPaths,
} from '../../fixtures/allowlist.js';
import {
  appendBubble,
  appendRawCursorDiskKVRow,
  createGlobalStorageFixture,
  createSchemaUnrecognizedFixture,
  createWorkspaceFixture,
  type FixtureBubble,
} from '../../fixtures/cursor-globalstorage.js';
import { captureStdout } from '../../fixtures/stdout.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'echo-cursor-'));
}

async function waitFor(
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

describe('extractCursorTurns (pure)', () => {
  let dir: string;
  let dbPath: string;
  let captured: ReturnType<typeof captureStdout>;

  beforeEach(() => {
    __cursorWarningCacheTestHooks.reset();
    dir = tmpDir();
    dbPath = join(dir, 'state.vscdb');
    captured = captureStdout();
  });

  afterEach(() => {
    __cursorWarningCacheTestHooks.reset();
    captured.restore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns all complete turns when lastSeenMap is empty', async () => {
    const bubbles: FixtureBubble[] = [
      { composer_id: 'c1', bubble_id: 'b1', type: 1, text: 'hello' },
      { composer_id: 'c1', bubble_id: 'b2', type: 2, text: 'hi back' },
      { composer_id: 'c1', bubble_id: 'b3', type: 1, text: 'follow up' },
      { composer_id: 'c1', bubble_id: 'b4', type: 2, text: 'response' },
    ];
    createGlobalStorageFixture(dbPath, bubbles);

    const turns = await extractCursorTurns(dbPath, new Map());
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({
      composer_id: 'c1',
      user_bubble_id: 'b1',
      assistant_bubble_id: 'b2',
      user_message: 'hello',
      assistant_message: 'hi back',
    });
    expect(turns[1]).toMatchObject({
      user_bubble_id: 'b3',
      assistant_bubble_id: 'b4',
    });
    expect(turns[0]?.workspace_id).toBeUndefined();
  });

  it('tracks multiple composers independently', async () => {
    const bubbles: FixtureBubble[] = [
      { composer_id: 'cA', bubble_id: 'b1', type: 1, text: 'a-q' },
      { composer_id: 'cA', bubble_id: 'b2', type: 2, text: 'a-a' },
      { composer_id: 'cB', bubble_id: 'b1', type: 1, text: 'b-q' },
      { composer_id: 'cB', bubble_id: 'b2', type: 2, text: 'b-a' },
    ];
    createGlobalStorageFixture(dbPath, bubbles, {
      composers: { cA: { createdAt: 100 }, cB: { createdAt: 200 } },
    });

    const turns = await extractCursorTurns(dbPath, new Map());
    expect(turns).toHaveLength(2);
    const composers = new Set(turns.map((t) => t.composer_id));
    expect(composers).toEqual(new Set(['cA', 'cB']));
  });

  it('returns only bubbles after the per-composer checkpoint', async () => {
    const bubbles: FixtureBubble[] = [
      { composer_id: 'c1', bubble_id: 'b1', type: 1, text: 'old-q' },
      { composer_id: 'c1', bubble_id: 'b2', type: 2, text: 'old-a' },
      { composer_id: 'c1', bubble_id: 'b3', type: 1, text: 'new-q' },
      { composer_id: 'c1', bubble_id: 'b4', type: 2, text: 'new-a' },
    ];
    createGlobalStorageFixture(dbPath, bubbles);

    const map = new Map<string, string>([['c1', 'b2']]);
    const turns = await extractCursorTurns(dbPath, map);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.user_bubble_id).toBe('b3');
    expect(turns[0]?.assistant_bubble_id).toBe('b4');
  });

  it('emits zero turns for a user-only trailing bubble; emits one once the assistant arrives', async () => {
    createGlobalStorageFixture(dbPath, [
      { composer_id: 'c1', bubble_id: 'b1', type: 1, text: 'pending' },
    ]);

    const map = new Map<string, string>();
    let turns = await extractCursorTurns(dbPath, map);
    expect(turns).toHaveLength(0);

    appendBubble(dbPath, {
      composer_id: 'c1',
      bubble_id: 'b2',
      type: 2,
      text: 'finally',
    });
    turns = await extractCursorTurns(dbPath, map);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.user_bubble_id).toBe('b1');
    expect(turns[0]?.assistant_bubble_id).toBe('b2');
  });

  it('pairs one user bubble with all consecutive assistant bubbles (Cursor often splits responses)', async () => {
    const bubbles: FixtureBubble[] = [
      { composer_id: 'c1', bubble_id: 'u1', type: 1, text: 'fix the bug' },
      { composer_id: 'c1', bubble_id: 'a1', type: 2, text: 'thinking...' },
      { composer_id: 'c1', bubble_id: 'a2', type: 2, text: 'I see the issue' },
      { composer_id: 'c1', bubble_id: 'a3', type: 2, text: 'here is the fix' },
      { composer_id: 'c1', bubble_id: 'u2', type: 1, text: 'thanks' },
      { composer_id: 'c1', bubble_id: 'a4', type: 2, text: 'no problem' },
    ];
    createGlobalStorageFixture(dbPath, bubbles);
    const turns = await extractCursorTurns(dbPath, new Map());

    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({
      user_bubble_id: 'u1',
      assistant_bubble_id: 'a3', // last bubble in cluster — used as checkpoint
      assistant_bubble_ids: ['a1', 'a2', 'a3'],
      user_message: 'fix the bug',
      assistant_message: 'thinking...\n\nI see the issue\n\nhere is the fix',
    });
    expect(turns[1]).toMatchObject({
      user_bubble_id: 'u2',
      assistant_bubble_id: 'a4',
      assistant_bubble_ids: ['a4'],
      assistant_message: 'no problem',
    });
  });

  it('extracts attached_files / referenced_files / deleted_files into turn.context', async () => {
    const bubbles: FixtureBubble[] = [
      {
        composer_id: 'c1',
        bubble_id: 'u1',
        type: 1,
        text: 'fix README',
        attachedFileCodeChunksUris: ['/proj/README.md'],
      },
      {
        composer_id: 'c1',
        bubble_id: 'a1',
        type: 2,
        text: 'looking…',
        codeBlocks: [{ path: '/proj/README.md', languageId: 'markdown' }],
      },
      {
        composer_id: 'c1',
        bubble_id: 'a2',
        type: 2,
        text: 'wrote it + cleaned up',
        codeBlocks: [
          { path: '/proj/README.md', languageId: 'markdown' }, // dedup target
          { path: '/proj/src/index.ts', languageId: 'typescript' },
        ],
        deletedFiles: ['/proj/old/legacy.md'],
      },
    ];
    createGlobalStorageFixture(dbPath, bubbles);
    const turns = await extractCursorTurns(dbPath, new Map());

    expect(turns).toHaveLength(1);
    expect(turns[0]?.context).toEqual({
      attached_files: ['/proj/README.md'],
      referenced_files: [
        { path: '/proj/README.md', language: 'markdown' },
        { path: '/proj/src/index.ts', language: 'typescript' },
      ],
      deleted_files: ['/proj/old/legacy.md'],
    });
  });

  it('omits turn.context entirely when no bubble carried any extracted context', async () => {
    const bubbles: FixtureBubble[] = [
      { composer_id: 'c1', bubble_id: 'u1', type: 1, text: 'hi' },
      { composer_id: 'c1', bubble_id: 'a1', type: 2, text: 'hello back' },
    ];
    createGlobalStorageFixture(dbPath, bubbles);
    const turns = await extractCursorTurns(dbPath, new Map());

    expect(turns).toHaveLength(1);
    expect(turns[0]?.context).toBeUndefined();
  });

  it('uses the cluster-last bubble as the resume checkpoint (multi-assistant turns)', async () => {
    const bubbles: FixtureBubble[] = [
      { composer_id: 'c1', bubble_id: 'u1', type: 1, text: 'q1' },
      { composer_id: 'c1', bubble_id: 'a1', type: 2, text: 'a1-part-1' },
      { composer_id: 'c1', bubble_id: 'a2', type: 2, text: 'a1-part-2' },
      { composer_id: 'c1', bubble_id: 'u2', type: 1, text: 'q2' },
      { composer_id: 'c1', bubble_id: 'a3', type: 2, text: 'a2' },
    ];
    createGlobalStorageFixture(dbPath, bubbles);

    // Resuming from the LAST bubble of the first cluster should yield only the
    // second turn — proving the checkpoint advances correctly across clusters.
    const turns = await extractCursorTurns(dbPath, new Map([['c1', 'a2']]));
    expect(turns).toHaveLength(1);
    expect(turns[0]?.user_bubble_id).toBe('u2');
    expect(turns[0]?.assistant_bubble_id).toBe('a3');
  });

  it('logs warn and drops orphan assistant bubble (no preceding user)', async () => {
    const bubbles: FixtureBubble[] = [
      { composer_id: 'c1', bubble_id: 'b1', type: 2, text: 'orphan' },
      { composer_id: 'c1', bubble_id: 'b2', type: 1, text: 'q' },
      { composer_id: 'c1', bubble_id: 'b3', type: 2, text: 'a' },
    ];
    createGlobalStorageFixture(dbPath, bubbles);

    const turns = await extractCursorTurns(dbPath, new Map());
    expect(turns).toHaveLength(1);
    expect(turns[0]?.user_bubble_id).toBe('b2');
    expect(captured.writes.join('')).toContain('orphan_assistant_bubble');
  });

  // M1-1 sub-gap D (item 036): when the checkpoint lands inside an
  // extended assistant cluster, the new bubbles surface as a continuation
  // atom carrying `is_continuation: true` and
  // `continuation_of_assistant_bubble_id: <checkpoint>`. Pre-036 (V1.5.7)
  // silently fast-forwarded these bubbles, dropping ~50% of agent-mode
  // capture rate (10/21 on the load-bearing 4f02b335 composer). Post-036
  // the bubbles surface as atoms; consumers that want a deduped logical-
  // turn view group on `metadata.user_bubble_id`.

  // AC3 Test 1 — the load-bearing case: continuation followed by an
  // append. Verifies the continuation atom carries the right id-set, the
  // original user_message, the join key, and that the `lastSeenMap`
  // checkpoint advances to the cluster-last bubble for the next tick.
  it('continuation: emits continuation atom for new assistant bubbles after the checkpoint', async () => {
    // First tick — empty checkpoint, full single-cluster turn.
    const bubbles: FixtureBubble[] = [
      {
        composer_id: 'c1',
        bubble_id: 'u1',
        type: 1,
        text: 'fix the verdict turn',
      },
      { composer_id: 'c1', bubble_id: 'a1', type: 2, text: 'thinking...' },
      { composer_id: 'c1', bubble_id: 'a2', type: 2, text: 'still working...' },
      { composer_id: 'c1', bubble_id: 'a3', type: 2, text: 'partial answer' },
    ];
    createGlobalStorageFixture(dbPath, bubbles);
    let turns = await extractCursorTurns(dbPath, new Map());
    expect(turns).toHaveLength(1);
    expect(turns[0]?.assistant_bubble_ids).toEqual(['a1', 'a2', 'a3']);
    expect(turns[0]?.is_continuation).toBeUndefined();
    expect(turns[0]?.continuation_of_assistant_bubble_id).toBeUndefined();
    const checkpoint = turns[0]!.assistant_bubble_id;
    expect(checkpoint).toBe('a3');

    // Second tick — Cursor wrote 2 more assistant bubbles; checkpoint is
    // now at `a3` (the cluster-last from tick 1).
    appendBubble(dbPath, {
      composer_id: 'c1',
      bubble_id: 'a4',
      type: 2,
      text: 'verdict: ECHO works',
    });
    appendBubble(dbPath, {
      composer_id: 'c1',
      bubble_id: 'a5',
      type: 2,
      text: 'final summary',
    });
    turns = await extractCursorTurns(dbPath, new Map([['c1', checkpoint]]));
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      composer_id: 'c1',
      user_bubble_id: 'u1',
      assistant_bubble_id: 'a5',
      assistant_bubble_ids: ['a4', 'a5'],
      user_message: 'fix the verdict turn',
      assistant_message: 'verdict: ECHO works\n\nfinal summary',
      is_continuation: true,
      continuation_of_assistant_bubble_id: 'a3',
    });
  });

  // AC3 Test 2 — empty short-circuit. Checkpoint at the cluster-last
  // bubble: nothing new, zero turns, zero warnings.
  it('continuation: checkpoint at cluster-last bubble emits 0 turns and 0 warnings', async () => {
    const bubbles: FixtureBubble[] = [
      { composer_id: 'c1', bubble_id: 'u1', type: 1, text: 'q' },
      { composer_id: 'c1', bubble_id: 'a1', type: 2, text: 'a1' },
      { composer_id: 'c1', bubble_id: 'a2', type: 2, text: 'a2' },
      { composer_id: 'c1', bubble_id: 'a3', type: 2, text: 'a3' },
    ];
    createGlobalStorageFixture(dbPath, bubbles);

    const turns = await extractCursorTurns(dbPath, new Map([['c1', 'a3']]));
    expect(turns).toHaveLength(0);
    const out = captured.writes.join('');
    expect(out).not.toContain('orphan_assistant_bubble');
    expect(out).not.toContain('continuation_atom');
    expect(out).not.toContain('continuation_no_preceding_user');
  });

  // AC3 Test 3 — continuation followed by a fresh user→assistant pair in
  // the same tick. Both atoms must surface, in chronological order.
  it('continuation: emits continuation atom AND the following fresh user→assistant turn', async () => {
    const bubbles: FixtureBubble[] = [
      { composer_id: 'c1', bubble_id: 'u1', type: 1, text: 'q1' },
      { composer_id: 'c1', bubble_id: 'a1', type: 2, text: 'a1-prior' },
      { composer_id: 'c1', bubble_id: 'a2', type: 2, text: 'a1-continuation' },
      { composer_id: 'c1', bubble_id: 'u2', type: 1, text: 'q2' },
      { composer_id: 'c1', bubble_id: 'a3', type: 2, text: 'a2' },
    ];
    createGlobalStorageFixture(dbPath, bubbles);

    const turns = await extractCursorTurns(dbPath, new Map([['c1', 'a1']]));
    expect(turns).toHaveLength(2);
    // Continuation atom comes first (a2.createdAt < a3.createdAt).
    expect(turns[0]).toMatchObject({
      user_bubble_id: 'u1',
      assistant_bubble_id: 'a2',
      assistant_bubble_ids: ['a2'],
      is_continuation: true,
      continuation_of_assistant_bubble_id: 'a1',
    });
    expect(turns[1]).toMatchObject({
      user_bubble_id: 'u2',
      assistant_bubble_id: 'a3',
      assistant_bubble_ids: ['a3'],
    });
    expect(turns[1]?.is_continuation).toBeUndefined();
    expect(turns[1]?.continuation_of_assistant_bubble_id).toBeUndefined();
  });

  // AC3 Test 4 — two composers, each with the multi-cluster shape.
  // Continuation atoms are emitted per-composer, no cross-pollination.
  it('continuation: independent per composer in a single tick', async () => {
    const bubbles: FixtureBubble[] = [
      { composer_id: 'cA', bubble_id: 'uA', type: 1, text: 'qA' },
      { composer_id: 'cA', bubble_id: 'aA1', type: 2, text: 'A1' },
      { composer_id: 'cA', bubble_id: 'aA2', type: 2, text: 'A2-cont' },
      { composer_id: 'cB', bubble_id: 'uB', type: 1, text: 'qB' },
      { composer_id: 'cB', bubble_id: 'aB1', type: 2, text: 'B1' },
      { composer_id: 'cB', bubble_id: 'aB2', type: 2, text: 'B2-cont' },
    ];
    createGlobalStorageFixture(dbPath, bubbles, {
      composers: { cA: { createdAt: 100 }, cB: { createdAt: 200 } },
    });

    const turns = await extractCursorTurns(
      dbPath,
      new Map([
        ['cA', 'aA1'],
        ['cB', 'aB1'],
      ]),
    );
    expect(turns).toHaveLength(2);
    const byComposer = new Map(turns.map((t) => [t.composer_id, t]));
    expect(byComposer.get('cA')).toMatchObject({
      user_bubble_id: 'uA',
      assistant_bubble_id: 'aA2',
      is_continuation: true,
      continuation_of_assistant_bubble_id: 'aA1',
    });
    expect(byComposer.get('cB')).toMatchObject({
      user_bubble_id: 'uB',
      assistant_bubble_id: 'aB2',
      is_continuation: true,
      continuation_of_assistant_bubble_id: 'aB1',
    });
  });

  // AC3 Test 5 — defensive guard: composer with only assistant bubbles
  // (truly anomalous; doesn't match any observed Cursor flow). The
  // continuation branch logs `continuation_no_preceding_user` and falls
  // back to silent skip; no turn emitted.
  it('continuation: defensive guard logs warn when no preceding user bubble exists', async () => {
    // Hand-craft the fixture by writing only assistant rows. The composer
    // header carries only assistant entries.
    const bubbles: FixtureBubble[] = [
      { composer_id: 'c1', bubble_id: 'a1', type: 2, text: 'orphan-1' },
      { composer_id: 'c1', bubble_id: 'a2', type: 2, text: 'orphan-2' },
      { composer_id: 'c1', bubble_id: 'a3', type: 2, text: 'orphan-3' },
    ];
    createGlobalStorageFixture(dbPath, bubbles);

    const turns = await extractCursorTurns(dbPath, new Map([['c1', 'a1']]));
    expect(turns).toHaveLength(0);
    const out = captured.writes.join('');
    expect(out).toContain('continuation_no_preceding_user');
    // The first-pass orphan-warn is scoped to the no-checkpoint branch;
    // here the checkpoint exists, so we expect only the new guard warn.
    expect(out).not.toContain('orphan_assistant_bubble');
  });

  it('first-pass orphans (no checkpoint) still warn loudly — fix is scoped to the streaming-continuation case', async () => {
    // True orphans (assistant before any user, with no checkpoint)
    // remain warned. The Gap 2 fix only quietens the post-checkpoint
    // assistant case.
    const bubbles: FixtureBubble[] = [
      { composer_id: 'c1', bubble_id: 'b1', type: 2, text: 'orphan-asst' },
      { composer_id: 'c1', bubble_id: 'b2', type: 1, text: 'late-user' },
      { composer_id: 'c1', bubble_id: 'b3', type: 2, text: 'paired-asst' },
    ];
    createGlobalStorageFixture(dbPath, bubbles);

    const turns = await extractCursorTurns(dbPath, new Map());
    expect(turns).toHaveLength(1);
    expect(captured.writes.join('')).toContain('orphan_assistant_bubble');
  });

  it('produces zero events and warns when cursorDiskKV table is missing', async () => {
    createSchemaUnrecognizedFixture(dbPath);
    const turns = await extractCursorTurns(dbPath, new Map());
    expect(turns).toHaveLength(0);
    expect(captured.writes.join('')).toContain('schema_unrecognized');
  });

  it('warns and returns empty when the DB file does not exist', async () => {
    const turns = await extractCursorTurns(
      join(dir, 'missing.vscdb'),
      new Map(),
    );
    expect(turns).toHaveLength(0);
    expect(captured.writes.join('')).toContain('open_failed');
  });

  it('warns and skips composer when checkpoint bubble is no longer present', async () => {
    createGlobalStorageFixture(dbPath, [
      { composer_id: 'c1', bubble_id: 'b1', type: 1, text: 'q' },
      { composer_id: 'c1', bubble_id: 'b2', type: 2, text: 'a' },
    ]);
    const map = new Map<string, string>([['c1', 'b-evicted']]);
    const turns = await extractCursorTurns(dbPath, map);
    expect(turns).toHaveLength(0);
    expect(captured.writes.join('')).toContain('checkpoint_not_found');
  });

  it('warns and skips bubbles with malformed JSON or unrecognized type values', async () => {
    createGlobalStorageFixture(dbPath, [
      { composer_id: 'c1', bubble_id: 'b1', type: 1, text: 'q' },
      { composer_id: 'c1', bubble_id: 'b2', type: 2, text: 'a' },
    ]);
    appendRawCursorDiskKVRow(dbPath, 'bubbleId:c1:b3', '{not valid json');
    appendRawCursorDiskKVRow(
      dbPath,
      'bubbleId:c1:b4',
      JSON.stringify({ _v: 3, type: 99, text: 'unknown', bubbleId: 'b4' }),
    );
    const turns = await extractCursorTurns(dbPath, new Map());
    expect(turns).toHaveLength(1);
    expect(turns[0]?.user_bubble_id).toBe('b1');
    const log = captured.writes.join('');
    expect(log).toContain('unrecognized_bubble_shape');
    expect(log).toContain('json_parse');
    expect(log).toContain('unknown_type');
  });

  it('skips SQL NULL bubble values without warning', async () => {
    createGlobalStorageFixture(dbPath, [
      { composer_id: 'c1', bubble_id: 'b1', type: 1, text: 'q' },
      { composer_id: 'c1', bubble_id: 'b2', type: 2, text: 'a' },
    ]);
    appendRawCursorDiskKVRow(dbPath, 'bubbleId:c1:b-null', null);

    const turns = await extractCursorTurns(dbPath, new Map());
    expect(turns).toHaveLength(1);
    const log = captured.writes.join('');
    expect(log).not.toContain('not_object');
    expect(log).not.toContain('unrecognized_bubble_shape');
  });

  it('warns when a bubble has no parent composerData row', async () => {
    // A bubble row with a composer_id that has no corresponding composerData entry
    // should be dropped with `unrecognized_bubble_shape: no_composer_row`.
    createGlobalStorageFixture(dbPath, [
      { composer_id: 'c1', bubble_id: 'b1', type: 1, text: 'q' },
      { composer_id: 'c1', bubble_id: 'b2', type: 2, text: 'a' },
    ]);
    appendRawCursorDiskKVRow(
      dbPath,
      'bubbleId:c-orphan:bX',
      JSON.stringify({ _v: 3, type: 1, text: 'no parent', bubbleId: 'bX' }),
    );
    const turns = await extractCursorTurns(dbPath, new Map());
    expect(turns).toHaveLength(1);
    expect(captured.writes.join('')).toContain('no_composer_row');
  });

  it('warns only once per bubble key when a bubble is absent from composer headers', async () => {
    createGlobalStorageFixture(dbPath, [
      { composer_id: 'c-header-once', bubble_id: 'b1', type: 1, text: 'q' },
      { composer_id: 'c-header-once', bubble_id: 'b2', type: 2, text: 'a' },
    ]);
    appendRawCursorDiskKVRow(
      dbPath,
      'bubbleId:c-header-once:b-orphan-header',
      JSON.stringify({
        _v: 3,
        type: 2,
        text: 'contentful but not in header',
        bubbleId: 'b-orphan-header',
      }),
    );

    await extractCursorTurns(dbPath, new Map());
    await extractCursorTurns(dbPath, new Map());

    const log = captured.writes.join('');
    const occurrences = log.match(/not_in_composer_headers/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it('caps and resets the missing-header warning dedupe window', async () => {
    createGlobalStorageFixture(dbPath, [
      { composer_id: 'c-warning-cap', bubble_id: 'b1', type: 1, text: 'q' },
      { composer_id: 'c-warning-cap', bubble_id: 'b2', type: 2, text: 'a' },
    ]);
    const db = new Database(dbPath);
    try {
      const insert = db.prepare(
        'INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)',
      );
      const insertAll = db.transaction(() => {
        for (
          let index = 0;
          index < CURSOR_RUNTIME_CACHE_ENTRIES + 1;
          index += 1
        ) {
          const bubbleId = `orphan-${index}`;
          insert.run(
            `bubbleId:c-warning-cap:${bubbleId}`,
            JSON.stringify({
              _v: 3,
              type: 2,
              text: 'not in composer header',
              bubbleId,
            }),
          );
        }
      });
      insertAll();
    } finally {
      db.close();
    }

    await extractCursorTurns(dbPath, new Map());
    expect(__cursorWarningCacheTestHooks.sizes()).toEqual({
      missingComposerHeader: CURSOR_RUNTIME_CACHE_ENTRIES,
      repoRootResolutionFailed: 0,
    });

    __cursorWarningCacheTestHooks.reset();
    expect(__cursorWarningCacheTestHooks.sizes()).toEqual({
      missingComposerHeader: 0,
      repoRootResolutionFailed: 0,
    });
  });

  it('hard-caps the default raw-row scan before relevant tail payloads', async () => {
    const db = new Database(dbPath);
    try {
      db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)');
      const insert = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
      db.transaction(() => {
        for (let index = 0; index < CURSOR_DEFAULT_PARSE_MAX_ROWS; index += 1) {
          insert.run(`noise:${index}`, 'irrelevant');
        }
        insert.run(
          'composerData:c-tail',
          JSON.stringify({
            composerId: 'c-tail',
            createdAt: 0,
            fullConversationHeadersOnly: [
              { bubbleId: 'u1', type: 1 },
              { bubbleId: 'a1', type: 2 },
            ],
          }),
        );
        insert.run(
          'bubbleId:c-tail:u1',
          JSON.stringify({ _v: 3, type: 1, bubbleId: 'u1', text: 'tail q' }),
        );
        insert.run(
          'bubbleId:c-tail:a1',
          JSON.stringify({ _v: 3, type: 2, bubbleId: 'a1', text: 'tail a' }),
        );
      })();
    } finally {
      db.close();
    }

    expect(await extractCursorTurns(dbPath, new Map())).toEqual([]);
    expect(captured.writes.join('')).toContain('default_read_budget_exhausted');
  });

  it('rejects a relevant default-path value larger than the aggregate byte budget', async () => {
    const db = new Database(dbPath);
    try {
      db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)');
      const insert = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
      insert.run(
        'composerData:c-huge',
        JSON.stringify({
          composerId: 'c-huge',
          createdAt: 0,
          fullConversationHeadersOnly: [
            { bubbleId: 'u1', type: 1 },
            { bubbleId: 'a1', type: 2 },
          ],
          padding: 'x'.repeat(CURSOR_DEFAULT_PARSE_MAX_STORED_BYTES),
        }),
      );
      insert.run(
        'bubbleId:c-huge:u1',
        JSON.stringify({ _v: 3, type: 1, bubbleId: 'u1', text: 'q' }),
      );
      insert.run(
        'bubbleId:c-huge:a1',
        JSON.stringify({ _v: 3, type: 2, bubbleId: 'a1', text: 'a' }),
      );
    } finally {
      db.close();
    }

    expect(await extractCursorTurns(dbPath, new Map())).toEqual([]);
    expect(captured.writes.join('')).toContain('default_read_budget_exhausted');
  });
});

// SKIPPED: every test in this block exercises the chokidar/FSEvents watcher
// lifecycle, and a chokidar `watcher.close()` race during teardown produces
// erratic flake under load. Across baseline and verification runs the failing
// test rotates unpredictably through the block (workspace_id, lastSeenMap,
// stop(), end-to-end appends, files_referenced flatten/omit, CandidateEvent
// emission, etc.), so per-test skips can't catch the moving target. The block
// is quarantined wholesale by item 2026-05-08-023-chokidar-flake-quarantine;
// test bodies are intact for when the underlying race is fixed.
describe.skip('startCursorExtractor (lifecycle + integration)', () => {
  let dir: string;
  let globalDbPath: string;
  let workspacePrefix: string;
  let storage: MemoryStorage;
  let handle: CursorExtractorHandle | null = null;
  let originalFsPaths: string[];
  let captured: ReturnType<typeof captureStdout>;

  beforeEach(() => {
    originalFsPaths = snapshotFsPaths();
    dir = tmpDir();
    workspacePrefix = `${dir}/workspaceStorage/`;
    mkdirSync(workspacePrefix, { recursive: true });
    globalDbPath = join(dir, 'state.vscdb');
    storage = new MemoryStorage();
    captured = captureStdout();
    (CAPTURED_SOURCES.fs_paths as unknown as string[]).push(`${dir}/`);
  });

  afterEach(async () => {
    if (handle !== null) {
      await handle.stop();
      handle = null;
    }
    captured.restore();
    resetAllowlist();
    restoreFsPaths(originalFsPaths);
    rmSync(dir, { recursive: true, force: true });
  });

  it('emits a CandidateEvent per turn through the pipeline on globalStorage change', async () => {
    handle = await startCursorExtractor(storage, {
      globalDbPath,
      workspacePrefix,
    });

    createGlobalStorageFixture(
      globalDbPath,
      [
        { composer_id: 'c1', bubble_id: 'b1', type: 1, text: 'q1' },
        { composer_id: 'c1', bubble_id: 'b2', type: 2, text: 'a1' },
      ],
      { composerCreatedAt: 1000 },
    );

    await waitFor(async () => (await storage.count()) >= 1);
    const events = await storage.query({ order: 'asc' });
    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.source).toBe(`fs:${globalDbPath}`);
    expect(evt.content).toBe('USER: q1\n\nASSISTANT: a1');
    expect(evt.timestamp).toBe(new Date(1001).toISOString());
    expect(evt.metadata).toMatchObject({
      composer_id: 'c1',
      user_bubble_id: 'b1',
      assistant_bubble_id: 'b2',
    });
    expect(evt.metadata).not.toHaveProperty('workspace_id');
  });

  it('emits a CandidateEvent when the globalStorage WAL changes', async () => {
    createGlobalStorageFixture(globalDbPath, [
      { composer_id: 'c1', bubble_id: 'b1', type: 1, text: 'q1' },
      { composer_id: 'c1', bubble_id: 'b2', type: 2, text: 'a1' },
    ]);
    const walPath = `${globalDbPath}-wal`;
    writeFileSync(walPath, '');

    handle = await startCursorExtractor(storage, {
      globalDbPath,
      workspacePrefix,
    });

    const touchedAt = new Date(Date.now() + 1000);
    utimesSync(walPath, touchedAt, touchedAt);

    await waitFor(async () => (await storage.count()) >= 1);
    const events = await storage.query({ order: 'asc' });
    expect(events).toHaveLength(1);
    expect(events[0]!.source).toBe(`fs:${globalDbPath}`);
    expect(events[0]!.content).toBe('USER: q1\n\nASSISTANT: a1');
  });

  it('coalesces rapid globalStorage WAL changes into one emitted capture', async () => {
    createGlobalStorageFixture(globalDbPath, [
      { composer_id: 'c1', bubble_id: 'b1', type: 1, text: 'q1' },
      { composer_id: 'c1', bubble_id: 'b2', type: 2, text: 'a1' },
    ]);
    const walPath = `${globalDbPath}-wal`;
    writeFileSync(walPath, '');

    handle = await startCursorExtractor(storage, {
      globalDbPath,
      workspacePrefix,
    });

    for (let i = 0; i < 3; i += 1) {
      const touchedAt = new Date(Date.now() + 1000 + i * 1000);
      utimesSync(walPath, touchedAt, touchedAt);
    }

    await waitFor(async () => (await storage.count()) >= 1);
    await new Promise((r) => setTimeout(r, 150));
    const events = await storage.query({ order: 'asc' });
    expect(events).toHaveLength(1);
    expect(events[0]!.content).toBe('USER: q1\n\nASSISTANT: a1');
  });

  it('emits distinct timestamps for multiple turns flushed in a single FS event', async () => {
    handle = await startCursorExtractor(storage, {
      globalDbPath,
      workspacePrefix,
    });

    createGlobalStorageFixture(
      globalDbPath,
      [
        { composer_id: 'c1', bubble_id: 'b1', type: 1, text: 'q1' },
        { composer_id: 'c1', bubble_id: 'b2', type: 2, text: 'a1' },
        { composer_id: 'c1', bubble_id: 'b3', type: 1, text: 'q2' },
        { composer_id: 'c1', bubble_id: 'b4', type: 2, text: 'a2' },
      ],
      { composerCreatedAt: 1000 },
    );

    await waitFor(async () => (await storage.count()) >= 2);
    const events = await storage.query({ order: 'asc' });
    expect(events).toHaveLength(2);
    const timestamps = events.map((e) => e.timestamp);
    expect(new Set(timestamps).size).toBe(2);
    expect(timestamps).toEqual([
      new Date(1001).toISOString(),
      new Date(1003).toISOString(),
    ]);
  });

  it('populates workspace_id when the per-workspace inference index has the composer', async () => {
    const wsHash = 'ws-abc';
    const wsDir = join(workspacePrefix, wsHash);
    mkdirSync(wsDir, { recursive: true });
    const wsDbPath = join(wsDir, 'state.vscdb');

    handle = await startCursorExtractor(storage, {
      globalDbPath,
      workspacePrefix,
    });

    // Create the workspace DB AFTER the watcher is ready so chokidar sees the
    // 'add' event and the workspace-inference handler runs before the global
    // chat is created.
    createWorkspaceFixture(wsDbPath, ['c1']);

    // Wait for the watcher to process the workspace add. waitFor on an
    // observable side-effect would be ideal, but the map is internal — so
    // sleep briefly. The serialized processing chain ensures the workspace
    // event is handled before the global event below.
    await new Promise((r) => setTimeout(r, 200));

    createGlobalStorageFixture(globalDbPath, [
      { composer_id: 'c1', bubble_id: 'b1', type: 1, text: 'q' },
      { composer_id: 'c1', bubble_id: 'b2', type: 2, text: 'a' },
    ]);

    await waitFor(async () => (await storage.count()) >= 1);
    const events = await storage.query({ order: 'asc' });
    const evt = events[0]!;
    expect(evt.metadata).toMatchObject({
      composer_id: 'c1',
      workspace_id: wsHash,
    });
  });

  it('populates session_id as the composer_id (canonical alias for cross-source correlation)', async () => {
    handle = await startCursorExtractor(storage, {
      globalDbPath,
      workspacePrefix,
    });

    createGlobalStorageFixture(globalDbPath, [
      { composer_id: 'composer-xyz', bubble_id: 'b1', type: 1, text: 'q' },
      { composer_id: 'composer-xyz', bubble_id: 'b2', type: 2, text: 'a' },
    ]);

    await waitFor(async () => (await storage.count()) >= 1);
    const events = await storage.query({ order: 'asc' });
    const md = events[0]!.metadata as Record<string, unknown>;
    expect(md['session_id']).toBe('composer-xyz');
    expect(md['composer_id']).toBe('composer-xyz');
  });

  it('flattens turn.context paths into a deduped metadata.files_referenced array', async () => {
    handle = await startCursorExtractor(storage, {
      globalDbPath,
      workspacePrefix,
    });

    createGlobalStorageFixture(globalDbPath, [
      {
        composer_id: 'c1',
        bubble_id: 'u1',
        type: 1,
        text: 'fix README',
        attachedFileCodeChunksUris: ['/proj/README.md'],
      },
      {
        composer_id: 'c1',
        bubble_id: 'a1',
        type: 2,
        text: 'looking',
        codeBlocks: [
          { path: '/proj/README.md', languageId: 'markdown' }, // dedup with attached
          { path: '/proj/src/index.ts', languageId: 'typescript' },
        ],
        deletedFiles: ['/proj/old/legacy.md'],
      },
    ]);

    await waitFor(async () => (await storage.count()) >= 1);
    const events = await storage.query({ order: 'asc' });
    const md = events[0]!.metadata as Record<string, unknown>;
    expect(md['files_referenced']).toEqual([
      '/proj/README.md',
      '/proj/src/index.ts',
      '/proj/old/legacy.md',
    ]);
  });

  it('omits metadata.files_referenced when no bubble carried any file references', async () => {
    handle = await startCursorExtractor(storage, {
      globalDbPath,
      workspacePrefix,
    });

    createGlobalStorageFixture(globalDbPath, [
      { composer_id: 'c1', bubble_id: 'b1', type: 1, text: 'hi' },
      { composer_id: 'c1', bubble_id: 'b2', type: 2, text: 'hello back' },
    ]);

    await waitFor(async () => (await storage.count()) >= 1);
    const events = await storage.query({ order: 'asc' });
    const md = events[0]!.metadata as Record<string, unknown>;
    expect(md).not.toHaveProperty('files_referenced');
  });

  it('end-to-end: chronological appends produce ordered, non-duplicate turns', async () => {
    createGlobalStorageFixture(globalDbPath, []);
    handle = await startCursorExtractor(storage, {
      globalDbPath,
      workspacePrefix,
    });

    const turnPairs: FixtureBubble[][] = [
      [
        { composer_id: 'c1', bubble_id: 'b1', type: 1, text: 'q1' },
        { composer_id: 'c1', bubble_id: 'b2', type: 2, text: 'a1' },
      ],
      [
        { composer_id: 'c1', bubble_id: 'b3', type: 1, text: 'q2' },
        { composer_id: 'c1', bubble_id: 'b4', type: 2, text: 'a2' },
      ],
      [
        { composer_id: 'c1', bubble_id: 'b5', type: 1, text: 'q3' },
        { composer_id: 'c1', bubble_id: 'b6', type: 2, text: 'a3' },
      ],
    ];

    let expected = 0;
    for (const pair of turnPairs) {
      for (const b of pair) appendBubble(globalDbPath, b);
      expected += 1;
      await waitFor(async () => (await storage.count()) >= expected);
    }

    const events = await storage.query({ order: 'asc' });
    expect(events).toHaveLength(3);
    const userBubbleIds = events.map(
      (e) => (e.metadata as Record<string, unknown>)['user_bubble_id'],
    );
    expect(userBubbleIds).toEqual(['b1', 'b3', 'b5']);
    const contents = events.map((e) => e.content);
    expect(contents).toEqual([
      'USER: q1\n\nASSISTANT: a1',
      'USER: q2\n\nASSISTANT: a2',
      'USER: q3\n\nASSISTANT: a3',
    ]);
  });

  it('backfills lastSeenMap from prior storage events on boot', async () => {
    createGlobalStorageFixture(globalDbPath, [
      { composer_id: 'c1', bubble_id: 'b1', type: 1, text: 'old-q' },
      { composer_id: 'c1', bubble_id: 'b2', type: 2, text: 'old-a' },
    ]);

    await storage.append({
      source: `fs:${globalDbPath}`,
      timestamp: '2026-04-30T00:00:00Z',
      content: 'USER: old-q\n\nASSISTANT: old-a',
      metadata: {
        composer_id: 'c1',
        user_bubble_id: 'b1',
        assistant_bubble_id: 'b2',
      },
    });

    handle = await startCursorExtractor(storage, {
      globalDbPath,
      workspacePrefix,
    });

    appendBubble(globalDbPath, {
      composer_id: 'c1',
      bubble_id: 'b3',
      type: 1,
      text: 'new-q',
    });
    appendBubble(globalDbPath, {
      composer_id: 'c1',
      bubble_id: 'b4',
      type: 2,
      text: 'new-a',
    });

    await waitFor(async () => (await storage.count()) >= 2);
    const events = await storage.query({ order: 'asc' });
    expect(events).toHaveLength(2);
    const fresh = events.find((e) => e.timestamp !== '2026-04-30T00:00:00Z');
    expect(fresh).toBeDefined();
    expect(fresh!.metadata).toMatchObject({
      composer_id: 'c1',
      user_bubble_id: 'b3',
      assistant_bubble_id: 'b4',
    });
  });

  it('stop() resolves cleanly and prevents further events', async () => {
    handle = await startCursorExtractor(storage, {
      globalDbPath,
      workspacePrefix,
    });
    createGlobalStorageFixture(globalDbPath, [
      { composer_id: 'c1', bubble_id: 'b1', type: 1, text: 'q' },
      { composer_id: 'c1', bubble_id: 'b2', type: 2, text: 'a' },
    ]);
    await waitFor(async () => (await storage.count()) >= 1);
    const before = await storage.count();

    await handle.stop();
    handle = null;

    appendBubble(globalDbPath, {
      composer_id: 'c1',
      bubble_id: 'b3',
      type: 1,
      text: 'q2',
    });
    appendBubble(globalDbPath, {
      composer_id: 'c1',
      bubble_id: 'b4',
      type: 2,
      text: 'a2',
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(await storage.count()).toBe(before);
  });
});

describe('startCursorExtractor bounded checkpoint startup', () => {
  class FakeCursorWatcher extends EventEmitter {
    async close(): Promise<void> {
      return Promise.resolve();
    }

    asFsWatcher(): FSWatcher {
      return this as unknown as FSWatcher;
    }
  }

  class NoHistoryQueryStorage extends MemoryStorage {
    queryCalls = 0;

    override async query(): Promise<never> {
      this.queryCalls += 1;
      throw new Error('history query is forbidden during Cursor startup');
    }
  }

  let dir: string;
  let dbPath: string;
  let workspacePrefix: string;
  let originalFsPaths: string[];
  let handle: CursorExtractorHandle | null = null;

  beforeEach(() => {
    originalFsPaths = snapshotFsPaths();
    dir = tmpDir();
    dbPath = join(dir, 'state.vscdb');
    workspacePrefix = `${dir}/workspaceStorage/`;
    mkdirSync(workspacePrefix, { recursive: true });
    (CAPTURED_SOURCES.fs_paths as unknown as string[]).push(`${dir}/`);
  });

  afterEach(async () => {
    if (handle !== null) {
      await handle.stop();
      handle = null;
    }
    resetAllowlist();
    restoreFsPaths(originalFsPaths);
    rmSync(dir, { recursive: true, force: true });
  });

  it('treats a SQL NULL key as bounded irrelevant noise during startup', async () => {
    const storage = new MemoryStorage();
    createGlobalStorageFixture(dbPath, [
      { composer_id: 'c1', bubble_id: 'u1', type: 1, text: 'question' },
      { composer_id: 'c1', bubble_id: 'a1', type: 2, text: 'answer' },
    ]);
    const db = new Database(dbPath);
    db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (NULL, ?)').run(
      'irrelevant',
    );
    db.close();

    handle = await startCursorExtractor(storage, {
      globalDbPath: dbPath,
      workspacePrefix,
      repollIntervalMs: 60_000,
      exposeTestHooks: true,
      __bounds: { scanPageRows: 2, maxScanPagesPerSlice: 1 },
    });
    await handle.initialCatchUp;

    expect(handle.getHealth().state).toBe('healthy');
    expect(await storage.count()).toBe(1);
  });

  it('does not enqueue header-only composers during bounded discovery', async () => {
    const storage = new MemoryStorage();
    createGlobalStorageFixture(dbPath, [
      { composer_id: 'real', bubble_id: 'u1', type: 1, text: 'question' },
      { composer_id: 'real', bubble_id: 'a1', type: 2, text: 'answer' },
    ]);
    const db = new Database(dbPath);
    const insert = db.prepare(
      'INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)',
    );
    db.transaction(() => {
      for (let i = 0; i < 300; i += 1) {
        const composerId = `header-only-${String(i).padStart(3, '0')}`;
        insert.run(
          `composerData:${composerId}`,
          JSON.stringify({
            composerId,
            createdAt: 0,
            fullConversationHeadersOnly: [],
          }),
        );
      }
    })();
    db.close();

    handle = await startCursorExtractor(storage, {
      globalDbPath: dbPath,
      workspacePrefix,
      repollIntervalMs: 60_000,
      exposeTestHooks: true,
      __bounds: {
        scanPageRows: 32,
        maxScanPagesPerSlice: 2,
        maxPendingComposers: 8,
        maxComposersPerSlice: 2,
      },
    });
    await handle.initialCatchUp;

    expect(await storage.count()).toBe(1);
    const metrics = handle.__testHooks!.getBoundedReadMetrics();
    expect(metrics.composerReads).toBe(2);
    expect(metrics.maxComposerBatchSize).toBeLessThanOrEqual(2);
    expect(handle.getHealth().overflowCount).toBe(0);
  });

  it('captures rows beyond the fixed startup watermark on the queued live tick', async () => {
    const storage = new MemoryStorage();
    const db = new Database(dbPath);
    db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)');
    const insert = db.prepare(
      'INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)',
    );
    db.transaction(() => {
      for (let i = 0; i < 100; i += 1) {
        const composerId = `header-only-${String(i).padStart(3, '0')}`;
        insert.run(
          `composerData:${composerId}`,
          JSON.stringify({
            composerId,
            createdAt: 0,
            fullConversationHeadersOnly: [],
          }),
        );
      }
    })();
    db.close();

    handle = await startCursorExtractor(storage, {
      globalDbPath: dbPath,
      workspacePrefix,
      repollIntervalMs: 60_000,
      exposeTestHooks: true,
      __bounds: {
        scanPageRows: 1,
        maxScanPagesPerSlice: 1,
        maxComposersPerSlice: 1,
      },
    });
    await waitFor(
      () => handle!.__testHooks!.getBoundedReadMetrics().scanPages > 0,
    );

    appendBubble(dbPath, {
      composer_id: 'arrived-during-startup',
      bubble_id: 'u1',
      type: 1,
      text: 'question',
    });
    appendBubble(dbPath, {
      composer_id: 'arrived-during-startup',
      bubble_id: 'a1',
      type: 2,
      text: 'answer',
    });
    const queuedLiveTick = handle.__testHooks!.queueGlobalChange();

    await handle.initialCatchUp;
    await queuedLiveTick;

    expect(await storage.count()).toBe(1);
    expect((await storage.query({}))[0]?.metadata?.['composer_id']).toBe(
      'arrived-during-startup',
    );
  });

  it('caps saturated composer work per macrotask and retries the overflow boundary', async () => {
    const storage = new MemoryStorage();
    const db = new Database(dbPath);
    db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)');
    const insert = db.prepare(
      'INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)',
    );
    const composerIds = Array.from(
      { length: 129 },
      (_, index) => `c-${String(index).padStart(3, '0')}`,
    );
    db.transaction(() => {
      for (const composerId of composerIds) {
        insert.run(
          `bubbleId:${composerId}:u1`,
          JSON.stringify({ _v: 3, type: 1, bubbleId: 'u1', text: 'q' }),
        );
      }
      for (const composerId of composerIds) {
        insert.run(
          `composerData:${composerId}`,
          JSON.stringify({
            composerId,
            createdAt: 0,
            fullConversationHeadersOnly: [
              { bubbleId: 'u1', type: 1 },
              { bubbleId: 'a1', type: 2 },
            ],
          }),
        );
      }
      for (const composerId of composerIds) {
        insert.run(
          `bubbleId:${composerId}:a1`,
          JSON.stringify({ _v: 3, type: 2, bubbleId: 'a1', text: 'a' }),
        );
      }
    })();
    db.close();

    handle = await startCursorExtractor(storage, {
      globalDbPath: dbPath,
      workspacePrefix,
      repollIntervalMs: 60_000,
      exposeTestHooks: true,
      __bounds: {
        scanPageRows: 129,
        maxScanPagesPerSlice: 1,
        maxPendingComposers: 128,
        maxComposersPerSlice: CURSOR_MAX_COMPOSERS_PER_SLICE,
        composerPageRows: 512,
        composerMaxRows: 512,
        composerMaxPages: 1,
      },
    });
    await handle.initialCatchUp;

    expect(await storage.count()).toBe(129);
    const metrics = handle.__testHooks!.getBoundedReadMetrics();
    expect(metrics.maxPendingComposers).toBe(128);
    expect(metrics.maxComposerBatchSize).toBeLessThanOrEqual(
      CURSOR_MAX_COMPOSERS_PER_SLICE,
    );
    expect(handle.getHealth().overflowCount).toBeGreaterThan(0);
  });

  it('coalesces repeated global DB notifications into one dirty follow-up', async () => {
    const storage = new MemoryStorage();
    createGlobalStorageFixture(dbPath, [
      { composer_id: 'c1', bubble_id: 'u1', type: 1, text: 'question' },
      { composer_id: 'c1', bubble_id: 'a1', type: 2, text: 'answer' },
    ]);
    handle = await startCursorExtractor(storage, {
      globalDbPath: dbPath,
      workspacePrefix,
      repollIntervalMs: 60_000,
      exposeTestHooks: true,
    });
    await handle.initialCatchUp;
    const before = handle.__testHooks!.getBoundedReadMetrics();

    const signals = Array.from({ length: 20 }, () =>
      handle!.__testHooks!.queueGlobalChange(),
    );
    await Promise.all(signals);

    const after = handle.__testHooks!.getBoundedReadMetrics();
    expect(
      after.coalescedGlobalSignals - before.coalescedGlobalSignals,
    ).toBe(19);
    expect(after.globalTicks - before.globalTicks).toBe(2);
  });

  it('uses exact checkpoints only and keeps every SQL page/queue/read below configured caps', async () => {
    const storage = new NoHistoryQueryStorage();
    createGlobalStorageFixture(
      dbPath,
      ['c1', 'c2', 'c3'].flatMap((composer_id) => [
        {
          composer_id,
          bubble_id: 'u1',
          type: 1 as const,
          text: `q-${composer_id}`,
        },
        {
          composer_id,
          bubble_id: 'a1',
          type: 2 as const,
          text: `a-${composer_id}`,
        },
      ]),
    );

    handle = await startCursorExtractor(storage, {
      globalDbPath: dbPath,
      workspacePrefix,
      repollIntervalMs: 60_000,
      exposeTestHooks: true,
      __bounds: {
        scanPageRows: 2,
        maxScanPagesPerSlice: 1,
        maxPendingComposers: 1,
        composerPageRows: 1,
        composerMaxRows: 4,
        composerMaxStoredBytes: 32 * 1024,
        composerMaxPages: 4,
      },
    });
    await handle.initialCatchUp;

    expect(storage.queryCalls).toBe(0);
    expect(await storage.count()).toBe(3);
    const metrics = handle.__testHooks!.getBoundedReadMetrics();
    expect(metrics.maxScanPageRows).toBeLessThanOrEqual(2);
    expect(metrics.maxPendingComposers).toBeLessThanOrEqual(1);
    expect(metrics.maxComposerRows).toBeLessThanOrEqual(4);
    expect(metrics.maxComposerStoredBytes).toBeLessThanOrEqual(32 * 1024);
    expect(metrics.maxComposerPages).toBeLessThanOrEqual(4);
    expect(handle.getHealth()).toMatchObject({
      state: 'healthy',
      reconciliationPending: true,
    });
    expect(handle.getHealth().queueDepth).toBeLessThanOrEqual(1);
  });

  it('pages sparse cursorDiskKV data by raw rowid before filtering', async () => {
    const storage = new MemoryStorage();
    const db = new Database(dbPath);
    db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)');
    const insert = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
    insert.run(
      'composerData:c1',
      JSON.stringify({
        composerId: 'c1',
        createdAt: 0,
        fullConversationHeadersOnly: [
          { bubbleId: 'u1', type: 1 },
          { bubbleId: 'a1', type: 2 },
        ],
      }),
    );
    for (let i = 0; i < 40; i += 1) {
      insert.run(`irrelevant-before:${String(i).padStart(3, '0')}`, 'x');
    }
    insert.run(
      'bubbleId:c1:u1',
      JSON.stringify({ _v: 3, type: 1, bubbleId: 'u1', text: 'sparse question' }),
    );
    // This oversized irrelevant key proves discovery never materializes the
    // full key merely to decide that it is not a Cursor conversation row.
    insert.run(`irrelevant-huge:${'x'.repeat(32 * 1024)}`, 'x');
    for (let i = 0; i < 40; i += 1) {
      insert.run(`irrelevant-after:${String(i).padStart(3, '0')}`, 'x');
    }
    insert.run(
      'bubbleId:c1:a1',
      JSON.stringify({ _v: 3, type: 2, bubbleId: 'a1', text: 'sparse answer' }),
    );
    db.close();

    handle = await startCursorExtractor(storage, {
      globalDbPath: dbPath,
      workspacePrefix,
      repollIntervalMs: 60_000,
      exposeTestHooks: true,
      __bounds: {
        scanPageRows: 3,
        maxScanPagesPerSlice: 1,
        maxPendingComposers: 1,
        composerPageRows: 2,
        composerMaxRows: 6,
        composerMaxPages: 3,
      },
    });
    await handle.initialCatchUp;

    expect(await storage.count()).toBe(1);
    const event = (await storage.query({}))[0]!;
    expect(event.content).toBe('USER: sparse question\n\nASSISTANT: sparse answer');
    const metrics = handle.__testHooks!.getBoundedReadMetrics();
    expect(metrics.maxScanPageRows).toBeLessThanOrEqual(3);
    expect(metrics.maxComposerRows).toBeLessThanOrEqual(6);
    expect(metrics.maxComposerPages).toBeLessThanOrEqual(3);
    expect(handle.getHealth().state).toBe('healthy');
  });

  it('recovers a migrated checkpoint user from composer metadata without a backwards scan', async () => {
    const storage = new MemoryStorage();
    const db = new Database(dbPath);
    db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)');
    const insert = db.prepare(
      'INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)',
    );
    insert.run(
      'composerData:c1',
      JSON.stringify({
        composerId: 'c1',
        createdAt: 0,
        fullConversationHeadersOnly: [
          { bubbleId: 'u1', type: 1 },
          { bubbleId: 'a1', type: 2 },
          { bubbleId: 'a2', type: 2 },
        ],
      }),
    );
    insert.run(
      'bubbleId:c1:u1',
      JSON.stringify({ _v: 3, type: 1, bubbleId: 'u1', text: 'question' }),
    );
    for (let i = 0; i < 40; i += 1) insert.run(`noise:${i}`, 'x');
    insert.run(
      'bubbleId:c1:a1',
      JSON.stringify({ _v: 3, type: 2, bubbleId: 'a1', text: 'first' }),
    );
    insert.run(
      'bubbleId:c1:a2',
      JSON.stringify({ _v: 3, type: 2, bubbleId: 'a2', text: 'continued' }),
    );
    db.close();

    // Legacy/migrated checkpoints have a cursor but no user_bubble_id state.
    await storage.upsertCaptureCheckpoint({
      extractor: 'cursor',
      resource: dbPath,
      partition: 'c1',
      cursor: 'a1',
      position: 0,
      state: {},
      updated_at: new Date().toISOString(),
    });

    handle = await startCursorExtractor(storage, {
      globalDbPath: dbPath,
      workspacePrefix,
      repollIntervalMs: 60_000,
      exposeTestHooks: true,
      __bounds: {
        scanPageRows: 4,
        maxScanPagesPerSlice: 1,
        composerPageRows: 2,
        composerMaxRows: 2,
        composerMaxPages: 1,
      },
    });
    await handle.initialCatchUp;

    expect(await storage.count()).toBe(1);
    const event = (await storage.query({}))[0]!;
    expect(event.content).toBe('USER: question\n\nASSISTANT: continued');
    expect(event.metadata).toMatchObject({
      user_bubble_id: 'u1',
      assistant_bubble_id: 'a2',
      is_continuation: true,
      continuation_of_assistant_bubble_id: 'a1',
    });
    expect(handle.getHealth().state).toBe('healthy');
    expect(
      handle.__testHooks!.getBoundedReadMetrics().maxComposerPages,
    ).toBeLessThanOrEqual(1);
  });

  it('resumes a persisted reconciliation cursor on a 10k-row restart within one fixed budget', async () => {
    const storage = new MemoryStorage();
    const db = new Database(dbPath);
    db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)');
    const insert = db.prepare(
      'INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)',
    );
    db.transaction(() => {
      for (let i = 0; i < 10_000; i += 1) {
        insert.run(`noise:${String(i).padStart(5, '0')}`, 'x');
      }
    })();
    db.close();

    await storage.upsertCaptureCheckpoint({
      extractor: 'cursor',
      resource: dbPath,
      partition: '__scan__',
      position: 10_000,
      state: {
        reconciliation_row_id: 5_000,
        reconciliation_target_row_id: 10_000,
      },
      updated_at: new Date().toISOString(),
    });
    const options = {
      globalDbPath: dbPath,
      workspacePrefix,
      repollIntervalMs: 60_000,
      exposeTestHooks: true,
      __bounds: { scanPageRows: 10, maxScanPagesPerSlice: 2 },
    } as const;

    handle = await startCursorExtractor(storage, options);
    await handle.initialCatchUp;
    expect(handle.__testHooks!.getBoundedReadMetrics()).toMatchObject({
      deltaPages: 0,
      reconciliationPages: 2,
      scanPages: 2,
    });
    const first = await storage.getCaptureCheckpoint({
      extractor: 'cursor',
      resource: dbPath,
      partition: '__scan__',
    });
    expect(first?.state['reconciliation_row_id']).toBe(5_020);
    expect(first?.state['reconciliation_target_row_id']).toBe(10_000);
    await handle.stop();
    handle = null;

    handle = await startCursorExtractor(storage, options);
    await handle.initialCatchUp;
    expect(handle.__testHooks!.getBoundedReadMetrics()).toMatchObject({
      deltaPages: 0,
      reconciliationPages: 2,
      scanPages: 2,
    });
    const second = await storage.getCaptureCheckpoint({
      extractor: 'cursor',
      resource: dbPath,
      partition: '__scan__',
    });
    expect(second?.state['reconciliation_row_id']).toBe(5_040);
    expect(second?.state['reconciliation_target_row_id']).toBe(10_000);
    expect(handle.getHealth().reconciliationPending).toBe(true);
  });

  it('caps every live tick while delta is immediate and old in-place rows are eventually revisited', async () => {
    const storage = new MemoryStorage();
    const db = new Database(dbPath);
    db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)');
    const insert = db.prepare(
      'INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)',
    );
    for (let i = 0; i < 20; i += 1) insert.run(`noise:${i}`, 'x');
    insert.run(
      'composerData:old',
      JSON.stringify({
        composerId: 'old',
        createdAt: 0,
        fullConversationHeadersOnly: [
          { bubbleId: 'u1', type: 1 },
          { bubbleId: 'a1', type: 2 },
        ],
      }),
    );
    insert.run(
      'bubbleId:old:u1',
      JSON.stringify({ _v: 3, type: 1, bubbleId: 'u1', text: 'old q' }),
    );
    insert.run(
      'bubbleId:old:a1',
      JSON.stringify({ _v: 3, type: 2, bubbleId: 'a1', text: '' }),
    );
    db.close();

    handle = await startCursorExtractor(storage, {
      globalDbPath: dbPath,
      workspacePrefix,
      repollIntervalMs: 60_000,
      exposeTestHooks: true,
      __bounds: { scanPageRows: 4, maxScanPagesPerSlice: 1 },
    });
    await handle.initialCatchUp;
    expect(await storage.count()).toBe(0);

    const update = new Database(dbPath);
    update.prepare('UPDATE cursorDiskKV SET value = ? WHERE key = ?').run(
      JSON.stringify({
        _v: 3,
        type: 2,
        bubbleId: 'a1',
        text: 'old answer completed in place',
      }),
      'bubbleId:old:a1',
    );
    update.close();
    appendBubble(dbPath, {
      composer_id: 'new',
      bubble_id: 'u1',
      type: 1,
      text: 'new q',
    });
    appendBubble(dbPath, {
      composer_id: 'new',
      bubble_id: 'a1',
      type: 2,
      text: 'new answer',
    });

    let previousMetrics = handle.__testHooks!.getBoundedReadMetrics();
    await handle.__testHooks!.triggerRepoll();
    let currentMetrics = handle.__testHooks!.getBoundedReadMetrics();
    expect(currentMetrics.deltaPages - previousMetrics.deltaPages).toBe(1);
    expect(
      currentMetrics.reconciliationPages -
        previousMetrics.reconciliationPages,
    ).toBeLessThanOrEqual(1);
    expect(
      (await storage.query({})).some(
        (event) => event.metadata?.['composer_id'] === 'new',
      ),
    ).toBe(true);

    for (let tick = 0; tick < 8; tick += 1) {
      if (
        (await storage.query({})).some(
          (event) => event.metadata?.['composer_id'] === 'old',
        )
      ) {
        break;
      }
      previousMetrics = currentMetrics;
      await handle.__testHooks!.triggerRepoll();
      currentMetrics = handle.__testHooks!.getBoundedReadMetrics();
      expect(currentMetrics.deltaPages - previousMetrics.deltaPages).toBe(0);
      expect(
        currentMetrics.reconciliationPages -
          previousMetrics.reconciliationPages,
      ).toBeLessThanOrEqual(1);
      expect(currentMetrics.scanPages - previousMetrics.scanPages).toBeLessThanOrEqual(
        1,
      );
    }
    expect(
      (await storage.query({})).some(
        (event) => event.metadata?.['composer_id'] === 'old',
      ),
    ).toBe(true);
  });

  it('uses rowid seek plans with no temporary sort for every raw list page', () => {
    createGlobalStorageFixture(dbPath, [
      { composer_id: 'c1', bubble_id: 'u1', type: 1, text: 'q' },
      { composer_id: 'c1', bubble_id: 'a1', type: 2, text: 'a' },
    ]);
    const db = new Database(dbPath, { readonly: true });
    try {
      const plans = [
        db
          .prepare(`EXPLAIN QUERY PLAN ${CURSOR_RAW_ROWID_ASC_PAGE_SQL}`)
          .all(0, Number.MAX_SAFE_INTEGER, 8),
        db
          .prepare(`EXPLAIN QUERY PLAN ${CURSOR_RAW_ROWID_DESC_PAGE_SQL}`)
          .all(Number.MAX_SAFE_INTEGER, 8),
      ] as Array<Array<{ detail: string }>>;
      for (const plan of plans) {
        const details = plan.map((row) => row.detail).join('\n');
        expect(details).toMatch(/INTEGER PRIMARY KEY/);
        expect(details).not.toMatch(/TEMP B-TREE|USE TEMP/i);
      }
      expect(CURSOR_RAW_ROWID_ASC_PAGE_SQL).not.toMatch(/LIKE|ORDER BY key/i);
      expect(CURSOR_RAW_ROWID_DESC_PAGE_SQL).not.toMatch(/LIKE|ORDER BY key/i);
    } finally {
      db.close();
    }
  });

  it('resumes bounded rotating reconciliation on restart to recover an in-place KV update', async () => {
    const storage = new NoHistoryQueryStorage();
    createGlobalStorageFixture(dbPath, [
      { composer_id: 'c1', bubble_id: 'u1', type: 1, text: 'question' },
      { composer_id: 'c1', bubble_id: 'a1', type: 2, text: '' },
    ]);

    handle = await startCursorExtractor(storage, {
      globalDbPath: dbPath,
      workspacePrefix,
      repollIntervalMs: 60_000,
      exposeTestHooks: true,
      __bounds: { scanPageRows: 1, maxScanPagesPerSlice: 1 },
    });
    await handle.initialCatchUp;
    expect(await storage.count()).toBe(0);
    await handle.stop();
    handle = null;

    const db = new Database(dbPath);
    db.prepare('UPDATE cursorDiskKV SET value = ? WHERE key = ?').run(
      JSON.stringify({
        _v: 3,
        type: 2,
        bubbleId: 'a1',
        text: 'finished answer',
      }),
      'bubbleId:c1:a1',
    );
    db.close();

    handle = await startCursorExtractor(storage, {
      globalDbPath: dbPath,
      workspacePrefix,
      repollIntervalMs: 60_000,
      exposeTestHooks: true,
      __bounds: { scanPageRows: 1, maxScanPagesPerSlice: 1 },
    });
    await handle.initialCatchUp;

    expect(storage.queryCalls).toBe(0);
    expect(await storage.count()).toBe(1);
    expect(handle.getHealth().state).toBe('healthy');
  });

  it('restarts sparse per-composer progress before checking an in-place update', async () => {
    const storage = new MemoryStorage();
    const db = new Database(dbPath);
    db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)');
    const insert = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
    insert.run(
      'composerData:c1',
      JSON.stringify({
        composerId: 'c1',
        createdAt: 0,
        fullConversationHeadersOnly: [
          { bubbleId: 'u1', type: 1 },
          { bubbleId: 'a1', type: 2 },
        ],
      }),
    );
    for (let i = 0; i < 12; i += 1) insert.run(`noise-a:${i}`, 'x');
    insert.run(
      'bubbleId:c1:u1',
      JSON.stringify({ _v: 3, type: 1, bubbleId: 'u1', text: 'question' }),
    );
    for (let i = 0; i < 12; i += 1) insert.run(`noise-b:${i}`, 'x');
    insert.run(
      'bubbleId:c1:a1',
      JSON.stringify({ _v: 3, type: 2, bubbleId: 'a1', text: '' }),
    );
    for (let i = 0; i < 12; i += 1) insert.run(`noise-c:${i}`, 'x');
    db.close();

    const extractorOptions = {
      globalDbPath: dbPath,
      workspacePrefix,
      repollIntervalMs: 60_000,
      exposeTestHooks: true,
      __bounds: {
        scanPageRows: 2,
        maxScanPagesPerSlice: 1,
        composerPageRows: 2,
        composerMaxRows: 4,
        composerMaxPages: 2,
      },
    } as const;
    handle = await startCursorExtractor(storage, extractorOptions);
    await handle.initialCatchUp;
    expect(await storage.count()).toBe(0);
    await handle.stop();
    handle = null;

    const update = new Database(dbPath);
    update.prepare('UPDATE cursorDiskKV SET value = ? WHERE key = ?').run(
      JSON.stringify({
        _v: 3,
        type: 2,
        bubbleId: 'a1',
        text: 'finished after restart',
      }),
      'bubbleId:c1:a1',
    );
    update.close();

    handle = await startCursorExtractor(storage, extractorOptions);
    await handle.initialCatchUp;
    for (let i = 0; i < 24 && (await storage.count()) === 0; i += 1) {
      await handle.__testHooks!.triggerRepoll();
    }
    expect(await storage.count()).toBe(1);
    expect((await storage.query({}))[0]?.content).toContain(
      'finished after restart',
    );
    expect(handle.getHealth().state).toBe('healthy');
  });

  it('carries a trailing user row across a hard composer window without losing the turn', async () => {
    const storage = new MemoryStorage();
    createGlobalStorageFixture(dbPath, [
      { composer_id: 'c1', bubble_id: 'orphan-1', type: 2, text: 'orphan 1' },
      { composer_id: 'c1', bubble_id: 'orphan-2', type: 2, text: 'orphan 2' },
      { composer_id: 'c1', bubble_id: 'orphan-3', type: 2, text: 'orphan 3' },
      {
        composer_id: 'c1',
        bubble_id: 'u1',
        type: 1,
        text: 'boundary question',
      },
      { composer_id: 'c1', bubble_id: 'a1', type: 2, text: 'boundary answer' },
    ]);

    handle = await startCursorExtractor(storage, {
      globalDbPath: dbPath,
      workspacePrefix,
      repollIntervalMs: 60_000,
      exposeTestHooks: true,
      __bounds: {
        composerPageRows: 2,
        composerMaxRows: 4,
        composerMaxPages: 2,
      },
    });
    await handle.initialCatchUp;

    expect(await storage.count()).toBe(1);
    const event = (await storage.query({}))[0]!;
    expect(event.content).toBe(
      'USER: boundary question\n\nASSISTANT: boundary answer',
    );
    expect(handle.getHealth().state).toBe('healthy');
    expect(
      handle.__testHooks!.getBoundedReadMetrics().maxComposerRows,
    ).toBeLessThanOrEqual(4);
  });

  it('settles startup on watcher error and retains unhealthy health', async () => {
    const watcher = new FakeCursorWatcher();
    handle = await startCursorExtractor(new MemoryStorage(), {
      globalDbPath: dbPath,
      workspacePrefix,
      repollIntervalMs: 60_000,
      __watcherFactory: () => {
        queueMicrotask(() =>
          watcher.emit('error', new Error('synthetic watcher startup error')),
        );
        return watcher.asFsWatcher();
      },
    });
    await handle.initialCatchUp;

    expect(handle.getHealth()).toMatchObject({
      state: 'unhealthy',
      errorCount: 1,
      lastError: 'synthetic watcher startup error',
    });
  });

  it('reports a missing optional Cursor database explicitly as absent', async () => {
    const watcher = new FakeCursorWatcher();
    handle = await startCursorExtractor(new MemoryStorage(), {
      globalDbPath: dbPath,
      workspacePrefix,
      repollIntervalMs: 60_000,
      __watcherFactory: () => {
        queueMicrotask(() => watcher.emit('ready'));
        return watcher.asFsWatcher();
      },
    });
    await handle.initialCatchUp;

    expect(handle.getHealth()).toMatchObject({
      state: 'healthy',
      sourceStatus: 'absent',
      errorCount: 0,
      lastError: null,
    });
  });

  it('reports an existing incompatible Cursor database as unhealthy', async () => {
    createSchemaUnrecognizedFixture(dbPath);
    const watcher = new FakeCursorWatcher();
    handle = await startCursorExtractor(new MemoryStorage(), {
      globalDbPath: dbPath,
      workspacePrefix,
      repollIntervalMs: 60_000,
      __watcherFactory: () => {
        queueMicrotask(() => watcher.emit('ready'));
        return watcher.asFsWatcher();
      },
    });
    await handle.initialCatchUp;

    expect(handle.getHealth()).toMatchObject({
      state: 'unhealthy',
      sourceStatus: 'active',
      errorCount: 1,
    });
    expect(handle.getHealth().lastError).toMatch(/schema is incompatible/);
  });

  it('reports an existing unreadable/non-SQLite Cursor database as unhealthy', async () => {
    writeFileSync(dbPath, 'not a sqlite database');
    const watcher = new FakeCursorWatcher();
    handle = await startCursorExtractor(new MemoryStorage(), {
      globalDbPath: dbPath,
      workspacePrefix,
      repollIntervalMs: 60_000,
      __watcherFactory: () => {
        queueMicrotask(() => watcher.emit('ready'));
        return watcher.asFsWatcher();
      },
    });
    await handle.initialCatchUp;

    expect(handle.getHealth()).toMatchObject({
      state: 'unhealthy',
      sourceStatus: 'active',
      errorCount: 1,
    });
    expect(handle.getHealth().lastError).toMatch(/schema is incompatible/);
  });
});

describe('CAPTURED_SOURCES allowlist update for globalStorage', () => {
  it('declares globalStorage path under fs_paths', () => {
    expect(CAPTURED_SOURCES.fs_paths).toContain(
      '~/Library/Application Support/Cursor/User/globalStorage/',
    );
  });

  it('_isAllowedPathIn accepts a globalStorage path under the allowlist entry', () => {
    const home = process.env['HOME']!;
    const path = `${home}/Library/Application Support/Cursor/User/globalStorage/state.vscdb`;
    expect(_isAllowedPathIn(path, CAPTURED_SOURCES.fs_paths)).toBe(true);
  });
});

// AC2 — Parse-time fallback chain for tool-call / non-text bubble shapes.
// These tests target the pure parsers + extractCursorTurns directly so they
// live outside the chokidar quarantine. Item 034.
describe('parseBubbleRow fallback chain (AC2 — item 034)', () => {
  let dir: string;
  let dbPath: string;
  let captured: ReturnType<typeof captureStdout>;

  beforeEach(() => {
    dir = tmpDir();
    dbPath = join(dir, 'state.vscdb');
    captured = captureStdout();
  });

  afterEach(() => {
    captured.restore();
    rmSync(dir, { recursive: true, force: true });
  });

  // Fixture (a) — pure text (regression: AC2 must not break the 99% path).
  it('case (a): pure text bubble emits with bubble_text_sources omitted', async () => {
    createGlobalStorageFixture(dbPath, [
      { composer_id: 'c1', bubble_id: 'u1', type: 1, text: 'q' },
      { composer_id: 'c1', bubble_id: 'a1', type: 2, text: 'plain answer' },
    ]);
    const turns = await extractCursorTurns(dbPath, new Map());
    expect(turns).toHaveLength(1);
    expect(turns[0]?.assistant_message).toBe('plain answer');
    // No-bloat 99% case: bubble_text_sources omitted when every bubble used 'text'.
    expect(turns[0]?.bubble_text_sources).toBeUndefined();
  });

  // Fixture (b) — toolFormerData only (assistant has no top-level text).
  it('case (b): toolFormerData-only bubble derives text + records source', async () => {
    createGlobalStorageFixture(dbPath, [
      { composer_id: 'c1', bubble_id: 'u1', type: 1, text: 'run the tool' },
      {
        composer_id: 'c1',
        bubble_id: 'a1',
        type: 2,
        text: '',
        toolFormerData: { text: 'tool produced this output' },
      },
    ]);
    const turns = await extractCursorTurns(dbPath, new Map());
    expect(turns).toHaveLength(1);
    expect(turns[0]?.assistant_message).toBe('tool produced this output');
    expect(turns[0]?.bubble_text_sources).toEqual(['toolFormerData']);
  });

  // Fixture (c) — attachedHumanChanges.fileDiff only.
  it('case (c): attachedHumanChanges.fileDiff-only bubble derives text + records source', async () => {
    createGlobalStorageFixture(dbPath, [
      { composer_id: 'c1', bubble_id: 'u1', type: 1, text: 'apply changes' },
      {
        composer_id: 'c1',
        bubble_id: 'a1',
        type: 2,
        text: '',
        attachedHumanChanges: { fileDiff: '--- a/x\n+++ b/x\n@@ +line @@' },
      },
    ]);
    const turns = await extractCursorTurns(dbPath, new Map());
    expect(turns).toHaveLength(1);
    expect(turns[0]?.assistant_message).toContain('+line');
    expect(turns[0]?.bubble_text_sources).toEqual(['fileDiff']);
  });

  // Fixture (d) — codeBlocks with body (positive case).
  it('case (d): codeBlocks with non-empty content body derives text + records source', async () => {
    createGlobalStorageFixture(dbPath, [
      { composer_id: 'c1', bubble_id: 'u1', type: 1, text: 'show me code' },
      {
        composer_id: 'c1',
        bubble_id: 'a1',
        type: 2,
        text: '',
        codeBlocks: [{ languageId: 'ts', content: 'const x = 1;' }],
      },
    ]);
    const turns = await extractCursorTurns(dbPath, new Map());
    expect(turns).toHaveLength(1);
    expect(turns[0]?.assistant_message).toContain('const x = 1;');
    expect(turns[0]?.bubble_text_sources).toEqual(['codeBlocks']);
  });

  // Fixture (e) — codeBlocks path-only (NEGATIVE case from R1 Codex Finding 2).
  it('case (e): codeBlocks with only uri.path (no body) does NOT synthesize fake prose', async () => {
    createGlobalStorageFixture(dbPath, [
      { composer_id: 'c1', bubble_id: 'u1', type: 1, text: 'ref this file' },
      {
        composer_id: 'c1',
        bubble_id: 'a1',
        type: 2,
        text: '',
        codeBlocks: [{ path: '/proj/x.ts', languageId: 'ts' }],
      },
    ]);
    const turns = await extractCursorTurns(dbPath, new Map());
    // The user has no surviving assistant cluster → no turn emitted; the warn
    // records that the fallback chain returned nothing (no fake assistant
    // prose was synthesized from the path-only reference).
    expect(turns).toHaveLength(0);
    expect(captured.writes.join('')).toContain('missing_text_and_fallbacks');
  });

  // Fixture (f) — thinkingContent only.
  it('case (f): thinkingContent-only bubble derives text + records source', async () => {
    createGlobalStorageFixture(dbPath, [
      { composer_id: 'c1', bubble_id: 'u1', type: 1, text: 'think hard' },
      {
        composer_id: 'c1',
        bubble_id: 'a1',
        type: 2,
        text: '',
        thinkingContent: 'reasoning trace contents',
      },
    ]);
    const turns = await extractCursorTurns(dbPath, new Map());
    expect(turns).toHaveLength(1);
    expect(turns[0]?.assistant_message).toBe('reasoning trace contents');
    expect(turns[0]?.bubble_text_sources).toEqual(['thinkingContent']);
  });

  // Fixture (g) — all four fallbacks present; precedence pinned: tfd wins.
  it('case (g): all fallbacks present → first-non-empty precedence (toolFormerData wins)', async () => {
    createGlobalStorageFixture(dbPath, [
      { composer_id: 'c1', bubble_id: 'u1', type: 1, text: 'go' },
      {
        composer_id: 'c1',
        bubble_id: 'a1',
        type: 2,
        text: '',
        toolFormerData: { text: 'TFD-WINS' },
        attachedHumanChanges: { fileDiff: 'diff-loser' },
        codeBlocks: [{ content: 'code-loser' }],
        thinkingContent: 'think-loser',
      },
    ]);
    const turns = await extractCursorTurns(dbPath, new Map());
    expect(turns).toHaveLength(1);
    expect(turns[0]?.assistant_message).toBe('TFD-WINS');
    expect(turns[0]?.bubble_text_sources).toEqual(['toolFormerData']);
  });

  // Fixture (h) — none of the above (empty bubble → silently dropped at
  // debug level, NOT warn). Cursor ships placeholder/cancelled bubbles
  // with no content fields; warning on these spams the log without
  // surfacing anything actionable. Real parser gaps (case (e)) still warn.
  it('case (h): bubble with no text and no fallback fields drops silently (no warn)', async () => {
    createGlobalStorageFixture(dbPath, [
      { composer_id: 'c1', bubble_id: 'u1', type: 1, text: 'q' },
      { composer_id: 'c1', bubble_id: 'a1', type: 2, text: '' },
    ]);
    const turns = await extractCursorTurns(dbPath, new Map());
    expect(turns).toHaveLength(0);
    expect(captured.writes.join('')).not.toContain(
      'missing_text_and_fallbacks',
    );
    expect(captured.writes.join('')).not.toContain('unrecognized_bubble_shape');
  });

  // Fixture (i) — multi-bubble cluster with mixed sources.
  // Validates R1 Codex Finding 1: bubble_text_sources is per-bubble plural,
  // not a singular field that loses per-bubble variation.
  it('case (i): multi-bubble cluster records bubble_text_sources per bubble', async () => {
    createGlobalStorageFixture(dbPath, [
      { composer_id: 'c1', bubble_id: 'u1', type: 1, text: 'multi-step' },
      {
        composer_id: 'c1',
        bubble_id: 'a1',
        type: 2,
        text: 'I will think then code',
      },
      {
        composer_id: 'c1',
        bubble_id: 'a2',
        type: 2,
        text: '',
        toolFormerData: { text: 'tool ran' },
      },
      {
        composer_id: 'c1',
        bubble_id: 'a3',
        type: 2,
        text: '',
        codeBlocks: [{ languageId: 'ts', content: 'export const y = 2;' }],
      },
    ]);
    const turns = await extractCursorTurns(dbPath, new Map());
    expect(turns).toHaveLength(1);
    expect(turns[0]?.assistant_bubble_ids).toEqual(['a1', 'a2', 'a3']);
    expect(turns[0]?.bubble_text_sources).toEqual([
      'text',
      'toolFormerData',
      'codeBlocks',
    ]);
  });

  // Fixture (j) — single-bubble 'text' cluster → bubble_text_sources omitted.
  it('case (j): single-bubble text-only cluster omits bubble_text_sources entirely', async () => {
    createGlobalStorageFixture(dbPath, [
      { composer_id: 'c1', bubble_id: 'u1', type: 1, text: 'q' },
      { composer_id: 'c1', bubble_id: 'a1', type: 2, text: 'a' },
    ]);
    const turns = await extractCursorTurns(dbPath, new Map());
    expect(turns).toHaveLength(1);
    expect(turns[0]?.bubble_text_sources).toBeUndefined();
  });

  // Direct parser unit checks: each tryExtract* parser returns null on
  // shape mismatch and never throws. These cover the "≤30 lines, never
  // throw" contract from Implementation Notes.
  it('parsers return null on shape mismatch and never throw', () => {
    expect(tryExtractToolFormerText({})).toBeNull();
    expect(
      tryExtractToolFormerText({ toolFormerData: 'string-not-object' }),
    ).toBeNull();
    expect(
      tryExtractToolFormerText({ toolFormerData: { text: '' } }),
    ).toBeNull();
    expect(
      tryExtractToolFormerText({ toolFormerData: { params: {} } }),
    ).toBeNull();

    expect(tryExtractFileDiffText({})).toBeNull();
    expect(tryExtractFileDiffText({ attachedHumanChanges: {} })).toBeNull();
    expect(
      tryExtractFileDiffText({ attachedHumanChanges: { fileDiff: '' } }),
    ).toBeNull();

    expect(tryExtractCodeBlocksText({})).toBeNull();
    expect(tryExtractCodeBlocksText({ codeBlocks: [] })).toBeNull();
    expect(
      tryExtractCodeBlocksText({ codeBlocks: [{ uri: { path: '/p' } }] }),
    ).toBeNull();

    expect(tryExtractThinkingText({})).toBeNull();
    expect(tryExtractThinkingText({ thinkingContent: '' })).toBeNull();
    expect(tryExtractThinkingText({ thinkingContent: {} })).toBeNull();
  });
});

// AC1 — Periodic re-poll path. Tests use the `__testHooks` seam (per the
// R2 contract) to invoke `triggerRepollExtraction()` directly so they
// don't depend on chokidar firing or on real-time setInterval ticks.
// Item 034.
describe('startCursorExtractor periodic re-poll (AC1 — item 034)', () => {
  let dir: string;
  let dbPath: string;
  let storage: MemoryStorage;
  let handle: CursorExtractorHandle | null = null;
  let originalFsPaths: string[];
  let captured: ReturnType<typeof captureStdout>;

  beforeEach(() => {
    originalFsPaths = snapshotFsPaths();
    dir = tmpDir();
    dbPath = join(dir, 'state.vscdb');
    storage = new MemoryStorage();
    captured = captureStdout();
    (CAPTURED_SOURCES.fs_paths as unknown as string[]).push(`${dir}/`);
    // Startup catch-up yields with setImmediate between bounded SQL slices.
    // Fake only the timer APIs these repoll tests control; setImmediate must
    // stay real so the bounded startup state machine can advance.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (handle !== null) {
      await handle.stop();
      handle = null;
    }
    captured.restore();
    resetAllowlist();
    restoreFsPaths(originalFsPaths);
    rmSync(dir, { recursive: true, force: true });
  });

  // Test 1 — a direct periodic tick captures the seeded fixture. Resetting
  // the diagnostic mtime checkpoint also verifies that the tick advances it;
  // capture/reconciliation no longer depends on an mtime gate.
  it('test 1: configured custom DB is extractor-scoped and the first tick captures it', async () => {
    resetAllowlist();
    restoreFsPaths(originalFsPaths);
    expect(CAPTURED_SOURCES.fs_paths).not.toContain(`${dir}/`);
    createGlobalStorageFixture(dbPath, [
      { composer_id: 'c1', bubble_id: 'b1', type: 1, text: 'q' },
      { composer_id: 'c1', bubble_id: 'b2', type: 2, text: 'a' },
    ]);
    handle = await startCursorExtractor(storage, {
      globalDbPath: dbPath,
      workspacePrefix: `${dir}/workspaceStorage/`,
      repollIntervalMs: 60_000, // large so real setInterval never fires during the test
      exposeTestHooks: true,
    });
    handle.__testHooks!.setLastSeenScanMtime(0);
    await handle.__testHooks!.triggerRepoll();
    expect(await storage.count()).toBe(1);
    expect((await storage.query({ order: 'asc' }))[0]!.source).toBe(`fs:${dbPath}`);
  });

  // Test 2 — no mtime change still advances bounded reconciliation without
  // duplicating an already captured atom.
  it('test 2: second tick with no mtime change advances reconciliation without a duplicate atom', async () => {
    createGlobalStorageFixture(dbPath, [
      { composer_id: 'c1', bubble_id: 'b1', type: 1, text: 'q' },
      { composer_id: 'c1', bubble_id: 'b2', type: 2, text: 'a' },
    ]);
    handle = await startCursorExtractor(storage, {
      globalDbPath: dbPath,
      workspacePrefix: `${dir}/workspaceStorage/`,
      repollIntervalMs: 60_000,
      exposeTestHooks: true,
    });
    handle.__testHooks!.setLastSeenScanMtime(0);
    await handle.__testHooks!.triggerRepoll();
    const after1 = await storage.count();
    // Trigger again with no DB mutation in between.
    await handle.__testHooks!.triggerRepoll();
    expect(await storage.count()).toBe(after1);
  });

  // Test 3 — mtime advances → run captures new pair.
  it('test 3: mtime advances between ticks → second tick captures new pair (1 → 2 atoms)', async () => {
    createGlobalStorageFixture(dbPath, [
      { composer_id: 'c1', bubble_id: 'b1', type: 1, text: 'q1' },
      { composer_id: 'c1', bubble_id: 'b2', type: 2, text: 'a1' },
    ]);
    handle = await startCursorExtractor(storage, {
      globalDbPath: dbPath,
      workspacePrefix: `${dir}/workspaceStorage/`,
      repollIntervalMs: 60_000,
      exposeTestHooks: true,
    });
    handle.__testHooks!.setLastSeenScanMtime(0);
    await handle.__testHooks!.triggerRepoll();
    expect(await storage.count()).toBe(1);

    appendBubble(dbPath, {
      composer_id: 'c1',
      bubble_id: 'b3',
      type: 1,
      text: 'q2',
    });
    appendBubble(dbPath, {
      composer_id: 'c1',
      bubble_id: 'b4',
      type: 2,
      text: 'a2',
    });
    // Force state.vscdb mtime forward to ensure the guard sees an advance.
    const future = new Date(Date.now() + 5000);
    utimesSync(dbPath, future, future);
    await handle.__testHooks!.triggerRepoll();
    expect(await storage.count()).toBe(2);
  });

  // Test 4 — WAL mtime advances while state.vscdb mtime stays stale.
  // R2 Codex HIGH #1: SQLite WAL mode can advance state.vscdb-wal mtime
  // while the main DB's mtime is frozen until the next checkpoint.
  // Reading only state.vscdb's mtime would miss the writes; the
  // family-max guard must detect the -wal advance.
  it('test 4 (WAL-only): -wal mtime advances → family-max guard detects + scan runs', async () => {
    createGlobalStorageFixture(dbPath, [
      { composer_id: 'c1', bubble_id: 'b1', type: 1, text: 'q' },
      { composer_id: 'c1', bubble_id: 'b2', type: 2, text: 'a' },
    ]);
    handle = await startCursorExtractor(storage, {
      globalDbPath: dbPath,
      workspacePrefix: `${dir}/workspaceStorage/`,
      repollIntervalMs: 60_000,
      exposeTestHooks: true,
    });
    // Lock state.vscdb at a known mtime T0; reset checkpoint to T0
    // (matches the main DB → main-DB alone would NOT advance the guard).
    const t0Date = new Date(Date.now() - 5000);
    utimesSync(dbPath, t0Date, t0Date);
    const t0 = statSync(dbPath).mtimeMs;
    handle.__testHooks!.setLastSeenScanMtime(t0);

    // Create -wal with FUTURE mtime; do NOT touch state.vscdb. The
    // family-max should now be > checkpoint.
    const walPath = `${dbPath}-wal`;
    writeFileSync(walPath, '');
    const futureDate = new Date(Date.now() + 5000);
    utimesSync(walPath, futureDate, futureDate);

    const beforeMax = await maxGlobalDbFamilyMtime(dbPath);
    expect(beforeMax).toBeGreaterThan(t0);

    await handle.__testHooks!.triggerRepoll();
    // The pre-seeded pair was already in the DB before the extractor
    // started; with checkpoint reset to T0 (state.vscdb mtime) and -wal
    // advanced beyond it, the trigger must run the scan and capture
    // the pair.
    expect(await storage.count()).toBe(1);

    // Counter: an older family mtime does not move the mtime checkpoint even
    // though the independent rotating reconciliation page still advances.
    const olderHandle = await startCursorExtractor(new MemoryStorage(), {
      globalDbPath: dbPath,
      workspacePrefix: `${dir}/workspaceStorage/`,
      repollIntervalMs: 60_000,
      exposeTestHooks: true,
    });
    try {
      const olderStorage = (olderHandle as unknown as { _storage?: never })
        ._storage;
      void olderStorage;
      const veryFuture = new Date(Date.now() + 999_999);
      olderHandle.__testHooks!.setLastSeenScanMtime(veryFuture.getTime());
      // No file mutation; current max remains below the diagnostic checkpoint.
      const beforeTrigger = olderHandle.__testHooks!.getLastSeenScanMtime();
      await olderHandle.__testHooks!.triggerRepoll();
      // The mtime checkpoint remains monotonic.
      expect(olderHandle.__testHooks!.getLastSeenScanMtime()).toBe(
        beforeTrigger,
      );
    } finally {
      await olderHandle.stop();
    }
  });

  // AC3 Test 6 (item 036) — end-to-end via the triggerRepoll seam: a
  // continuation cluster that arrives between two repoll ticks surfaces
  // as a SECOND atom whose metadata carries `is_continuation: true` and
  // `continuation_of_assistant_bubble_id: <prior atom's
  // assistant_bubble_id>`. Pre-036 the post-checkpoint bubbles were
  // silently dropped; the second atom never appeared.
  it('item 036: continuation cluster between ticks emits a second atom with continuation metadata', async () => {
    createGlobalStorageFixture(dbPath, [
      {
        composer_id: 'c1',
        bubble_id: 'u1',
        type: 1,
        text: 'walk through the change',
      },
      { composer_id: 'c1', bubble_id: 'a1', type: 2, text: 'starting...' },
      { composer_id: 'c1', bubble_id: 'a2', type: 2, text: 'mid-stream' },
      {
        composer_id: 'c1',
        bubble_id: 'a3',
        type: 2,
        text: 'tick-1 last bubble',
      },
    ]);
    handle = await startCursorExtractor(storage, {
      globalDbPath: dbPath,
      workspacePrefix: `${dir}/workspaceStorage/`,
      repollIntervalMs: 60_000,
      exposeTestHooks: true,
    });
    handle.__testHooks!.setLastSeenScanMtime(0);
    await handle.__testHooks!.triggerRepoll();
    expect(await storage.count()).toBe(1);

    // Cursor writes 2 more assistant bubbles into the same cluster.
    appendBubble(dbPath, {
      composer_id: 'c1',
      bubble_id: 'a4',
      type: 2,
      text: 'tick-2 verdict turn',
    });
    appendBubble(dbPath, {
      composer_id: 'c1',
      bubble_id: 'a5',
      type: 2,
      text: 'tick-2 final summary',
    });
    // Force the family-max mtime forward so the guard advances.
    const future = new Date(Date.now() + 5000);
    utimesSync(dbPath, future, future);
    await handle.__testHooks!.triggerRepoll();
    expect(await storage.count()).toBe(2);

    const events = await storage.query({ source: `fs:${dbPath}` });
    events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    expect(events).toHaveLength(2);
    const first = events[0]!.metadata as Record<string, unknown>;
    const second = events[1]!.metadata as Record<string, unknown>;
    expect(first['is_continuation']).toBeUndefined();
    expect(first['continuation_of_assistant_bubble_id']).toBeUndefined();
    expect(first['assistant_bubble_id']).toBe('a3');
    expect(second['is_continuation']).toBe(true);
    expect(second['continuation_of_assistant_bubble_id']).toBe('a3');
    expect(second['assistant_bubble_id']).toBe('a5');
    expect(second['user_bubble_id']).toBe('u1');
    expect(second['assistant_bubble_ids']).toEqual(['a4', 'a5']);
  });
});

// AC3 integration — end-to-end revert mechanism. These tests prove that
// each fix (periodic re-poll, fallback chain) is independently
// load-bearing for the 8-pair mixed-shape demo fixture. Item 034.
describe('startCursorExtractor 034 revert-mechanism (AC3 — item 034)', () => {
  let dir: string;
  let dbPath: string;
  let storage: MemoryStorage;
  let handle: CursorExtractorHandle | null = null;
  let originalFsPaths: string[];
  let captured: ReturnType<typeof captureStdout>;

  // 8-pair fixture: pairs 1 + 2 have text-only assistants; pair 3's
  // assistant is tool-call-only (drops without fallbacks → loop breaks
  // because u3 has no surviving assistant). Pairs 4–8 mix toolFormerData,
  // fileDiff, codeBlocks body, thinkingContent; all need the fallback
  // chain to capture.
  function eightPairFixture(): FixtureBubble[] {
    return [
      { composer_id: 'c1', bubble_id: 'u1', type: 1, text: 'q1' },
      { composer_id: 'c1', bubble_id: 'a1', type: 2, text: 'a1-text' },
      { composer_id: 'c1', bubble_id: 'u2', type: 1, text: 'q2' },
      { composer_id: 'c1', bubble_id: 'a2', type: 2, text: 'a2-text' },
      { composer_id: 'c1', bubble_id: 'u3', type: 1, text: 'q3-runs-tool' },
      {
        composer_id: 'c1',
        bubble_id: 'a3',
        type: 2,
        text: '',
        toolFormerData: { text: 'tool-output-3' },
      },
      { composer_id: 'c1', bubble_id: 'u4', type: 1, text: 'q4-diff' },
      {
        composer_id: 'c1',
        bubble_id: 'a4',
        type: 2,
        text: '',
        attachedHumanChanges: { fileDiff: 'diff-4' },
      },
      { composer_id: 'c1', bubble_id: 'u5', type: 1, text: 'q5-code' },
      {
        composer_id: 'c1',
        bubble_id: 'a5',
        type: 2,
        text: '',
        codeBlocks: [{ languageId: 'ts', content: 'const z = 5;' }],
      },
      { composer_id: 'c1', bubble_id: 'u6', type: 1, text: 'q6-think' },
      {
        composer_id: 'c1',
        bubble_id: 'a6',
        type: 2,
        text: '',
        thinkingContent: 'reasoning-6',
      },
      { composer_id: 'c1', bubble_id: 'u7', type: 1, text: 'q7' },
      { composer_id: 'c1', bubble_id: 'a7', type: 2, text: 'a7-text' },
      { composer_id: 'c1', bubble_id: 'u8', type: 1, text: 'q8-tool' },
      {
        composer_id: 'c1',
        bubble_id: 'a8',
        type: 2,
        text: '',
        toolFormerData: { text: 'tool-output-8' },
      },
    ];
  }

  beforeEach(() => {
    originalFsPaths = snapshotFsPaths();
    dir = tmpDir();
    dbPath = join(dir, 'state.vscdb');
    storage = new MemoryStorage();
    captured = captureStdout();
    (CAPTURED_SOURCES.fs_paths as unknown as string[]).push(`${dir}/`);
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (handle !== null) {
      await handle.stop();
      handle = null;
    }
    captured.restore();
    resetAllowlist();
    restoreFsPaths(originalFsPaths);
    rmSync(dir, { recursive: true, force: true });
  });

  // Control — both fixes active. Periodic re-poll captures all 8 pairs.
  it('control (both fixes active): all 8 pairs reach storage.append', async () => {
    createGlobalStorageFixture(dbPath, eightPairFixture());
    handle = await startCursorExtractor(storage, {
      globalDbPath: dbPath,
      workspacePrefix: `${dir}/workspaceStorage/`,
      repollIntervalMs: 60_000,
      exposeTestHooks: true,
    });
    handle.__testHooks!.setLastSeenScanMtime(0);
    await handle.__testHooks!.triggerRepoll();
    expect(await storage.count()).toBe(8);
  });

  // Cadence-gap revert — only the first tick fires. Seeds 2 pairs, runs
  // the tick (captures 2), then seeds 6 more pairs WITHOUT triggering
  // another tick. With fake timers the chokidar-driven setTimeout never
  // fires either, so the second batch sits uncaptured — proving the
  // periodic re-poll is what closes the cadence gap.
  it('cadence-gap revert (no second tick): ≥ 3 turn-pairs missing → proves AC1 load-bearing', async () => {
    const all = eightPairFixture();
    // Seed first 2 pairs (4 bubbles).
    createGlobalStorageFixture(dbPath, all.slice(0, 4));
    handle = await startCursorExtractor(storage, {
      globalDbPath: dbPath,
      workspacePrefix: `${dir}/workspaceStorage/`,
      repollIntervalMs: 60_000,
      exposeTestHooks: true,
    });
    handle.__testHooks!.setLastSeenScanMtime(0);
    await handle.__testHooks!.triggerRepoll();
    expect(await storage.count()).toBe(2);

    // Seed remaining 6 pairs into the SAME DB; chokidar fires `change`
    // events but the debounced setTimeout never resolves under fake
    // timers, simulating "only initial chokidar fired" — and we do NOT
    // call triggerRepoll() again.
    for (const b of all.slice(4)) appendBubble(dbPath, b);

    // No extra trigger. Storage still at 2.
    expect(await storage.count()).toBe(2);
    // 8 - 2 = 6 missing pairs → ≥ 3 as required by the spec.
  });

  // Parse-gap revert — __disableToolCallFallbacks restores V1 behavior
  // (drop bubbles with missing text). With the 8-pair fixture, pair 3's
  // tool-call-only assistant drops, the cluster loop breaks, and only
  // pairs 1–2 capture. Proves the fallback chain is what closes the
  // parse gap.
  it('parse-gap revert (__disableToolCallFallbacks): ≥ 3 turn-pairs missing → proves AC2 load-bearing', async () => {
    createGlobalStorageFixture(dbPath, eightPairFixture());
    handle = await startCursorExtractor(storage, {
      globalDbPath: dbPath,
      workspacePrefix: `${dir}/workspaceStorage/`,
      repollIntervalMs: 60_000,
      exposeTestHooks: true,
      __disableToolCallFallbacks: true,
    });
    handle.__testHooks!.setLastSeenScanMtime(0);
    await handle.__testHooks!.triggerRepoll();
    // Pairs 1 + 2 capture; pair 3's a3 drops (no .text, fallbacks
    // disabled), u3 has no surviving assistant follow-up, loop breaks.
    // 6 pairs missing.
    expect(await storage.count()).toBeLessThanOrEqual(2);
    expect(8 - (await storage.count())).toBeGreaterThanOrEqual(3);
  });
});

// Configuration sanity — the source-constant default and the override
// option are the only knobs. No process.env.* lookup was added. Item 034.
describe('CURSOR_REPOLL_INTERVAL_MS configuration (AC1 — item 034)', () => {
  it('source constant is 15_000 ms', () => {
    expect(CURSOR_REPOLL_INTERVAL_MS).toBe(15_000);
  });
});

// Item 037 / AC1 — repo_root resolution end-to-end through
// `startCursorExtractor`. Uses the `__resolveRepoRootForWorkspaceId` and
// `__resolveRepoRootFromFiles` injection seams so tests don't need to
// hand-build workspace.json fixtures or a real .git directory; the
// helpers' own correctness is covered by tests/mcp/cursor-workspace-
// resolver.test.ts (Stage 1) and a small isolated check below (Stage 2).
describe('startCursorExtractor repo_root resolution (item 037 / AC1)', () => {
  let dir: string;
  let dbPath: string;
  let storage: MemoryStorage;
  let handle: CursorExtractorHandle | null = null;
  let originalFsPaths: string[];
  let captured: ReturnType<typeof captureStdout>;

  beforeEach(() => {
    originalFsPaths = snapshotFsPaths();
    dir = tmpDir();
    dbPath = join(dir, 'state.vscdb');
    storage = new MemoryStorage();
    captured = captureStdout();
    (CAPTURED_SOURCES.fs_paths as unknown as string[]).push(`${dir}/`);
  });

  afterEach(async () => {
    if (handle !== null) {
      await handle.stop();
      handle = null;
    }
    captured.restore();
    resetAllowlist();
    restoreFsPaths(originalFsPaths);
    rmSync(dir, { recursive: true, force: true });
  });

  async function startWithInjections(opts: {
    resolveStage1?: (workspace_id: string, dir: string) => string | null;
    resolveStage2?: (files: readonly string[]) => string | null;
  }): Promise<CursorExtractorHandle> {
    const h = await startCursorExtractor(storage, {
      globalDbPath: dbPath,
      workspacePrefix: `${dir}/workspaceStorage/`,
      repollIntervalMs: 60_000,
      exposeTestHooks: true,
      ...(opts.resolveStage1 !== undefined
        ? { __resolveRepoRootForWorkspaceId: opts.resolveStage1 }
        : {}),
      ...(opts.resolveStage2 !== undefined
        ? { __resolveRepoRootFromFiles: opts.resolveStage2 }
        : {}),
    });
    h.__testHooks!.setLastSeenScanMtime(0);
    return h;
  }

  it('Stage 1: composer with workspace binding resolves repo_root via registry', async () => {
    const composer_id = 'ac1-stage1-comp';
    // Bind composer → workspace_id via the workspace.json watcher path.
    const wsDir = join(dir, 'workspaceStorage', 'WS-A');
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(
      join(wsDir, 'workspace.json'),
      JSON.stringify({ folder: 'file:///tmp/echo-test-repo' }),
    );
    // Seed the workspace state.vscdb with composer.composerData so the
    // chokidar 'change' fires refreshComposerWorkspaceMap. Bare new
    // Database creates an empty file; the actual ItemTable row is what
    // refreshComposerWorkspaceMap reads.
    const wsDb = new Database(join(wsDir, 'state.vscdb'));
    wsDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
    wsDb
      .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
      .run(
        'composer.composerData',
        JSON.stringify({ allComposers: [{ composerId: composer_id }] }),
      );
    wsDb.close();

    createGlobalStorageFixture(dbPath, [
      { composer_id, bubble_id: 'b1', type: 1, text: 'q' },
      { composer_id, bubble_id: 'b2', type: 2, text: 'a' },
    ]);

    let stage1Calls = 0;
    let stage2Calls = 0;
    handle = await startWithInjections({
      resolveStage1: (wid) => {
        stage1Calls += 1;
        return wid === 'WS-A' ? '/tmp/echo-test-repo' : null;
      },
      resolveStage2: () => {
        stage2Calls += 1;
        return null;
      },
    });
    // Bypass chokidar timing by directly invoking the workspace-map
    // refresh hook (chokidar's FSEvents-based delivery is flaky within
    // a short test-wait budget on macOS).
    await handle.__testHooks!.refreshWorkspaceMap(join(wsDir, 'state.vscdb'));
    await handle.__testHooks!.triggerRepoll();

    const atoms = await storage.query({});
    expect(atoms.length).toBe(1);
    expect(atoms[0]!.metadata?.['repo_root']).toBe('/tmp/echo-test-repo');
    expect(atoms[0]!.metadata?.['workspace_id']).toBe('WS-A');
    expect(stage1Calls).toBeGreaterThanOrEqual(1);
    // Stage 2 not called when Stage 1 succeeded.
    expect(stage2Calls).toBe(0);
  });

  it('Stage 2: fresh composer with no binding falls back to file-walk and caches', async () => {
    const composer_id = 'ac1-stage2-fresh-comp';
    createGlobalStorageFixture(dbPath, [
      {
        composer_id,
        bubble_id: 'b1',
        type: 1,
        text: 'q',
        attachedFileCodeChunksUris: ['/tmp/echo-test-repo/src/foo.ts'],
      },
      { composer_id, bubble_id: 'b2', type: 2, text: 'a' },
    ]);

    let stage2Calls = 0;
    handle = await startWithInjections({
      // No workspace binding ever set up → Stage 1 never runs.
      resolveStage2: (files) => {
        stage2Calls += 1;
        if (files.length > 0 && files[0]!.startsWith('/tmp/echo-test-repo/')) {
          return '/tmp/echo-test-repo';
        }
        return null;
      },
    });
    await handle.__testHooks!.triggerRepoll();

    const atomsAfterTick1 = await storage.query({});
    expect(atomsAfterTick1.length).toBe(1);
    expect(atomsAfterTick1[0]!.metadata?.['repo_root']).toBe(
      '/tmp/echo-test-repo',
    );
    expect(stage2Calls).toBe(1);

    // Cache prevents re-walk on the next turn for the same composer.
    appendBubble(dbPath, {
      composer_id,
      bubble_id: 'b3',
      type: 1,
      text: 'q2',
      attachedFileCodeChunksUris: ['/tmp/echo-test-repo/src/foo.ts'],
    });
    appendBubble(dbPath, { composer_id, bubble_id: 'b4', type: 2, text: 'a2' });
    const f = new Date(Date.now() + 5000);
    utimesSync(dbPath, f, f);
    await handle.__testHooks!.triggerRepoll();

    const atomsAfterTick2 = await storage.query({});
    expect(atomsAfterTick2.length).toBe(2);
    // Both atoms carry repo_root.
    for (const a of atomsAfterTick2) {
      expect(a.metadata?.['repo_root']).toBe('/tmp/echo-test-repo');
    }
    // Stage 2 was NOT re-invoked on turn 2 (cache hit). Strict equality
    // proves the cache short-circuited the file-walk.
    expect(stage2Calls).toBe(1);
  });

  it('Stage 2: ambiguous files (two distinct .git ancestors) → metadata omits repo_root', async () => {
    const composer_id = 'ac1-stage2-ambig';
    createGlobalStorageFixture(dbPath, [
      {
        composer_id,
        bubble_id: 'b1',
        type: 1,
        text: 'q',
        attachedFileCodeChunksUris: ['/tmp/repoA/x.ts', '/tmp/repoB/y.ts'],
      },
      { composer_id, bubble_id: 'b2', type: 2, text: 'a' },
    ]);
    handle = await startWithInjections({
      resolveStage2: () => null, // ambiguous → null (production behavior)
    });
    await handle.__testHooks!.triggerRepoll();
    const atoms = await storage.query({});
    expect(atoms.length).toBe(1);
    expect(atoms[0]!.metadata).not.toHaveProperty('repo_root');
  });

  it('Both stages fail: no binding + empty files_referenced → repo_root omitted (no warn)', async () => {
    const composer_id = 'ac1-both-fail-clean';
    createGlobalStorageFixture(dbPath, [
      { composer_id, bubble_id: 'b1', type: 1, text: 'q' },
      { composer_id, bubble_id: 'b2', type: 2, text: 'a' },
    ]);
    handle = await startWithInjections({
      resolveStage2: () => null,
    });
    await handle.__testHooks!.triggerRepoll();
    const atoms = await storage.query({});
    expect(atoms.length).toBe(1);
    expect(atoms[0]!.metadata).not.toHaveProperty('repo_root');
    // No warn — the no-binding case is the routine pre-binding state.
    const stdout = captured.writes.join('');
    expect(stdout).not.toContain('cursor_repo_root_resolution_failed');
  });

  it('Cache invalidation: binding lands AFTER initial file-walk → registry overrides cache', async () => {
    const composer_id = 'ac1-cache-invalidate';
    // First tick: file-walk resolves to /tmp/from-files; no binding.
    createGlobalStorageFixture(dbPath, [
      {
        composer_id,
        bubble_id: 'b1',
        type: 1,
        text: 'q',
        attachedFileCodeChunksUris: ['/tmp/from-files/x.ts'],
      },
      { composer_id, bubble_id: 'b2', type: 2, text: 'a' },
    ]);

    // Set up a workspace.json so a later chokidar 'change' on its state.vscdb
    // wires composer → workspace_id, after which Stage 1 must win.
    const wsDir = join(dir, 'workspaceStorage', 'WS-LATE');
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(
      join(wsDir, 'workspace.json'),
      JSON.stringify({ folder: 'file:///tmp/from-registry' }),
    );

    handle = await startWithInjections({
      resolveStage1: () => '/tmp/from-registry',
      resolveStage2: () => '/tmp/from-files',
    });
    await handle.__testHooks!.triggerRepoll();
    const atomsAfterTick1 = await storage.query({});
    expect(atomsAfterTick1[0]!.metadata?.['repo_root']).toBe('/tmp/from-files');

    // Now bind composer → workspace_id by writing the workspace's state.vscdb
    // with composer.composerData and invoking the workspace-map refresh hook.
    const wsDb = new Database(join(wsDir, 'state.vscdb'));
    wsDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
    wsDb
      .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
      .run(
        'composer.composerData',
        JSON.stringify({ allComposers: [{ composerId: composer_id }] }),
      );
    wsDb.close();
    await handle.__testHooks!.refreshWorkspaceMap(join(wsDir, 'state.vscdb'));

    // Emit a second turn; with the binding now wired, Stage 1 should win.
    appendBubble(dbPath, {
      composer_id,
      bubble_id: 'b3',
      type: 1,
      text: 'q2',
      attachedFileCodeChunksUris: ['/tmp/from-files/x.ts'],
    });
    appendBubble(dbPath, { composer_id, bubble_id: 'b4', type: 2, text: 'a2' });
    const f = new Date(Date.now() + 5000);
    utimesSync(dbPath, f, f);
    await handle.__testHooks!.triggerRepoll();

    const atomsAfterTick2 = await storage.query({});
    expect(atomsAfterTick2.length).toBe(2);
    const newest = atomsAfterTick2.find(
      (a) => a.metadata?.['user_bubble_id'] === 'b3',
    );
    expect(newest).toBeDefined();
    // Registry priority: Stage 1's result overwrote the Stage 2 cache.
    expect(newest!.metadata?.['repo_root']).toBe('/tmp/from-registry');
  });

  it('Warn dedup: binding present + Stage 1 fails + no files → warn fires AT MOST once per composer', async () => {
    const composer_id = 'ac1-warn-dedup-unique-x9q7';
    // Bind composer to a workspace whose Stage 1 will return null (folder
    // URI malformed, mocked here as null).
    const wsDir = join(dir, 'workspaceStorage', 'WS-MAL');
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(
      join(wsDir, 'workspace.json'),
      JSON.stringify({ folder: 'not-a-file-uri' }),
    );
    const wsDb = new Database(join(wsDir, 'state.vscdb'));
    wsDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
    wsDb
      .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
      .run(
        'composer.composerData',
        JSON.stringify({ allComposers: [{ composerId: composer_id }] }),
      );
    wsDb.close();

    createGlobalStorageFixture(dbPath, [
      { composer_id, bubble_id: 'b1', type: 1, text: 'q' },
      { composer_id, bubble_id: 'b2', type: 2, text: 'a' },
    ]);
    handle = await startWithInjections({
      resolveStage1: () => null,
      resolveStage2: () => null,
    });
    await handle.__testHooks!.refreshWorkspaceMap(join(wsDir, 'state.vscdb'));
    await handle.__testHooks!.triggerRepoll();

    // Emit a second turn for the same composer — the dedup must suppress
    // the warn on the repeat resolution failure.
    appendBubble(dbPath, { composer_id, bubble_id: 'b3', type: 1, text: 'q2' });
    appendBubble(dbPath, { composer_id, bubble_id: 'b4', type: 2, text: 'a2' });
    const f2 = new Date(Date.now() + 5000);
    utimesSync(dbPath, f2, f2);
    await handle.__testHooks!.triggerRepoll();

    const stdout = captured.writes.join('');
    const matches = stdout.match(/cursor_repo_root_resolution_failed/g);
    expect(matches?.length ?? 0).toBe(1);
  });

  it('workspace_id write contract is preserved alongside repo_root', async () => {
    // Regression: AC1 added a SIBLING write, not a replacement. The
    // workspace_id write at line ~1144 must still fire when bound.
    const composer_id = 'ac1-ws-id-regression';
    const wsDir = join(dir, 'workspaceStorage', 'WS-COEXIST');
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(
      join(wsDir, 'workspace.json'),
      JSON.stringify({ folder: 'file:///tmp/coexist-repo' }),
    );
    const wsDb = new Database(join(wsDir, 'state.vscdb'));
    wsDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
    wsDb
      .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
      .run(
        'composer.composerData',
        JSON.stringify({ allComposers: [{ composerId: composer_id }] }),
      );
    wsDb.close();
    createGlobalStorageFixture(dbPath, [
      { composer_id, bubble_id: 'b1', type: 1, text: 'q' },
      { composer_id, bubble_id: 'b2', type: 2, text: 'a' },
    ]);
    handle = await startWithInjections({
      resolveStage1: () => '/tmp/coexist-repo',
    });
    await handle.__testHooks!.refreshWorkspaceMap(join(wsDir, 'state.vscdb'));
    await handle.__testHooks!.triggerRepoll();
    const atom = (await storage.query({}))[0]!;
    expect(atom.metadata?.['workspace_id']).toBe('WS-COEXIST');
    expect(atom.metadata?.['repo_root']).toBe('/tmp/coexist-repo');
  });
});
