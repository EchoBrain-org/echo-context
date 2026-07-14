import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GranolaApiError,
  granolaCheckpointPath,
  granolaConfigPath,
  loadGranolaCheckpoint,
  pollGranolaOnce,
  resolveGranolaApiKey,
  startGranolaPoller,
  writeGranolaCheckpoint,
  type GranolaApiClient,
  type GranolaListParams,
  type GranolaListResponse,
  type GranolaNoteDetail,
} from '../../src/capture/surfaces/granola-poller.js';
import { MemoryStorage } from '../../src/storage/memory.js';
import { captureStdout } from '../fixtures/stdout.js';

type ListStep = GranolaListResponse | Error | (() => Promise<GranolaListResponse>);
type DetailStep = GranolaNoteDetail | Error | (() => Promise<GranolaNoteDetail>);

class MockGranolaClient implements GranolaApiClient {
  readonly listCalls: GranolaListParams[] = [];
  readonly detailCalls: string[] = [];

  constructor(
    private readonly listQueue: ListStep[],
    private readonly details: Map<string, DetailStep> = new Map(),
  ) {}

  async listNotes(params: GranolaListParams): Promise<GranolaListResponse> {
    this.listCalls.push(params);
    const next = this.listQueue.shift();
    if (next === undefined) throw new Error('unexpected listNotes call');
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return await next();
    return next;
  }

  async getNote(noteId: string): Promise<GranolaNoteDetail> {
    this.detailCalls.push(noteId);
    const next = this.details.get(noteId);
    if (next === undefined) throw new Error(`unexpected getNote call: ${noteId}`);
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return await next();
    return next;
  }
}

function tempCheckpoint(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'echo-granola-'));
  return { dir, path: join(dir, 'granola-checkpoint.json') };
}

function detail(id: string, updatedAt: string): GranolaNoteDetail {
  return {
    id,
    title: `Meeting ${id}`,
    created_at: '2026-06-21T09:00:00.000Z',
    updated_at: updatedAt,
    summary_markdown: `## Meeting ${id}\n\nSummary body for ${id}.`,
    summary_text: `Summary body for ${id}.`,
    transcript: [
      {
        speaker: { name: 'Avery' },
        start_time: 0,
        end_time: 4,
        text: `Transcript body for ${id}.`,
      },
    ],
    attendees: [{ name: 'Avery' }],
    web_url: `https://granola.ai/notes/${id}`,
  };
}

function listResponse(
  ids: string[],
  opts: { hasMore?: boolean; cursor?: string | null; updatedBase?: string } = {},
): GranolaListResponse {
  const updatedBase = opts.updatedBase ?? '2026-06-21T10:00:00.000Z';
  return {
    notes: ids.map((id, index) => ({
      id,
      title: `Meeting ${id}`,
      created_at: '2026-06-21T09:00:00.000Z',
      updated_at: new Date(new Date(updatedBase).getTime() + index * 60_000).toISOString(),
    })),
    hasMore: opts.hasMore ?? false,
    cursor: opts.cursor ?? null,
  };
}

describe('Granola poller', () => {
  it('paginates notes and writes exactly two append-only atoms per note', async () => {
    const { dir, path } = tempCheckpoint();
    try {
      const store = new MemoryStorage();
      const client = new MockGranolaClient(
        [
          listResponse(['note-a'], { hasMore: true, cursor: 'cursor-2' }),
          listResponse(['note-b'], { updatedBase: '2026-06-21T11:00:00.000Z' }),
        ],
        new Map<string, DetailStep>([
          ['note-a', detail('note-a', '2026-06-21T10:00:00.000Z')],
          ['note-b', detail('note-b', '2026-06-21T11:00:00.000Z')],
        ]),
      );

      const result = await pollGranolaOnce(store, client, {
        checkpointPath: path,
        retryDelayMs: 0,
        now: () => '2026-06-21T12:00:00.000Z',
      });

      expect(result).toEqual({
        status: 'ok',
        notes_seen: 2,
        notes_ingested: 2,
        atoms_written: 4,
      });
      expect(client.listCalls).toEqual([
        { updated_after: undefined, cursor: undefined, page_size: 30 },
        { updated_after: undefined, cursor: 'cursor-2', page_size: 30 },
      ]);
      const atoms = await store.query({ source: 'api:granola', order: 'asc' });
      expect(atoms).toHaveLength(4);
      expect(atoms.map((a) => a.metadata?.['dedupe_key']).sort()).toEqual([
        'granola:note-a:summary',
        'granola:note-a:transcript',
        'granola:note-b:summary',
        'granola:note-b:transcript',
      ]);
      expect(atoms.every((a) => a.metadata?.['repo_root'] === undefined)).toBe(true);
      expect(
        atoms.find((a) => a.metadata?.['granola_atom_type'] === 'transcript')?.content,
      ).toContain('Avery: Transcript body');
      expect(loadGranolaCheckpoint(path).ingested_note_ids).toEqual(['note-a', 'note-b']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends updated_after from the checkpoint and skips edited notes already ingested', async () => {
    const { dir, path } = tempCheckpoint();
    try {
      writeGranolaCheckpoint(
        {
          schema_version: 1,
          high_water_mark: '2026-06-20T00:00:00.000Z',
          ingested_note_ids: ['note-a'],
          last_synced_at: '2026-06-20T00:00:00.000Z',
        },
        path,
      );
      const store = new MemoryStorage();
      const client = new MockGranolaClient([listResponse(['note-a'])]);

      const result = await pollGranolaOnce(store, client, {
        checkpointPath: path,
        retryDelayMs: 0,
        now: () => '2026-06-21T12:00:00.000Z',
      });

      expect(result).toEqual({
        status: 'ok',
        notes_seen: 1,
        notes_ingested: 0,
        atoms_written: 0,
      });
      expect(client.listCalls[0]?.updated_after).toBe('2026-06-20T00:00:00.000Z');
      expect(client.detailCalls).toEqual([]);
      expect(await store.count()).toBe(0);
      expect(loadGranolaCheckpoint(path).high_water_mark).toBe('2026-06-21T10:00:00.000Z');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recovers from a mid-batch failure without duplicating already-ingested note atoms', async () => {
    const { dir, path } = tempCheckpoint();
    try {
      const store = new MemoryStorage();
      const firstClient = new MockGranolaClient(
        [listResponse(['note-a', 'note-b'])],
        new Map<string, DetailStep>([
          ['note-a', detail('note-a', '2026-06-21T10:00:00.000Z')],
          ['note-b', new GranolaApiError('detail failed', 'api_failed')],
        ]),
      );

      const first = await pollGranolaOnce(store, firstClient, {
        checkpointPath: path,
        retryDelayMs: 0,
        now: () => '2026-06-21T12:00:00.000Z',
      });
      expect(first.status).toBe('error');
      expect(await store.count()).toBe(2);
      expect(loadGranolaCheckpoint(path)).toMatchObject({
        high_water_mark: null,
        ingested_note_ids: ['note-a'],
      });

      const secondClient = new MockGranolaClient(
        [listResponse(['note-a', 'note-b'])],
        new Map([['note-b', detail('note-b', '2026-06-21T10:01:00.000Z')]]),
      );
      const second = await pollGranolaOnce(store, secondClient, {
        checkpointPath: path,
        retryDelayMs: 0,
        now: () => '2026-06-21T12:01:00.000Z',
      });

      expect(second).toMatchObject({ status: 'ok', notes_ingested: 1, atoms_written: 2 });
      expect(secondClient.detailCalls).toEqual(['note-b']);
      const atoms = await store.query({ source: 'api:granola' });
      const noteIds = atoms.map((a) => a.metadata?.['note_id']);
      expect(noteIds.filter((id) => id === 'note-a')).toHaveLength(2);
      expect(noteIds.filter((id) => id === 'note-b')).toHaveLength(2);
      expect(loadGranolaCheckpoint(path).ingested_note_ids).toEqual(['note-a', 'note-b']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retries one 429 and logs a visible error on repeated 429', async () => {
    const { dir, path } = tempCheckpoint();
    try {
      const store = new MemoryStorage();
      const retryClient = new MockGranolaClient([
        new GranolaApiError('rate limited', 'rate_limited', 429),
        listResponse([]),
      ]);
      const retry = await pollGranolaOnce(store, retryClient, {
        checkpointPath: path,
        retryDelayMs: 0,
      });
      expect(retry.status).toBe('ok');
      expect(retryClient.listCalls).toHaveLength(2);

      const repeatedClient = new MockGranolaClient([
        new GranolaApiError('rate limited', 'rate_limited', 429),
        new GranolaApiError('rate limited again', 'rate_limited', 429),
      ]);
      const stdout = captureStdout();
      try {
        const repeated = await pollGranolaOnce(store, repeatedClient, {
          checkpointPath: path,
          retryDelayMs: 0,
        });
        expect(repeated).toMatchObject({ status: 'error', reason: 'rate_limited' });
      } finally {
        stdout.restore();
      }
      expect(stdout.writes.join('')).toContain('rate_limited_repeated');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('surfaces pagination failures, timeout failures, and checkpoint write failures', async () => {
    const { dir, path } = tempCheckpoint();
    try {
      const store = new MemoryStorage();
      const stdout = captureStdout();
      try {
        const pagination = await pollGranolaOnce(
          store,
          new MockGranolaClient([{ notes: [], hasMore: true, cursor: null }]),
          { checkpointPath: path, retryDelayMs: 0 },
        );
        expect(pagination).toMatchObject({ status: 'error', reason: 'pagination_failed' });

        const timeoutPath = join(dir, 'timeout-checkpoint.json');
        const timeout = await pollGranolaOnce(
          store,
          new MockGranolaClient([new GranolaApiError('hung request', 'timeout')]),
          { checkpointPath: timeoutPath, retryDelayMs: 0 },
        );
        expect(timeout).toMatchObject({ status: 'error', reason: 'timeout' });
        expect(existsSync(timeoutPath)).toBe(false);

        const blocker = join(dir, 'blocker');
        writeFileSync(blocker, 'not a directory');
        const checkpointFailure = await pollGranolaOnce(
          store,
          new MockGranolaClient([listResponse([])]),
          { checkpointPath: join(blocker, 'checkpoint.json'), retryDelayMs: 0 },
        );
        expect(checkpointFailure).toMatchObject({
          status: 'error',
          reason: 'checkpoint_failed',
        });
      } finally {
        stdout.restore();
      }
      const logs = stdout.writes.join('');
      expect(logs).toContain('pagination_failed');
      expect(logs).toContain('request_timeout');
      expect(logs).toContain('checkpoint_write_failed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows at most one poll in flight', async () => {
    const { dir, path } = tempCheckpoint();
    try {
      let release: (value: GranolaListResponse) => void = () => {};
      const blocked = new Promise<GranolaListResponse>((resolve) => {
        release = resolve;
      });
      const store = new MemoryStorage();
      const client = new MockGranolaClient([() => blocked]);
      const handle = startGranolaPoller(store, {
        client,
        checkpointPath: path,
        pollIntervalMs: 60_000,
        runOnStart: false,
        retryDelayMs: 0,
      });
      try {
        const first = handle.poll();
        const second = await handle.poll();
        expect(second).toEqual({ status: 'skipped', reason: 'in_flight' });
        release(listResponse([]));
        expect(await first).toMatchObject({ status: 'ok' });
        expect(client.listCalls).toHaveLength(1);
      } finally {
        await handle.stop();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves config paths without literal tilde and disables visibly when no key exists', async () => {
    expect(granolaCheckpointPath()).not.toContain('~');
    expect(granolaConfigPath()).not.toContain('~');

    const { dir } = tempCheckpoint();
    try {
      const configPath = join(dir, 'granola.json');
      writeFileSync(configPath, `${JSON.stringify({ api_key: 'grn_configKey' })}\n`);
      expect(resolveGranolaApiKey({}, configPath)).toEqual({
        enabled: true,
        apiKey: 'grn_configKey',
        source: 'config',
      });
      expect(resolveGranolaApiKey({ GRANOLA_API_KEY: 'grn_envKey' }, configPath)).toEqual({
        enabled: true,
        apiKey: 'grn_envKey',
        source: 'env',
      });

      const enabled = startGranolaPoller(new MemoryStorage(), {
        env: {},
        configPath,
        runOnStart: false,
      });
      expect(enabled.enabled).toBe(true);
      await enabled.stop();

      const stdout = captureStdout();
      try {
        const disabled = startGranolaPoller(new MemoryStorage(), {
          env: {},
          configPath: join(dir, 'missing.json'),
          runOnStart: false,
        });
        expect(disabled.enabled).toBe(false);
        expect(await disabled.poll()).toEqual({ status: 'skipped', reason: 'disabled' });
      } finally {
        stdout.restore();
      }
      expect(stdout.writes.join('')).toContain('disabled');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists checkpoints as JSON with the expected shape', () => {
    const { dir, path } = tempCheckpoint();
    try {
      writeGranolaCheckpoint(
        {
          schema_version: 1,
          high_water_mark: '2026-06-21T10:00:00.000Z',
          ingested_note_ids: ['note-b', 'note-a'],
          last_synced_at: '2026-06-21T10:01:00.000Z',
        },
        path,
      );
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
        schema_version: 1,
        high_water_mark: '2026-06-21T10:00:00.000Z',
        ingested_note_ids: ['note-b', 'note-a'],
        last_synced_at: '2026-06-21T10:01:00.000Z',
      });
      expect(loadGranolaCheckpoint(path).ingested_note_ids).toEqual(['note-a', 'note-b']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
