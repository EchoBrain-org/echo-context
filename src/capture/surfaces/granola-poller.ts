import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isNonEmptyString } from '../../guards.js';
import { ECHO_STATE_PATHS } from '../../echo-home/state-paths.js';
import { atomicWrite } from '../../echo-home/adapters/atomic-write.js';
import { createLogger } from '../../logging/index.js';
import type { AtomIterationRecord, CaptureEvent, Storage } from '../../storage/interface.js';
import { parseJson } from '../../util/json.js';
import {
  GRANOLA_API_SOURCE,
  GRANOLA_SOURCE_POLICY,
} from '../granola-source-policy.js';
import { processCandidateWithPolicy } from '../pipeline-core.js';

export const GRANOLA_SOURCE = GRANOLA_API_SOURCE;
export const GRANOLA_API_BASE_URL = 'https://public-api.granola.ai/v1';
export const GRANOLA_CHECKPOINT_SCHEMA_VERSION = 1;
export const DEFAULT_GRANOLA_POLL_INTERVAL_MS = 60_000;
export const DEFAULT_GRANOLA_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_GRANOLA_PAGE_SIZE = 30; // Granola API caps page_size at 30; >30 → HTTP 400 (confirmed live 2026-06-21)
export const GRANOLA_API_KEY_RE = /^grn_[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const DEFAULT_GRANOLA_CHECKPOINT_LOCK_TIMEOUT_MS = 10_000;
export const DEFAULT_GRANOLA_CHECKPOINT_LOCK_STALE_MS = 60_000;
export const DEFAULT_GRANOLA_CHECKPOINT_LOCK_RETRY_MS = 100;
export const DEFAULT_GRANOLA_RATE_LIMIT_RETRY_AFTER_CAP_MS = 30_000;

const log = createLogger('capture.surfaces.granola');

export interface GranolaListNote {
  id: string;
  object?: string;
  title?: string | null;
  owner?: unknown;
  created_at?: string;
  updated_at?: string;
}

export interface GranolaTranscriptItem {
  text?: string;
  start_time?: number | string | null;
  end_time?: number | string | null;
  start?: number | string | null;
  end?: number | string | null;
  speaker?: string | { name?: unknown; email?: unknown } | null;
}

export interface GranolaNoteDetail extends GranolaListNote {
  summary_markdown?: string | null;
  summary_text?: string | null;
  transcript?: GranolaTranscriptItem[];
  attendees?: unknown;
  calendar_event?: unknown;
  folder_membership?: unknown;
  web_url?: string | null;
}

export interface GranolaListParams {
  updated_after?: string;
  cursor?: string;
  page_size?: number;
}

export interface GranolaListResponse {
  notes: GranolaListNote[];
  hasMore: boolean;
  cursor: string | null;
}

export interface GranolaApiClient {
  listNotes(params: GranolaListParams): Promise<GranolaListResponse>;
  getNote(noteId: string): Promise<GranolaNoteDetail>;
}

export interface GranolaCheckpoint {
  schema_version: typeof GRANOLA_CHECKPOINT_SCHEMA_VERSION;
  high_water_mark: string | null;
  ingested_note_ids: string[];
  last_synced_at: string | null;
}

export interface CurrentGranolaNoteAtoms {
  note_id: string;
  summary?: CaptureEvent;
  transcript?: CaptureEvent;
}

export interface GranolaPollOptions {
  checkpointPath?: string;
  now?: () => string;
  pageSize?: number;
  retryDelayMs?: number;
  lockTimeoutMs?: number;
  lockStaleMs?: number;
  lockRetryMs?: number;
}

export type GranolaPollResult =
  | { status: 'ok'; notes_seen: number; notes_ingested: number; atoms_written: number }
  | { status: 'skipped'; reason: 'in_flight' | 'disabled' }
  | { status: 'error'; reason: GranolaErrorReason; message: string };

export type GranolaErrorReason =
  | 'auth_failed'
  | 'rate_limited'
  | 'timeout'
  | 'pagination_failed'
  | 'checkpoint_failed'
  | 'api_failed'
  | 'pipeline_failed';

export interface GranolaPollerHandle {
  enabled: boolean;
  poll: () => Promise<GranolaPollResult>;
  stop: () => Promise<void>;
}

export interface GranolaPollerOptions extends GranolaPollOptions {
  client?: GranolaApiClient;
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
  configPath?: string;
  apiBaseUrl?: string;
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
  runOnStart?: boolean;
}

type ApiKeyResolution =
  | { enabled: true; apiKey: string; source: 'env' | 'config' | 'options' }
  | {
      enabled: false;
      reason: 'missing' | 'invalid';
      source: 'env' | 'config' | 'options' | 'none';
    };

export class GranolaApiError extends Error {
  constructor(
    message: string,
    public readonly reason: Exclude<GranolaErrorReason, 'checkpoint_failed' | 'pipeline_failed'>,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'GranolaApiError';
  }
}

class GranolaCheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GranolaCheckpointError';
  }
}

export interface GranolaCheckpointLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  retryMs?: number;
}

export interface GranolaCheckpointLock {
  checkpointPath: string;
  lockDir: string;
  ownerToken: string;
}

interface LockMetadata {
  owner_token: string;
  pid: number;
  acquired_at: string;
}

function lockMetadataPath(lockDir: string): string {
  return join(lockDir, 'holder.json');
}

function lockTokenPath(lockDir: string): string {
  return join(lockDir, 'owner-token');
}

function parseLockMetadata(lockDir: string): LockMetadata | null {
  try {
    const parsed = parseJson(readFileSync(lockMetadataPath(lockDir), 'utf8'));
    if (!isPlainObject(parsed)) return null;
    const ownerToken = parsed['owner_token'];
    const pid = parsed['pid'];
    const acquiredAt = parsed['acquired_at'];
    if (
      typeof ownerToken !== 'string' ||
      typeof pid !== 'number' ||
      typeof acquiredAt !== 'string'
    ) {
      return null;
    }
    return { owner_token: ownerToken, pid, acquired_at: acquiredAt };
  } catch {
    return null;
  }
}

function isLockStale(lockDir: string, nowMs: number, staleMs: number): boolean {
  const metadata = parseLockMetadata(lockDir);
  if (metadata === null) return true;
  const acquired = new Date(metadata.acquired_at).getTime();
  return Number.isNaN(acquired) || nowMs - acquired > staleMs;
}

function removeStaleLock(lockDir: string): void {
  const tombstone = `${lockDir}.stale-${randomUUID()}`;
  renameSync(lockDir, tombstone);
  rmSync(tombstone, { recursive: true, force: true });
}

export async function acquireGranolaCheckpointLock(
  checkpointPath: string,
  opts: GranolaCheckpointLockOptions = {},
): Promise<GranolaCheckpointLock> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_GRANOLA_CHECKPOINT_LOCK_TIMEOUT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_GRANOLA_CHECKPOINT_LOCK_STALE_MS;
  const retryMs = opts.retryMs ?? DEFAULT_GRANOLA_CHECKPOINT_LOCK_RETRY_MS;
  const lockDir = `${checkpointPath}.lock`;
  const start = Date.now();
  try {
    mkdirSync(dirname(checkpointPath), { recursive: true });
  } catch (err) {
    throw new GranolaCheckpointError(`checkpoint lock directory failed: ${(err as Error).message}`);
  }

  for (;;) {
    try {
      mkdirSync(lockDir);
      const ownerToken = randomUUID();
      const acquiredAt = new Date().toISOString();
      writeFileSync(lockTokenPath(lockDir), `${ownerToken}\n`);
      writeFileSync(
        lockMetadataPath(lockDir),
        `${JSON.stringify(
          { owner_token: ownerToken, pid: process.pid, acquired_at: acquiredAt },
          null,
          2,
        )}\n`,
      );
      return { checkpointPath, lockDir, ownerToken };
    } catch (err) {
      if (!isErrnoException(err) || err.code !== 'EEXIST') {
        throw new GranolaCheckpointError(`checkpoint lock failed: ${(err as Error).message}`);
      }
      if (isLockStale(lockDir, Date.now(), staleMs)) {
        try {
          removeStaleLock(lockDir);
          continue;
        } catch (removeErr) {
          if (!isErrnoException(removeErr) || removeErr.code !== 'ENOENT') {
            throw new GranolaCheckpointError(
              `checkpoint stale-lock takeover failed: ${(removeErr as Error).message}`,
            );
          }
        }
      }
      if (Date.now() - start >= timeoutMs) {
        throw new GranolaCheckpointError(`checkpoint lock timed out after ${timeoutMs}ms`);
      }
      await sleep(retryMs);
    }
  }
}

export function releaseGranolaCheckpointLock(lock: GranolaCheckpointLock): void {
  try {
    const token = readFileSync(lockTokenPath(lock.lockDir), 'utf8').trim();
    if (token === lock.ownerToken) {
      rmSync(lock.lockDir, { recursive: true, force: true });
    }
  } catch (err) {
    if (!isErrnoException(err) || err.code !== 'ENOENT') throw err;
  }
}

export async function withGranolaCheckpointLock<T>(
  checkpointPath: string,
  opts: GranolaCheckpointLockOptions,
  fn: (lock: GranolaCheckpointLock) => Promise<T>,
): Promise<T> {
  const lock = await acquireGranolaCheckpointLock(checkpointPath, opts);
  try {
    return await fn(lock);
  } finally {
    releaseGranolaCheckpointLock(lock);
  }
}

export function granolaCheckpointPath(): string {
  return join(ECHO_STATE_PATHS.state, 'granola-checkpoint.json');
}

export function granolaConfigPath(): string {
  return join(ECHO_STATE_PATHS.state, 'granola.json');
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidGranolaApiKey(value: unknown): value is string {
  return typeof value === 'string' && GRANOLA_API_KEY_RE.test(value);
}

function disabledKey(reason: Extract<ApiKeyResolution, { enabled: false }>): GranolaPollResult {
  log.error('disabled', { reason: reason.reason, key_source: reason.source });
  return { status: 'skipped', reason: 'disabled' };
}

export function resolveGranolaApiKey(
  env: NodeJS.ProcessEnv = process.env,
  configPath = granolaConfigPath(),
  optionApiKey?: string,
): ApiKeyResolution {
  if (optionApiKey !== undefined) {
    if (isValidGranolaApiKey(optionApiKey)) {
      return { enabled: true, apiKey: optionApiKey, source: 'options' };
    }
    return { enabled: false, reason: 'invalid', source: 'options' };
  }

  const envKey = env['GRANOLA_API_KEY'];
  if (isNonEmptyString(envKey)) {
    if (isValidGranolaApiKey(envKey)) {
      return { enabled: true, apiKey: envKey, source: 'env' };
    }
    return { enabled: false, reason: 'invalid', source: 'env' };
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      return { enabled: false, reason: 'missing', source: 'none' };
    }
    return { enabled: false, reason: 'invalid', source: 'config' };
  }

  let parsed: unknown;
  try {
    parsed = parseJson(raw);
  } catch {
    return { enabled: false, reason: 'invalid', source: 'config' };
  }
  if (!isPlainObject(parsed)) {
    return { enabled: false, reason: 'invalid', source: 'config' };
  }
  const apiKey = parsed['api_key'];
  if (!isValidGranolaApiKey(apiKey)) {
    return {
      enabled: false,
      reason: apiKey === undefined ? 'missing' : 'invalid',
      source: 'config',
    };
  }
  return { enabled: true, apiKey, source: 'config' };
}

export class HttpGranolaApiClient implements GranolaApiClient {
  constructor(
    private readonly apiKey: string,
    private readonly opts: {
      baseUrl?: string;
      requestTimeoutMs?: number;
      fetchImpl?: typeof fetch;
    } = {},
  ) {}

  async listNotes(params: GranolaListParams): Promise<GranolaListResponse> {
    const url = this.url('/notes');
    if (params.updated_after !== undefined) {
      url.searchParams.set('updated_after', params.updated_after);
    }
    if (params.cursor !== undefined) {
      url.searchParams.set('cursor', params.cursor);
    }
    if (params.page_size !== undefined) {
      url.searchParams.set('page_size', String(params.page_size));
    }
    return parseListResponse(await this.fetchJson(url));
  }

  async getNote(noteId: string): Promise<GranolaNoteDetail> {
    const url = this.url(`/notes/${encodeURIComponent(noteId)}`);
    url.searchParams.set('include', 'transcript');
    return parseNoteDetail(await this.fetchJson(url));
  }

  private url(path: string): URL {
    return new URL(path.replace(/^\//, ''), `${this.opts.baseUrl ?? GRANOLA_API_BASE_URL}/`);
  }

  private async fetchJson(url: URL): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.opts.requestTimeoutMs ?? DEFAULT_GRANOLA_REQUEST_TIMEOUT_MS,
    );
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    try {
      const response = await fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
        if (response.status === 401 || response.status === 403) {
          throw new GranolaApiError(
            'Granola API authentication failed',
            'auth_failed',
            response.status,
          );
        }
        if (response.status === 429) {
          throw new GranolaApiError(
            'Granola API rate limit exceeded',
            'rate_limited',
            response.status,
            retryAfterMs,
          );
        }
        throw new GranolaApiError(
          `Granola API request failed with HTTP ${response.status}`,
          'api_failed',
          response.status,
        );
      }
      return await response.json();
    } catch (err) {
      if (err instanceof GranolaApiError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new GranolaApiError('Granola API request timed out', 'timeout');
      }
      throw new GranolaApiError((err as Error).message, 'api_failed');
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const asDate = new Date(value).getTime();
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return undefined;
}

function parseListResponse(value: unknown): GranolaListResponse {
  if (!isPlainObject(value)) {
    throw new GranolaApiError('Granola list response was not an object', 'pagination_failed');
  }
  const notes = value['notes'];
  const hasMore = value['hasMore'];
  const cursor = value['cursor'];
  if (!Array.isArray(notes) || typeof hasMore !== 'boolean') {
    throw new GranolaApiError(
      'Granola list response had invalid pagination fields',
      'pagination_failed',
    );
  }
  if (cursor !== null && cursor !== undefined && typeof cursor !== 'string') {
    throw new GranolaApiError('Granola list cursor was invalid', 'pagination_failed');
  }
  return {
    notes: notes.map(parseListNote),
    hasMore,
    cursor: cursor ?? null,
  };
}

function parseListNote(value: unknown): GranolaListNote {
  if (!isPlainObject(value) || !isNonEmptyString(value['id'])) {
    throw new GranolaApiError('Granola list note was missing id', 'pagination_failed');
  }
  const note: GranolaListNote = { id: value['id'] };
  copyStringFields(value, note as unknown as Record<string, unknown>, [
    'object',
    'title',
    'created_at',
    'updated_at',
  ]);
  if ('owner' in value) note.owner = value['owner'];
  return note;
}

function parseNoteDetail(value: unknown): GranolaNoteDetail {
  const base = parseListNote(value);
  if (!isPlainObject(value)) {
    throw new GranolaApiError('Granola note detail was not an object', 'api_failed');
  }
  const detail: GranolaNoteDetail = { ...base };
  copyStringFields(value, detail as unknown as Record<string, unknown>, [
    'summary_markdown',
    'summary_text',
    'web_url',
  ]);
  const transcript = value['transcript'];
  if (Array.isArray(transcript)) {
    detail.transcript = transcript
      .filter(isPlainObject)
      .map((item) => ({ ...item }) as GranolaTranscriptItem);
  }
  for (const key of ['attendees', 'calendar_event', 'folder_membership'] as const) {
    if (key in value) detail[key] = value[key];
  }
  return detail;
}

function copyStringFields(
  from: Record<string, unknown>,
  to: Record<string, unknown>,
  fields: readonly string[],
): void {
  for (const field of fields) {
    const value = from[field];
    if (typeof value === 'string') {
      to[field] = value;
    } else if (value === null) {
      to[field] = null;
    }
  }
}

function emptyCheckpoint(): GranolaCheckpoint {
  return {
    schema_version: GRANOLA_CHECKPOINT_SCHEMA_VERSION,
    high_water_mark: null,
    ingested_note_ids: [],
    last_synced_at: null,
  };
}

export function loadGranolaCheckpoint(filePath = granolaCheckpointPath()): GranolaCheckpoint {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return emptyCheckpoint();
    throw new GranolaCheckpointError(`checkpoint read failed: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = parseJson(raw);
  } catch (err) {
    throw new GranolaCheckpointError(`checkpoint JSON invalid: ${(err as Error).message}`);
  }
  if (!isPlainObject(parsed) || parsed['schema_version'] !== GRANOLA_CHECKPOINT_SCHEMA_VERSION) {
    throw new GranolaCheckpointError('checkpoint schema invalid');
  }
  const highWaterMark = parsed['high_water_mark'];
  const ingested = parsed['ingested_note_ids'];
  const lastSyncedAt = parsed['last_synced_at'];
  if (highWaterMark !== null && typeof highWaterMark !== 'string') {
    throw new GranolaCheckpointError('checkpoint high_water_mark invalid');
  }
  if (!Array.isArray(ingested) || !ingested.every((v) => typeof v === 'string')) {
    throw new GranolaCheckpointError('checkpoint ingested_note_ids invalid');
  }
  if (lastSyncedAt !== null && typeof lastSyncedAt !== 'string') {
    throw new GranolaCheckpointError('checkpoint last_synced_at invalid');
  }
  return {
    schema_version: GRANOLA_CHECKPOINT_SCHEMA_VERSION,
    high_water_mark: highWaterMark,
    ingested_note_ids: [...new Set(ingested)].sort(),
    last_synced_at: lastSyncedAt,
  };
}

export function writeGranolaCheckpoint(
  checkpoint: GranolaCheckpoint,
  filePath = granolaCheckpointPath(),
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  atomicWrite({
    filePath,
    content: `${JSON.stringify(checkpoint, null, 2)}\n`,
  });
}

export interface LockedCheckpointWriteOptions {
  beforeCommit?: (tempPath: string) => void | Promise<void>;
}

export async function writeCheckpointJsonWithLock(
  lock: GranolaCheckpointLock,
  content: string,
  opts: LockedCheckpointWriteOptions = {},
): Promise<void> {
  const token = readFileSync(lockTokenPath(lock.lockDir), 'utf8').trim();
  if (token !== lock.ownerToken) {
    throw new GranolaCheckpointError('checkpoint lock owner token mismatch before stage');
  }
  const tempPath = join(lock.lockDir, `pending-${lock.ownerToken}-${randomUUID()}`);
  writeFileSync(tempPath, content);
  const rereadToken = readFileSync(lockTokenPath(lock.lockDir), 'utf8').trim();
  if (rereadToken !== lock.ownerToken) {
    rmSync(tempPath, { force: true });
    throw new GranolaCheckpointError('checkpoint lock owner token mismatch before commit');
  }
  await opts.beforeCommit?.(tempPath);
  renameSync(tempPath, lock.checkpointPath);
}

async function writeGranolaCheckpointLocked(
  lock: GranolaCheckpointLock,
  checkpoint: GranolaCheckpoint,
): Promise<void> {
  await writeCheckpointJsonWithLock(lock, `${JSON.stringify(checkpoint, null, 2)}\n`);
}

function granolaAtomUpdatedAt(event: CaptureEvent): string | null {
  const value = event.metadata?.['updated_at'];
  if (typeof value !== 'string') return null;
  return Number.isNaN(new Date(value).getTime()) ? null : new Date(value).toISOString();
}

function isGranolaRawAtom(event: AtomIterationRecord): boolean {
  return event.source === GRANOLA_SOURCE;
}

function atomNoteId(event: CaptureEvent): string | null {
  const value = event.metadata?.['note_id'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function atomGranolaType(event: CaptureEvent): 'summary' | 'transcript' | null {
  const value = event.metadata?.['granola_atom_type'];
  return value === 'summary' || value === 'transcript' ? value : null;
}

function newerGranolaAtom(
  candidate: AtomIterationRecord,
  incumbent: CaptureEvent | undefined,
): boolean {
  if (incumbent === undefined) return true;
  const candidateUpdatedAt = granolaAtomUpdatedAt(candidate);
  const incumbentUpdatedAt = granolaAtomUpdatedAt(incumbent);
  if (candidateUpdatedAt === null && incumbentUpdatedAt === null) return true;
  if (candidateUpdatedAt === null) return false;
  if (incumbentUpdatedAt === null) return true;
  if (candidateUpdatedAt > incumbentUpdatedAt) return true;
  if (candidateUpdatedAt < incumbentUpdatedAt) return false;
  return true;
}

export async function resolveCurrentGranolaNotes(
  storage: Storage,
): Promise<Map<string, CurrentGranolaNoteAtoms>> {
  const byNote = new Map<string, CurrentGranolaNoteAtoms>();
  const atoms = await storage.iterateAtomsByAppendOrder({ sourcePrefixes: [GRANOLA_SOURCE] });
  for (const atom of atoms) {
    if (!isGranolaRawAtom(atom)) continue;
    const noteId = atomNoteId(atom);
    const atomType = atomGranolaType(atom);
    if (noteId === null || atomType === null) continue;
    const entry = byNote.get(noteId) ?? { note_id: noteId };
    if (atomType === 'summary') {
      if (newerGranolaAtom(atom, entry.summary)) entry.summary = atom;
    } else if (newerGranolaAtom(atom, entry.transcript)) {
      entry.transcript = atom;
    }
    byNote.set(noteId, entry);
  }
  return byNote;
}

export async function resolveCurrentGranolaNoteAtoms(
  storage: Storage,
  noteId: string,
): Promise<CurrentGranolaNoteAtoms> {
  return (await resolveCurrentGranolaNotes(storage)).get(noteId) ?? { note_id: noteId };
}

function maxIso(a: string | null, b: string | undefined): string | null {
  if (b === undefined || Number.isNaN(new Date(b).getTime())) return a;
  if (a === null) return new Date(b).toISOString();
  return new Date(b).getTime() > new Date(a).getTime() ? new Date(b).toISOString() : a;
}

function speakerName(speaker: GranolaTranscriptItem['speaker']): string {
  if (typeof speaker === 'string' && speaker.length > 0) return speaker;
  if (isPlainObject(speaker)) {
    const name = speaker['name'];
    if (typeof name === 'string' && name.length > 0) return name;
    const email = speaker['email'];
    if (typeof email === 'string' && email.length > 0) return email;
  }
  return 'Speaker';
}

export function renderGranolaTranscript(transcript: readonly GranolaTranscriptItem[] = []): string {
  const lines: string[] = [];
  for (const turn of transcript) {
    const text = typeof turn.text === 'string' ? turn.text.trim() : '';
    if (text.length === 0) continue;
    const start = turn.start_time ?? turn.start;
    const end = turn.end_time ?? turn.end;
    const time =
      start !== undefined && start !== null
        ? `[${String(start)}${end !== undefined && end !== null ? `-${String(end)}` : ''}] `
        : '';
    lines.push(`${time}${speakerName(turn.speaker)}: ${text}`);
  }
  return lines.join('\n');
}

function addIfDefined(meta: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined && value !== null) meta[key] = value;
}

function mergedDetail(listNote: GranolaListNote, detail: GranolaNoteDetail): GranolaNoteDetail {
  return {
    ...listNote,
    ...detail,
    id: detail.id,
    created_at: detail.created_at ?? listNote.created_at,
    updated_at: detail.updated_at ?? listNote.updated_at,
    title: detail.title ?? listNote.title,
    owner: detail.owner ?? listNote.owner,
  };
}

export function granolaNoteToCaptureEvents(
  note: GranolaNoteDetail,
  observedAt: string,
): [Omit<CaptureEvent, 'id'>, Omit<CaptureEvent, 'id'>] {
  const timestamp = note.updated_at ?? note.created_at ?? observedAt;
  const title = note.title ?? 'Untitled Granola note';
  const transcript = note.transcript ?? [];
  const sharedMetadata: Record<string, unknown> = {
    note_id: note.id,
    title,
    created_at: note.created_at,
    updated_at: note.updated_at,
  };
  addIfDefined(sharedMetadata, 'owner', note.owner);
  addIfDefined(sharedMetadata, 'attendees', note.attendees);
  addIfDefined(sharedMetadata, 'calendar_event', note.calendar_event);
  addIfDefined(sharedMetadata, 'folder_membership', note.folder_membership);
  addIfDefined(sharedMetadata, 'web_url', note.web_url);

  return [
    {
      source: GRANOLA_SOURCE,
      timestamp,
      content: note.summary_markdown ?? note.summary_text ?? '',
      metadata: {
        ...sharedMetadata,
        granola_atom_type: 'summary',
        dedupe_key: `granola:${note.id}:summary`,
        summary_text: note.summary_text ?? undefined,
      },
    },
    {
      source: GRANOLA_SOURCE,
      timestamp,
      content: renderGranolaTranscript(transcript),
      metadata: {
        ...sharedMetadata,
        granola_atom_type: 'transcript',
        dedupe_key: `granola:${note.id}:transcript`,
        transcript_count: transcript.length,
      },
    },
  ];
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRateLimitRetry<T>(
  label: string,
  op: () => Promise<T>,
  retryDelayMs: number,
): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (!(err instanceof GranolaApiError) || err.reason !== 'rate_limited') throw err;
    const delayMs = Math.min(
      err.retryAfterMs ?? retryDelayMs,
      DEFAULT_GRANOLA_RATE_LIMIT_RETRY_AFTER_CAP_MS,
    );
    log.warn('rate_limited_retry', { operation: label, delay_ms: delayMs });
    await sleep(delayMs);
    try {
      return await op();
    } catch (retryErr) {
      if (retryErr instanceof GranolaApiError && retryErr.reason === 'rate_limited') {
        log.error('rate_limited_repeated', { operation: label, status: retryErr.status });
      }
      throw retryErr;
    }
  }
}

function noteUpdatedAt(note: GranolaListNote): string | null {
  const raw = note.updated_at ?? note.created_at;
  if (raw === undefined) return null;
  const ms = new Date(raw).getTime();
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function currentStoredUpdatedAt(atoms: CurrentGranolaNoteAtoms): string | null {
  const values = [atoms.summary, atoms.transcript]
    .map((atom) => (atom === undefined ? null : granolaAtomUpdatedAt(atom)))
    .filter((value): value is string => value !== null)
    .sort();
  return values.at(-1) ?? null;
}

function shouldFetchGranolaNote(
  listNote: GranolaListNote,
  ingestedNoteIds: Set<string>,
  currentAtoms: CurrentGranolaNoteAtoms | undefined,
): boolean {
  if (!ingestedNoteIds.has(listNote.id)) return true;
  if (
    currentAtoms === undefined ||
    (currentAtoms.summary === undefined && currentAtoms.transcript === undefined)
  ) {
    return false;
  }
  const liveUpdatedAt = noteUpdatedAt(listNote);
  const storedUpdatedAt = currentStoredUpdatedAt(currentAtoms);
  return liveUpdatedAt !== null && storedUpdatedAt !== null && liveUpdatedAt > storedUpdatedAt;
}

function errorReason(err: unknown): GranolaErrorReason {
  if (err instanceof GranolaApiError) return err.reason;
  if (err instanceof GranolaCheckpointError) return 'checkpoint_failed';
  return 'pipeline_failed';
}

function logPollError(err: unknown, stage: string): void {
  const reason = errorReason(err);
  const payload = { reason, stage, message: (err as Error).message };
  if (reason === 'auth_failed') log.error('auth_failed', payload);
  else if (reason === 'timeout') log.error('request_timeout', payload);
  else if (reason === 'pagination_failed') log.error('pagination_failed', payload);
  else if (reason === 'checkpoint_failed') log.error('checkpoint_write_failed', payload);
  else log.error('poll_failed', payload);
}

export async function pollGranolaOnce(
  storage: Storage,
  client: GranolaApiClient,
  options: GranolaPollOptions = {},
): Promise<GranolaPollResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const checkpointPath = options.checkpointPath ?? granolaCheckpointPath();
  const pageSize = options.pageSize ?? DEFAULT_GRANOLA_PAGE_SIZE;
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  let stage = 'checkpoint_lock';
  try {
    return await withGranolaCheckpointLock(
      checkpointPath,
      {
        timeoutMs: options.lockTimeoutMs,
        staleMs: options.lockStaleMs,
        retryMs: options.lockRetryMs,
      },
      async (lock) => {
        stage = 'checkpoint_read';
        const checkpoint = loadGranolaCheckpoint(checkpointPath);
        const startingHighWaterMark = checkpoint.high_water_mark;
        const ingestedNoteIds = new Set(checkpoint.ingested_note_ids);
        const currentNotes = await resolveCurrentGranolaNotes(storage);
        let maxUpdatedAt = startingHighWaterMark;
        const notes: GranolaListNote[] = [];
        let cursor: string | undefined;

        stage = 'list';
        for (let page = 0; page < 1_000; page += 1) {
          const response = await withRateLimitRetry(
            'list_notes',
            () =>
              client.listNotes({
                updated_after: startingHighWaterMark ?? undefined,
                cursor,
                page_size: pageSize,
              }),
            retryDelayMs,
          );
          notes.push(...response.notes);
          for (const note of response.notes) {
            maxUpdatedAt = maxIso(maxUpdatedAt, note.updated_at ?? note.created_at);
          }
          if (!response.hasMore) break;
          if (!isNonEmptyString(response.cursor)) {
            throw new GranolaApiError(
              'Granola pagination indicated hasMore without cursor',
              'pagination_failed',
            );
          }
          cursor = response.cursor;
          if (page === 999) {
            throw new GranolaApiError(
              'Granola pagination exceeded safety page cap',
              'pagination_failed',
            );
          }
        }

        let notesIngested = 0;
        let atomsWritten = 0;
        for (const listNote of notes) {
          if (!shouldFetchGranolaNote(listNote, ingestedNoteIds, currentNotes.get(listNote.id))) {
            continue;
          }

          stage = `detail:${listNote.id}`;
          const detail = await withRateLimitRetry(
            'get_note',
            () => client.getNote(listNote.id),
            retryDelayMs,
          );
          const note = mergedDetail(listNote, detail);
          maxUpdatedAt = maxIso(maxUpdatedAt, note.updated_at ?? note.created_at);

          stage = `pipeline:${listNote.id}`;
          const events = granolaNoteToCaptureEvents(note, now());
          for (const event of events) {
            const result = await processCandidateWithPolicy(event, storage, GRANOLA_SOURCE_POLICY);
            if (!result.accepted) {
              throw new Error(`Granola event rejected by pipeline: ${result.reason}`);
            }
            atomsWritten += 1;
          }
          notesIngested += 1;
          ingestedNoteIds.add(listNote.id);
          currentNotes.set(listNote.id, {
            note_id: listNote.id,
            summary: undefined,
            transcript: undefined,
          });

          stage = `checkpoint_partial:${listNote.id}`;
          await writeGranolaCheckpointLocked(lock, {
            schema_version: GRANOLA_CHECKPOINT_SCHEMA_VERSION,
            high_water_mark: startingHighWaterMark,
            ingested_note_ids: [...ingestedNoteIds].sort(),
            last_synced_at: now(),
          });
        }

        stage = 'checkpoint_final';
        await writeGranolaCheckpointLocked(lock, {
          schema_version: GRANOLA_CHECKPOINT_SCHEMA_VERSION,
          high_water_mark: maxUpdatedAt,
          ingested_note_ids: [...ingestedNoteIds].sort(),
          last_synced_at: now(),
        });
        log.info('poll_ok', {
          notes_seen: notes.length,
          notes_ingested: notesIngested,
          atoms_written: atomsWritten,
          high_water_mark: maxUpdatedAt,
        });
        return {
          status: 'ok',
          notes_seen: notes.length,
          notes_ingested: notesIngested,
          atoms_written: atomsWritten,
        };
      },
    );
  } catch (err) {
    logPollError(err, stage);
    return { status: 'error', reason: errorReason(err), message: (err as Error).message };
  }
}

export function startGranolaPoller(
  storage: Storage,
  options: GranolaPollerOptions = {},
): GranolaPollerHandle {
  const keyResolution =
    options.client !== undefined
      ? ({ enabled: true, apiKey: 'injected-client', source: 'options' } as const)
      : resolveGranolaApiKey(options.env, options.configPath, options.apiKey);
  if (!keyResolution.enabled) {
    const disabled = disabledKey(keyResolution);
    return {
      enabled: false,
      poll: async () => disabled,
      stop: async () => {},
    };
  }

  const client =
    options.client ??
    new HttpGranolaApiClient(keyResolution.apiKey, {
      baseUrl: options.apiBaseUrl,
      requestTimeoutMs: options.requestTimeoutMs,
    });
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_GRANOLA_POLL_INTERVAL_MS;
  const runOnStart = options.runOnStart ?? true;
  let stopped = false;
  let inFlight: Promise<GranolaPollResult> | null = null;

  async function runPoll(): Promise<GranolaPollResult> {
    if (stopped) return { status: 'skipped', reason: 'disabled' };
    if (inFlight !== null) {
      log.warn('poll_skipped_in_flight', {});
      return { status: 'skipped', reason: 'in_flight' };
    }
    inFlight = pollGranolaOnce(storage, client, options);
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  const interval = setInterval(() => {
    void runPoll().catch((err: unknown) => {
      log.error('handler_error', { message: (err as Error).message });
    });
  }, pollIntervalMs);
  interval.unref();
  if (runOnStart) {
    void runPoll().catch((err: unknown) => {
      log.error('handler_error', { message: (err as Error).message });
    });
  }

  log.info('started', {
    poll_interval_ms: pollIntervalMs,
    checkpoint_path: options.checkpointPath ?? granolaCheckpointPath(),
    key_source: keyResolution.source,
  });

  return {
    enabled: true,
    poll: runPoll,
    stop: async () => {
      stopped = true;
      clearInterval(interval);
      if (inFlight !== null) await inFlight.catch(() => ({ status: 'error' }));
      log.info('stopped', {});
    },
  };
}
