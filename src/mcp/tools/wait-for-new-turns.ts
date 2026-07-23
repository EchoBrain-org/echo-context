// V1.6 (item 030) — `wait_for_new_turns`: stateless long-poll for group session.
//
// Per founder direction (2026-05-09): "I should be able to link multiple
// sessions together and they tail each other... user should feel the unified
// context of all the tools and agents they use are unified and communicating
// with each other." This tool is the missing primitive that lets agents stay
// synchronized passively without a manual MCP call per turn.
//
// Stateless on every dimension (per item 027):
//   - No subscriber registry. No per-client state.
//   - Each call is independent — the storage poll is the only shared resource.
//   - No module-level mutable state in this file (asserted by spec §3 test).
//
// Source semantics (deliberately different from echo_resolve_mru's MRU pick):
//   - echo_resolve_mru(sources=[<source_app>]) → MRU exact-source resolution
//     for "where did I leave off" lookups.
//   - wait_for_new_turns(sources=[<source_app>]) → PREFIX match across ALL
//     sessions of that app (catches new coding sessions as they spawn — group
//     session A wants to wake on ANY new turn). Historical source identifiers
//     remain accepted even when the bundled runtime no longer produces them.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { StorageScanBudgetExceededError } from '../../storage/budgets.js';
import type { CaptureEvent, QueryFilter, Storage } from '../../storage/interface.js';
import { canonicalizeTimestamp } from '../../util/timestamp.js';
import { withFsExclusion } from '../util/fs-exclusion.js';
import { isoString } from '../util/iso8601.js';
import {
  assertAbsoluteRepoPath,
  resolveRepoPath,
  type ResolvedRepoPath,
} from '../util/repo-path.js';
import { buildSourceAppMap, SOURCE_APP_VALUES, type SourceApp } from '../util/source-app.js';

const SCHEMA_VERSION = 1;

export const WAIT_MAX_SOURCES = 8;
export const WAIT_DEFAULT_TIMEOUT_SECONDS = 30;
export const WAIT_MAX_TIMEOUT_SECONDS = 60;
export const WAIT_DEFAULT_POLL_INTERVAL_MS = 1_000;
// Final return cap — matches spec §3 "LIMIT 20" overall after merge. (A
// same-timestamp group at the page boundary may push the page past this —
// see pollOnce: never split a tie group across the strict `> since` chain.)
export const WAIT_MAX_RETURNED_TURNS = 20;
// Per-source raw fetch window (ASC, oldest-first). Must exceed the return
// cap so that (a) overflow is detectable (cap+1), (b) rows AT exactly
// `since` — the previous page's boundary tie group, dropped by the
// strict-after post-filter — don't starve the window, and (c) the boundary
// tie-group extension has headroom. 2*cap+1 absorbs a full cap-sized stale
// boundary group plus cap+1 fresh rows. A tie group larger than this window
// could still be split — documented limitation, pathological (>20 atoms
// sharing one millisecond at the boundary).
export const WAIT_PER_POLL_LIMIT_PER_SOURCE = 2 * WAIT_MAX_RETURNED_TURNS + 1;
export const WAIT_MAX_STORAGE_SCAN_WINDOWS = 4;

// Recognised source_app names that resolve via PREFIX MATCH (different
// from echo_resolve_mru's MRU exact-source resolution). Sources NOT in this
// set are treated as literal source paths (exact match).
const SOURCE_APP_SET = new Set<string>(SOURCE_APP_VALUES);

export const WAIT_FOR_NEW_TURNS_DESCRIPTION =
  'Long-poll for newly completed context atoms. Provide non-empty `sources`, non-empty `source_prefix`, or both. In `sources`, app names (`cursor`, `claude_code`, `codex`, `git`, `granola`) match every captured source for that app; other strings are exact sources. `source_prefix` is additive, so combining it with `sources` returns their union. Duplicate selectors are de-duplicated.\n\n' +
  '`since` is exclusive. The response contains oldest-first `turn_ids`; fetch bodies with `get_atoms`. Always pass the returned `next_since` into the next call, including after an empty timeout. At most 20 IDs normally return per wake, with coded warnings for backlog, timestamp-tie, or storage-scan limits. `timeout` defaults to 30 seconds and is capped at 60. Client cancellation stops polling promptly.';

export interface WaitForNewTurnsParams {
  /** Optional under AC4 (057a). At least one of `sources` (non-empty) or
   *  `source_prefix` (non-empty) must be present; both absent / both empty
   *  is a structured validation error. Pre-AC4 callers passing
   *  `sources=[...]` with no `source_prefix` observe byte-identical
   *  behavior to the pre-AC4 contract. */
  sources?: string[];
  /** AC4 (057a) — optional prefix filter, sibling of `sources[]`. Matches
   *  any captured atom whose `source` string starts with `source_prefix`.
   *  When supplied alongside `sources[]`, the returned turn-id set is the
   *  UNION of the two filters (a turn whose source matches either filter
   *  qualifies). The mailbox contract for the coord substrate uses
   *  `source_prefix="coord:"` to wake on any role's coord event without
   *  enumerating role slugs. */
  source_prefix?: string;
  since: string;
  timeout?: number;
  /** Item 037 / AC5: absolute project root path. Every per-source poll
   *  inherits a canonical project-key AND filter, so nested adapter cwd
   *  values still wake the same project. Legacy rows fall back through
   *  canonical_root/repo_root when available. */
  repo_path?: string;
}

export interface WaitForNewTurnsResult {
  schema_version: 1;
  tool: 'wait_for_new_turns';
  /** Item 038 / AC4: IDs only. The caller composes `get_atoms(turn_ids)` or
   *  `get_atom(turn_ids[i])` for body fetch. Atomic separation: the wait
   *  envelope shrinks dramatically (no body projection), and the wake
   *  outcome is cheap to consume even when bodies are not needed. */
  turn_ids: string[];
  next_since: string;
  timed_out: boolean;
  warnings: string[];
}

interface ResolvedSources {
  exact: string[];
  prefixes: string[];
}

/** Split mixed `sources[]` into exact source paths vs source-app prefixes.
 *  Source-app names resolve to FS prefixes via `buildSourceAppMap()` —
 *  prefix match catches ALL sessions of that app (deliberately different
 *  from `echo_resolve_mru`'s MRU exact-source resolution). */
export function resolveSources(sources: readonly string[]): ResolvedSources {
  const sourceAppMap = buildSourceAppMap();
  const exact = new Set<string>();
  const prefixes = new Set<string>();
  for (const s of sources) {
    if (SOURCE_APP_SET.has(s)) {
      prefixes.add(sourceAppMap[s as SourceApp]);
    } else {
      exact.add(s);
    }
  }
  return { exact: [...exact], prefixes: [...prefixes] };
}

interface PollPage {
  /** Oldest-first (timestamp ASC, id ASC) page of matched rows. */
  rows: CaptureEvent[];
  /** True when more rows matched than the page carries — caller should
   *  chain immediately with next_since to page through the backlog. */
  overflow: boolean;
  /** True only in the documented lossy floor: a single same-timestamp
   *  group in one source exceeds the per-source fetch window, so the page
   *  ships a possibly-incomplete tie group and the chained strict-`>`
   *  call may skip its unfetched members. Caller warns loudly. */
  tieGroupMayBeIncomplete?: boolean;
  /** A sparse storage post-filter exhausted every bounded continuation
   * window. This is advisory, never a public MCP error. */
  scanTruncated?: boolean;
}

interface SourcePollPage {
  rows: CaptureEvent[];
  scanTruncated: boolean;
}

/** Freshness is an observation-level concern for this raw-storage tool.
 * Explicit inherited copies are already-known logical work observed in a new
 * session, so they must not wake a waiter. Missing, `unknown`, and malformed
 * markers remain eligible: those shapes include every row captured before
 * logical observation metadata existed, and failing them closed would make
 * legacy activity silently disappear. The public cursor deliberately remains
 * the stored event timestamp for lossless `since` / `next_since` chaining. */
function isWakeEligibleObservation(event: CaptureEvent): boolean {
  return event.metadata?.['observation_kind'] !== 'inherited';
}

async function hydrateScanMatches(
  storage: Storage,
  ids: readonly string[],
): Promise<CaptureEvent[]> {
  const rows: CaptureEvent[] = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    rows.push(...(await storage.getByIds(ids.slice(offset, offset + 100))));
  }
  return rows;
}

/** Query one wait source through a finite sequence of resumable sparse-scan
 * windows. Matches admitted before each boundary are hydrated by id and the
 * next window resumes strictly after the storage cursor. */
async function queryPollSource(storage: Storage, filter: QueryFilter): Promise<SourcePollPage> {
  const requested = filter.limit ?? WAIT_PER_POLL_LIMIT_PER_SOURCE;
  const rows: CaptureEvent[] = [];
  let after = filter.after;

  for (let window = 0; window < WAIT_MAX_STORAGE_SCAN_WINDOWS; window += 1) {
    const remaining = requested - rows.length;
    if (remaining <= 0) return { rows: rows.slice(0, requested), scanTruncated: false };
    let candidates: CaptureEvent[];
    try {
      candidates = await storage.query({ ...filter, after, limit: remaining });
    } catch (error) {
      if (!(error instanceof StorageScanBudgetExceededError)) throw error;
      candidates = await hydrateScanMatches(storage, error.matched_ids);
      for (const candidate of candidates) {
        if (isWakeEligibleObservation(candidate)) rows.push(candidate);
      }
      if (rows.length >= requested) {
        return { rows: rows.slice(0, requested), scanTruncated: false };
      }
      after = error.resume_cursor;
      continue;
    }

    for (const candidate of candidates) {
      if (isWakeEligibleObservation(candidate)) rows.push(candidate);
    }
    if (rows.length >= requested) {
      return { rows: rows.slice(0, requested), scanTruncated: false };
    }

    // A short raw page proves source exhaustion at this boundary. A full raw
    // page containing inherited copies does not: continue strictly after its
    // last physical observation so a genuine turn behind the copies can wake
    // the caller without letting the copies satisfy the early-stop target.
    if (candidates.length < remaining) {
      rows.sort((left, right) => {
        if (left.timestamp < right.timestamp) return -1;
        if (left.timestamp > right.timestamp) return 1;
        if (left.id < right.id) return -1;
        if (left.id > right.id) return 1;
        return 0;
      });
      return { rows: rows.slice(0, requested), scanTruncated: false };
    }
    const lastCandidate = candidates[candidates.length - 1];
    if (lastCandidate === undefined) {
      return { rows: rows.slice(0, requested), scanTruncated: false };
    }
    after = { timestamp: lastCandidate.timestamp, id: lastCandidate.id };
  }

  rows.sort((left, right) => {
    if (left.timestamp < right.timestamp) return -1;
    if (left.timestamp > right.timestamp) return 1;
    if (left.id < right.id) return -1;
    if (left.id > right.id) return 1;
    return 0;
  });
  return { rows: rows.slice(0, requested), scanTruncated: rows.length < requested };
}

/** One poll pass: fan out one storage query per (exact source) and per
 *  (prefix) entry — each ASC oldest-first — post-filter to STRICT-after
 *  `since` (storage uses `>=`), merge by id, sort ASC (timestamp, id), and
 *  page: when more than WAIT_MAX_RETURNED_TURNS matched, return the OLDEST
 *  cap-sized page, extended through any same-timestamp group at the page
 *  boundary (never split a tie group — with strict `> since` chaining, a
 *  split group's unreturned members would be skipped forever). */
async function pollOnce(
  storage: Storage,
  resolved: ResolvedSources,
  since: string,
  repoPath: ResolvedRepoPath | null,
): Promise<PollPage> {
  // Reuse the historical raw-fs exclusion applied by all retrieval paths.
  const filterCommon: QueryFilter = withFsExclusion({
    since,
    limit: WAIT_PER_POLL_LIMIT_PER_SOURCE,
    // Item 037 / AC5: repo-scoping. AND-joined with the source/prefix
    // filter on each per-source query below.
    ...(repoPath !== null
      ? {
          project_key: repoPath.project_key,
          legacy_project_roots: repoPath.legacy_project_roots,
        }
      : {}),
  });
  // Fix ⑤: ASC oldest-first per-source fetch — the lossless chaining
  // contract pages from the OLDEST end. (DESC newest-first silently dropped
  // the oldest of a >cap burst, and chaining skipped them forever.)
  const filterCommonAsc: QueryFilter = { ...filterCommon, order: 'asc' };
  const queries: Promise<SourcePollPage>[] = [];
  for (const exact of resolved.exact) {
    queries.push(queryPollSource(storage, { ...filterCommonAsc, source: exact }));
  }
  for (const prefix of resolved.prefixes) {
    queries.push(queryPollSource(storage, { ...filterCommonAsc, source_prefix: prefix }));
  }
  const results = await Promise.all(queries);
  const scanTruncated = results.some((result) => result.scanTruncated);

  // Strict-after post-filter: storage uses `>=` so a re-fire with
  // since=last_returned_ts would re-deliver the boundary turn on every
  // wake. Drop rows at exactly `since` here so the contract `> since`
  // holds. Spec §3 strict-after-boundary semantic (acceptance #3).
  const merged = new Map<string, CaptureEvent>();
  for (const result of results) {
    for (const r of result.rows) {
      if (r.timestamp <= since) continue;
      merged.set(r.id, r);
    }
  }
  const all = [...merged.values()];
  // Sort by (timestamp ASC, id ASC) — oldest-first delivery, matching the
  // storage adapters' ASC tie-break, so the cap below keeps the OLDEST page
  // and `since = next_since` chaining pages through a backlog losslessly.
  all.sort((a, b) => {
    if (a.timestamp < b.timestamp) return -1;
    if (a.timestamp > b.timestamp) return 1;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
  // 101-retro r3: per-source window-full HORIZONS. A query that filled its
  // window (returned exactly WAIT_PER_POLL_LIMIT_PER_SOURCE rows) may have
  // more rows at its last fetched timestamp beyond the window — any tie
  // group ending the page AT such a horizon cannot be proven complete.
  const fullWindowHorizons = new Set<string>();
  for (const { rows } of results) {
    if (rows.length === WAIT_PER_POLL_LIMIT_PER_SOURCE) {
      fullWindowHorizons.add(rows[rows.length - 1]!.timestamp);
    }
  }

  // Page selection: when over the cap, take the oldest cap-sized page, then
  // extend through any same-timestamp group straddling the boundary.
  // next_since will be the page-end timestamp; strict `> since` on the
  // chained call skips that whole timestamp — safe only when we delivered
  // ALL of it.
  let end = all.length;
  let overflow = false;
  if (all.length > WAIT_MAX_RETURNED_TURNS) {
    const boundaryTs = all[WAIT_MAX_RETURNED_TURNS - 1]!.timestamp;
    end = WAIT_MAX_RETURNED_TURNS;
    while (end < all.length && all[end]!.timestamp === boundaryTs) end += 1;
    overflow = true;
  }

  // Completeness guard (101-retro r3 codex MED): if the page ends at a
  // window-full source's horizon timestamp, that tie group may be truncated
  // by the fetch window — extending through only the FETCHED members and
  // advancing next_since past their timestamp would skip the unfetched ones
  // forever. Hold the unprovable group back whole: the chained call (since =
  // previous row's ts) re-fetches it with the entire window to itself. The
  // only case left is a single same-ms group alone exceeding the window —
  // no lossless progress is possible there, so it ships flagged for the
  // caller's loud warning. That is the documented lossy floor.
  if (end > 0) {
    const pageEndTs = all[end - 1]!.timestamp;
    if (fullWindowHorizons.has(pageEndTs)) {
      let held = end;
      while (held > 0 && all[held - 1]!.timestamp === pageEndTs) held -= 1;
      if (held > 0) {
        return { rows: all.slice(0, held), overflow: true, scanTruncated };
      }
      return {
        rows: all.slice(0, end),
        overflow: true,
        tieGroupMayBeIncomplete: true,
        scanTruncated,
      };
    }
  }
  return { rows: all.slice(0, end), overflow, scanTruncated };
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('wait_for_new_turns: request aborted');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortReason(signal);
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/;

export interface WaitForNewTurnsOptions {
  /** Override the 1s default poll interval. Used by tests to keep them
   *  fast; production never overrides. NOT exposed via the MCP schema —
   *  tunable from in-process callers only. */
  pollIntervalMs?: number;
  /** Inject a clock so tests can drive deterministic poll deadlines. NOT
   *  used for next_since — that is derived from returned-turn timestamps
   *  (or echoes the caller's `since`), never from the wall clock. */
  now?: () => Date;
  /** MCP request cancellation. Stops the poll/sleep loop promptly. */
  signal?: AbortSignal;
}

export async function waitForNewTurns(
  storage: Storage,
  params: WaitForNewTurnsParams,
  options: WaitForNewTurnsOptions = {},
): Promise<WaitForNewTurnsResult> {
  // Defense-in-depth validation — schema enforces the same at the MCP
  // boundary, but in-process callers and tests come through here.
  // AC4 (057a): the previous "non-empty sources[]" check loosens to a
  // disjunction over `sources[]` and `source_prefix`. Pre-AC4 callers
  // passing `sources=[...]` with no `source_prefix` hit exactly the same
  // accept path. The /non-empty/ phrasing is preserved in the error
  // message so legacy tests asserting on it still match.
  const hasSources = params.sources !== undefined && params.sources.length > 0;
  const hasSourcePrefix = params.source_prefix !== undefined && params.source_prefix.length > 0;
  if (!hasSources && !hasSourcePrefix) {
    throw new Error(
      'wait_for_new_turns: at least one of sources[] (non-empty) or source_prefix (non-empty) must be present',
    );
  }
  if (hasSources && params.sources!.length > WAIT_MAX_SOURCES) {
    throw new Error(`wait_for_new_turns: sources exceeds max ${WAIT_MAX_SOURCES} per call`);
  }
  if (params.since === undefined || !ISO_RE.test(params.since)) {
    throw new Error('wait_for_new_turns: since must be a valid ISO 8601 timestamp');
  }
  const since = canonicalizeTimestamp(params.since);

  // Item 037 / AC5: validate + normalise repo_path before the poll loop
  // so a bad input fails immediately rather than after the first timeout.
  let repoPath: ResolvedRepoPath | null = null;
  if (params.repo_path !== undefined) {
    assertAbsoluteRepoPath('wait_for_new_turns', params.repo_path);
    repoPath = await resolveRepoPath(params.repo_path);
  }

  let timeoutSec = params.timeout ?? WAIT_DEFAULT_TIMEOUT_SECONDS;
  if (timeoutSec > WAIT_MAX_TIMEOUT_SECONDS) timeoutSec = WAIT_MAX_TIMEOUT_SECONDS;
  if (timeoutSec < 0) timeoutSec = 0;

  const pollIntervalMs = options.pollIntervalMs ?? WAIT_DEFAULT_POLL_INTERVAL_MS;
  const now = options.now ?? (() => new Date());
  const signal = options.signal;

  // AC4 (057a): build the resolved query set from `sources[]` (when
  // present) and append a caller-supplied `source_prefix` (when present)
  // to the prefix list. `pollOnce` then fans out one query per exact + one
  // query per prefix and merges by atom id — which is precisely the
  // "union of two filters" semantic AC4 requires, with dedup-by-id falling
  // out of the existing merged Map<string, CaptureEvent>.
  const resolved = hasSources
    ? resolveSources(params.sources!)
    : { exact: [] as string[], prefixes: [] as string[] };
  if (hasSourcePrefix) {
    if (!resolved.prefixes.includes(params.source_prefix!)) {
      resolved.prefixes.push(params.source_prefix!);
    }
  }
  if (resolved.exact.length === 0 && resolved.prefixes.length === 0) {
    // sources[] was non-empty but nothing resolved — caller passed strings
    // that aren't source_apps but also pass schema (any string). Return
    // empty + a guidance warning rather than blocking forever.
    return {
      schema_version: SCHEMA_VERSION,
      tool: 'wait_for_new_turns',
      turn_ids: [],
      // Lossless-chaining contract: nothing delivered → echo the
      // canonicalized `since` back. Never a wall-clock read.
      next_since: since,
      timed_out: true,
      warnings: ['wait_for_new_turns: no sources resolved to a query'],
    };
  }

  const startMs = now().getTime();
  const deadlineMs = startMs + timeoutSec * 1000;

  // Initial poll first (no wait) — common case is "content is already
  // there"; the long-poll's whole point is to NOT round-trip the wait
  // when there's nothing newer than `since`.
  throwIfAborted(signal);
  let page = await pollOnce(storage, resolved, since, repoPath);
  while (
    page.rows.length === 0 &&
    page.scanTruncated !== true &&
    now().getTime() < deadlineMs
  ) {
    // Sleep then re-poll. Cap the sleep at remaining-time so we don't
    // overshoot the deadline by up to one poll interval.
    const remaining = deadlineMs - now().getTime();
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining), signal);
    throwIfAborted(signal);
    page = await pollOnce(storage, resolved, since, repoPath);
  }

  // Lossless chaining (Fix ⑤): next_since is NEVER the wall clock. Atom
  // timestamps are EVENT times that can land in storage after ingest lag — a
  // wall-clock next_since
  // ran AHEAD of delivered data, so a turn that occurred before our return
  // moment but ingested after the final poll was permanently invisible to
  // every chained call (strict `> since`). Instead:
  //   • turns returned → next_since = max timestamp among RETURNED turns
  //     (rows are ASC-sorted, so the last row's stored canonical-Z value);
  //   • timed out empty → next_since = the canonicalized caller `since`,
  //     echoed back — nothing was delivered, so re-delivery is impossible
  //     and nothing can be skipped.
  const { rows, overflow, tieGroupMayBeIncomplete, scanTruncated } = page;
  const next_since = rows.length > 0 ? rows[rows.length - 1]!.timestamp : since;
  const timed_out = rows.length === 0;
  const warnings: string[] = [];
  if (overflow) {
    warnings.push(
      `wait_for_new_turns: more than ${WAIT_MAX_RETURNED_TURNS} new turns matched; returning the oldest ${rows.length} — chain immediately with next_since to page through the backlog`,
    );
  }
  if (tieGroupMayBeIncomplete === true) {
    warnings.push(
      `wait_for_new_turns: a single same-timestamp group exceeded the per-source fetch window (${WAIT_PER_POLL_LIMIT_PER_SOURCE}); its unfetched members share next_since's timestamp and the chained strict-after call may skip them — recover the full set via search_memories with since just before next_since`,
    );
  }
  if (scanTruncated === true) {
    warnings.push(
      `wait_for_new_turns: bounded storage scan exhausted after ${WAIT_MAX_STORAGE_SCAN_WINDOWS} windows; older matches may remain — narrow since/source scope and retry`,
    );
  }

  return {
    schema_version: SCHEMA_VERSION,
    tool: 'wait_for_new_turns',
    turn_ids: rows.map((r) => r.id),
    next_since,
    timed_out,
    warnings,
  };
}

// Item 038 / AC4: turn_ids only on the wire — bodies are NOT bundled into
// the wake envelope. Caller composes `get_atoms(turn_ids)` for summaries or
// `get_atom(turn_ids[i])` for one verbatim atom.
const waitOutputSchema = {
  schema_version: z.literal(1),
  tool: z.literal('wait_for_new_turns'),
  turn_ids: z.array(z.string()),
  next_since: z.string(),
  timed_out: z.boolean(),
  warnings: z.array(z.string()),
};

export function registerWaitForNewTurns(server: McpServer, storage: Storage): void {
  server.registerTool(
    'wait_for_new_turns',
    {
      description: WAIT_FOR_NEW_TURNS_DESCRIPTION,
      inputSchema: {
        // AC4 (057a): `sources` is now optional at the schema level — the
        // one-of-required disjunction with `source_prefix` is enforced in
        // `waitForNewTurns()` so the structured validation error
        // surfaces both empty-array and both-absent cases under one
        // contract. Pre-AC4 callers passing `sources=[...]` are
        // schema-byte-identical (max-length cap preserved; the only
        // change is removal of the .min(1) lower bound).
        sources: z.array(z.string().min(1).max(4096)).max(WAIT_MAX_SOURCES).optional(),
        source_prefix: z
          .string()
          .min(1)
          .max(4096)
          .optional()
          .describe(
            'Prefix filter. When combined with sources, results are the union. At least one non-empty selector is required.',
          ),
        since: isoString,
        timeout: z.number().int().min(0).max(WAIT_MAX_TIMEOUT_SECONDS).optional(),
        repo_path: z
          .string()
          .max(4096)
          .optional()
          .describe(
            'Absolute project root. AND-filters each source query by canonical project identity.',
          ),
      },
      outputSchema: waitOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input, extra) => {
      const params = input as WaitForNewTurnsParams;
      let result: WaitForNewTurnsResult;
      try {
        result = await waitForNewTurns(storage, params, { signal: extra.signal });
      } catch (err) {
        if (extra.signal.aborted) throw err;
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
