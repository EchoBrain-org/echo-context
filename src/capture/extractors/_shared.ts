import {
  existsSync,
  watch as watchFs,
  type FSWatcher as NativeFSWatcher,
} from "node:fs";
import { createHash } from "node:crypto";
import { open, opendir, stat } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import type { FSWatcher } from "chokidar";
import type {
  ExtractorHandle,
  ExtractorHealthState,
  FreshnessProbe,
} from "../contracts.js";
import type { Logger } from "../../logging/index.js";
import { BoundedLruMap } from "../../util/bounded-lru-map.js";

export type {
  ExtractorHandle,
  ExtractorHealth,
  ExtractorHealthState,
  FreshnessProbe,
} from "../contracts.js";

export function dedupStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

// Test factories retain the historical chokidar option shape. Production
// uses one native recursive FSEvents watcher, which does not build a JS entry
// index proportional to the number of historical files.
export const JSONL_WATCH_OPTS = {
  ignoreInitial: true,
  persistent: true,
  awaitWriteFinish: false,
  usePolling: true,
  interval: 1000,
} as const;

const JSONL_RECONCILIATION_INTERVAL_MS = 60_000;

function nativeJsonlWatcher(prefix: string): FSWatcher {
  const emitter = new EventEmitter();
  let native: NativeFSWatcher | undefined;
  if (existsSync(prefix)) {
    try {
      native = watchFs(
        prefix,
        { persistent: true, recursive: true },
        (_eventType, filename) => {
          if (filename === null) {
            emitter.emit("raw", "unknown", undefined, undefined);
            return;
          }
          emitter.emit("change", join(prefix, filename.toString()));
        },
      );
      native.on("error", (err) => emitter.emit("error", err));
    } catch (err) {
      setImmediate(() => emitter.emit("error", err));
    }
  }
  setImmediate(() => emitter.emit("ready"));
  const watcher = emitter as unknown as FSWatcher;
  watcher.close = async () => {
    native?.close();
  };
  return watcher;
}

/** Maximum unread JSONL bytes materialized by one handler invocation. */
export const MAX_JSONL_READ_BYTES = 4 * 1024 * 1024;
export const MAX_JSONL_RAW_FRAGMENT_BYTES = 512 * 1024;
export const JSONL_RAW_FRAGMENT_CONTENT_PREFIX =
  "ECHO_CONTEXT_OVERSIZED_JSONL_FRAGMENT_BASE64\n";
export const MAX_EXTRACTOR_RESOURCE_CACHE_ENTRIES = 1024;
const JSONL_CHECKPOINT_BOUNDARY_BYTES = 4 * 1024;

/** A small, content-free description of the source file that an offset was
 * measured against. It is persisted in the capture-checkpoint state so an
 * equal-sized replacement (or an in-place rewrite) cannot be mistaken for an
 * append-only continuation after a daemon restart. */
export interface JsonlCheckpointSource {
  identity: string;
  /** Opaque stat token for detecting same-size writes across a crash. */
  change_token?: string;
  size: number;
  boundary_offset: number;
  boundary_bytes: number;
  boundary_sha256: string;
  page_start_offset?: number;
  page_through_offset?: number;
  page_sha256?: string;
  generation: number;
}

export interface JsonlSourceInspection {
  identity: string;
  change_token?: string;
  size: number;
  boundary_offset: number;
  boundary_bytes: number;
  /** Undefined only when boundary_offset is beyond the current EOF. */
  boundary_sha256?: string;
  page_start_offset?: number;
  page_through_offset?: number;
  /** Undefined when the expected page now extends beyond EOF. */
  page_sha256?: string;
}

/** Bounded proof for the exact unread byte page parsed by an extractor.
 * Callers cannot access raw bytes through this proof. The explicit fragment
 * visitor below is the sole bounded path for preserving an oversized range. */
export interface JsonlReadSnapshot {
  identity: string;
  change_token: string;
  size: number;
  first_offset: number;
  through_offset: number;
  page_sha256: string;
  sourceAt: (
    offset: number,
    pageThroughOffset?: number,
  ) => JsonlSourceInspection;
  /** Derive a proof for a subrange without exposing or copying raw content. */
  rangeAt: (firstOffset: number, throughOffset: number) => JsonlReadSnapshot;
}

export interface JsonlRawFallback {
  cluster_start_offset: number;
  next_fragment: number;
  group_generation: number;
}

export interface JsonlRawFragment {
  start_offset: number;
  through_offset: number;
  bytes: number;
  sha256: string;
  base64: string;
}

export type JsonlDiscontinuity =
  | "truncated"
  | "replaced"
  | "rewritten"
  | "page_rewritten"
  | "checkpoint_state_mismatch";

export class JsonlSourceChangedError extends Error {
  constructor(jsonlPath: string) {
    super(`JSONL source changed while capturing ${jsonlPath}`);
    this.name = "JsonlSourceChangedError";
  }
}

function jsonlFileIdentity(st: {
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
}): string {
  return `${st.dev}:${st.ino}:${st.birthtimeNs}`;
}

function jsonlFileChangeToken(st: {
  ctimeNs: bigint;
  mtimeNs: bigint;
}): string {
  return `${st.ctimeNs}:${st.mtimeNs}`;
}

/** Inspect a fixed boundary window plus, when supplied, one persisted bounded
 * page proof. The handle is re-statted so metadata and bytes cannot come from
 * different versions of a same-inode file. */
export async function inspectJsonlSource(
  jsonlPath: string,
  boundaryOffset: number,
  expectedPage?: JsonlCheckpointSource,
): Promise<JsonlSourceInspection> {
  if (!Number.isSafeInteger(boundaryOffset) || boundaryOffset < 0) {
    throw new RangeError(
      "JSONL checkpoint offset must be a non-negative safe integer",
    );
  }
  const fh = await open(jsonlPath, "r");
  try {
    const before = await fh.stat({ bigint: true });
    if (before.size < 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError(
        `JSONL source size is outside the safe integer range at ${jsonlPath}`,
      );
    }
    const size = Number(before.size);
    const identity = jsonlFileIdentity(before);
    const inspection: JsonlSourceInspection = {
      identity,
      change_token: jsonlFileChangeToken(before),
      size,
      boundary_offset: boundaryOffset,
      boundary_bytes: 0,
    };
    if (boundaryOffset <= size) {
      const boundaryBytes = Math.min(
        boundaryOffset,
        JSONL_CHECKPOINT_BOUNDARY_BYTES,
      );
      const buffer = Buffer.alloc(boundaryBytes);
      let bytesRead = 0;
      while (bytesRead < boundaryBytes) {
        const result = await fh.read(
          buffer,
          bytesRead,
          boundaryBytes - bytesRead,
          boundaryOffset - boundaryBytes + bytesRead,
        );
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      if (bytesRead !== boundaryBytes) {
        throw new JsonlSourceChangedError(jsonlPath);
      }
      inspection.boundary_bytes = bytesRead;
      inspection.boundary_sha256 = createHash("sha256")
        .update(buffer.subarray(0, bytesRead))
        .digest("hex");
    }

    const pageStart = expectedPage?.page_start_offset;
    const pageThrough = expectedPage?.page_through_offset;
    const pageSha = expectedPage?.page_sha256;
    const hasAnyPageField =
      pageStart !== undefined ||
      pageThrough !== undefined ||
      pageSha !== undefined;
    if (hasAnyPageField) {
      if (
        !Number.isSafeInteger(pageStart) ||
        !Number.isSafeInteger(pageThrough) ||
        (pageStart as number) < 0 ||
        (pageThrough as number) < (pageStart as number) ||
        (pageThrough as number) - (pageStart as number) >
          MAX_JSONL_READ_BYTES ||
        typeof pageSha !== "string" ||
        !/^[a-f0-9]{64}$/.test(pageSha)
      ) {
        throw new RangeError("persisted JSONL page proof is invalid");
      }
      inspection.page_start_offset = pageStart as number;
      inspection.page_through_offset = pageThrough as number;
      if ((pageThrough as number) <= size) {
        if (
          expectedPage?.change_token === inspection.change_token &&
          expectedPage?.identity === inspection.identity
        ) {
          inspection.page_sha256 = pageSha;
        } else {
          const pageLength = (pageThrough as number) - (pageStart as number);
          const pageBuffer = Buffer.alloc(pageLength);
          let pageBytesRead = 0;
          while (pageBytesRead < pageLength) {
            const result = await fh.read(
              pageBuffer,
              pageBytesRead,
              pageLength - pageBytesRead,
              (pageStart as number) + pageBytesRead,
            );
            if (result.bytesRead === 0) break;
            pageBytesRead += result.bytesRead;
          }
          if (pageBytesRead !== pageLength) {
            throw new JsonlSourceChangedError(jsonlPath);
          }
          inspection.page_sha256 = createHash("sha256")
            .update(pageBuffer)
            .digest("hex");
        }
      }
    }

    const after = await fh.stat({ bigint: true });
    if (
      jsonlFileIdentity(after) !== identity ||
      jsonlFileChangeToken(after) !== inspection.change_token ||
      after.size !== before.size
    ) {
      throw new JsonlSourceChangedError(jsonlPath);
    }
    return inspection;
  } finally {
    await fh.close();
  }
}

/** Recheck the exact identity and already-durable byte boundary observed
 * before a tail read. This runs before candidates cross the storage boundary,
 * so an atomic replacement or truncate/regrow race is retried under a new
 * generation instead of being appended under the prior file's generation. */
export async function assertJsonlSourceSnapshotCurrent(
  jsonlPath: string,
  expected: JsonlSourceInspection,
): Promise<void> {
  const current = await inspectJsonlSource(jsonlPath, expected.boundary_offset);
  if (
    current.identity !== expected.identity ||
    current.boundary_bytes !== expected.boundary_bytes ||
    current.boundary_sha256 !== expected.boundary_sha256
  ) {
    throw new JsonlSourceChangedError(jsonlPath);
  }
}

/** Verify the complete bounded byte page used for parsing, not merely the
 * already-durable boundary before it. Replacements and same-inode rewrites
 * therefore fail before any candidate is appended. */
export async function assertJsonlReadSnapshotCurrent(
  jsonlPath: string,
  expected: JsonlReadSnapshot,
): Promise<void> {
  const length = expected.through_offset - expected.first_offset;
  if (
    !Number.isSafeInteger(expected.first_offset) ||
    !Number.isSafeInteger(expected.through_offset) ||
    expected.first_offset < 0 ||
    length < 0 ||
    length > MAX_JSONL_READ_BYTES
  ) {
    throw new RangeError("JSONL read snapshot is outside its byte budget");
  }
  const fh = await open(jsonlPath, "r");
  try {
    const before = await fh.stat({ bigint: true });
    if (
      jsonlFileIdentity(before) !== expected.identity ||
      before.size < BigInt(expected.through_offset)
    ) {
      throw new JsonlSourceChangedError(jsonlPath);
    }
    // ctime cannot be restored by the writer. When it is unchanged, the same
    // inode has not been written since the page was read, so no content read
    // is necessary. On change, hash the bounded cumulative page proof to
    // distinguish a benign append beyond it from a rewrite within it.
    if (jsonlFileChangeToken(before) === expected.change_token) {
      const unchanged = await fh.stat({ bigint: true });
      if (
        jsonlFileIdentity(unchanged) === expected.identity &&
        unchanged.size >= BigInt(expected.through_offset) &&
        jsonlFileChangeToken(unchanged) === expected.change_token
      ) {
        return;
      }
    }
    const buffer = Buffer.alloc(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const result = await fh.read(
        buffer,
        bytesRead,
        length - bytesRead,
        expected.first_offset + bytesRead,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const after = await fh.stat({ bigint: true });
    const digest = createHash("sha256")
      .update(buffer.subarray(0, bytesRead))
      .digest("hex");
    if (
      bytesRead !== length ||
      jsonlFileIdentity(after) !== expected.identity ||
      jsonlFileChangeToken(after) !== jsonlFileChangeToken(before) ||
      after.size < BigInt(expected.through_offset) ||
      digest !== expected.page_sha256
    ) {
      throw new JsonlSourceChangedError(jsonlPath);
    }
  } finally {
    await fh.close();
  }
}

/** Parse only the exact small schema emitted by the extractors. Legacy
 * checkpoints have no source state and intentionally return undefined. */
export function readJsonlCheckpointSource(
  state: Record<string, unknown> | undefined,
  stateKey = "jsonl_source",
): JsonlCheckpointSource | undefined {
  const raw = state?.[stateKey];
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError("capture checkpoint jsonl_source state is invalid");
  }
  const source = raw as Record<string, unknown>;
  const identity = source["identity"];
  const size = source["size"];
  const boundaryOffset = source["boundary_offset"];
  const boundaryBytes = source["boundary_bytes"];
  const boundarySha256 = source["boundary_sha256"];
  const pageStartOffset = source["page_start_offset"];
  const pageThroughOffset = source["page_through_offset"];
  const pageSha256 = source["page_sha256"];
  const generation = source["generation"];
  const changeToken = source["change_token"];
  const pageFieldCount = [
    pageStartOffset,
    pageThroughOffset,
    pageSha256,
  ].filter((value) => value !== undefined).length;
  if (
    typeof identity !== "string" ||
    identity.length === 0 ||
    !Number.isSafeInteger(size) ||
    (size as number) < 0 ||
    !Number.isSafeInteger(boundaryOffset) ||
    (boundaryOffset as number) < 0 ||
    !Number.isSafeInteger(boundaryBytes) ||
    (boundaryBytes as number) < 0 ||
    (boundaryBytes as number) > JSONL_CHECKPOINT_BOUNDARY_BYTES ||
    (changeToken !== undefined &&
      (typeof changeToken !== "string" ||
        !/^\d+:\d+$/.test(changeToken) ||
        changeToken.length > 96)) ||
    (pageFieldCount !== 0 && pageFieldCount !== 3) ||
    (pageFieldCount === 3 &&
      (!Number.isSafeInteger(pageStartOffset) ||
        (pageStartOffset as number) < 0 ||
        !Number.isSafeInteger(pageThroughOffset) ||
        (pageThroughOffset as number) < (pageStartOffset as number) ||
        (pageThroughOffset as number) - (pageStartOffset as number) >
          MAX_JSONL_READ_BYTES ||
        (pageStartOffset as number) > (boundaryOffset as number) ||
        (pageThroughOffset as number) < (boundaryOffset as number) ||
        typeof pageSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(pageSha256))) ||
    typeof boundarySha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(boundarySha256) ||
    !Number.isSafeInteger(generation) ||
    (generation as number) < 0
  ) {
    throw new TypeError("capture checkpoint jsonl_source state is invalid");
  }
  const parsed: JsonlCheckpointSource = {
    identity,
    size: size as number,
    boundary_offset: boundaryOffset as number,
    boundary_bytes: boundaryBytes as number,
    boundary_sha256: boundarySha256,
    generation: generation as number,
  };
  if (changeToken !== undefined) parsed.change_token = changeToken as string;
  if (pageFieldCount === 3) {
    parsed.page_start_offset = pageStartOffset as number;
    parsed.page_through_offset = pageThroughOffset as number;
    parsed.page_sha256 = pageSha256 as string;
  }
  return parsed;
}

export function readJsonlRawFallback(
  state: Record<string, unknown> | undefined,
  stateKey = "jsonl_raw_fallback",
): JsonlRawFallback | undefined {
  const raw = state?.[stateKey];
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError(
      "capture checkpoint jsonl_raw_fallback state is invalid",
    );
  }
  const value = raw as Record<string, unknown>;
  const clusterStartOffset = value["cluster_start_offset"];
  const nextFragment = value["next_fragment"];
  const groupGeneration = value["group_generation"];
  if (
    !Number.isSafeInteger(clusterStartOffset) ||
    (clusterStartOffset as number) < 0 ||
    !Number.isSafeInteger(nextFragment) ||
    (nextFragment as number) < 0 ||
    !Number.isSafeInteger(groupGeneration) ||
    (groupGeneration as number) < 0
  ) {
    throw new TypeError(
      "capture checkpoint jsonl_raw_fallback state is invalid",
    );
  }
  return {
    cluster_start_offset: clusterStartOffset as number,
    next_fragment: nextFragment as number,
    group_generation: groupGeneration as number,
  };
}

export function classifyJsonlPageProof(
  persisted: JsonlCheckpointSource,
  current: JsonlSourceInspection,
): "replaced" | "page_rewritten" | null {
  if (persisted.identity !== current.identity) return "replaced";
  if (persisted.page_start_offset === undefined) return null;
  if (
    current.page_start_offset !== persisted.page_start_offset ||
    current.page_through_offset !== persisted.page_through_offset ||
    current.page_sha256 !== persisted.page_sha256
  ) {
    return "page_rewritten";
  }
  return null;
}

export function classifyJsonlDiscontinuity(
  checkpointOffset: number,
  persisted: JsonlCheckpointSource | undefined,
  current: JsonlSourceInspection,
): JsonlDiscontinuity | null {
  if (current.size < checkpointOffset) return "truncated";
  if (persisted === undefined) return null;
  if (persisted.boundary_offset !== checkpointOffset) {
    return "checkpoint_state_mismatch";
  }
  if (persisted.identity !== current.identity) return "replaced";
  const pageDiscontinuity = classifyJsonlPageProof(persisted, current);
  if (pageDiscontinuity !== null) return pageDiscontinuity;
  if (
    persisted.page_start_offset === undefined &&
    persisted.change_token !== undefined &&
    current.change_token !== undefined &&
    current.size === persisted.size &&
    current.change_token !== persisted.change_token
  ) {
    return "rewritten";
  }
  if (
    current.boundary_sha256 === undefined ||
    persisted.boundary_bytes !== current.boundary_bytes ||
    persisted.boundary_sha256 !== current.boundary_sha256
  ) {
    return "rewritten";
  }
  return null;
}

export type JsonlCheckpointProofResult =
  | {
      status: "current";
      inspection: JsonlSourceInspection;
    }
  | {
      status: "changed";
      inspection: JsonlSourceInspection;
      discontinuity: JsonlDiscontinuity;
      /** The full inflight page changed, but the separately hashed cumulative
       * durable prefix did not. Recovery can therefore resume at the durable
       * offset without replaying already-accepted turns. */
      retry_at_durable_boundary: boolean;
    }
  | { status: "unstable" };

/** Inspect the full write-ahead page and the cumulative durable prefix as two
 * independent bounded proofs. A racing writer is reported as `unstable` and
 * must not mutate generation/checkpoint state. A full-page mismatch may resume
 * at the durable boundary only when the accepted-prefix proof independently
 * remains current; otherwise recovery must use the bounded page start. */
export async function inspectJsonlCheckpointProof(
  jsonlPath: string,
  checkpointOffset: number,
  source: JsonlCheckpointSource | undefined,
  inflightSource: JsonlCheckpointSource | undefined,
): Promise<JsonlCheckpointProofResult> {
  let current: JsonlSourceInspection;
  try {
    current = await inspectJsonlSource(
      jsonlPath,
      checkpointOffset,
      inflightSource ?? source,
    );
  } catch (err) {
    if (err instanceof JsonlSourceChangedError) return { status: "unstable" };
    throw err;
  }

  if (inflightSource === undefined) {
    const discontinuity = classifyJsonlDiscontinuity(
      checkpointOffset,
      source,
      current,
    );
    return discontinuity === null
      ? { status: "current", inspection: current }
      : {
          status: "changed",
          inspection: current,
          discontinuity,
          retry_at_durable_boundary: false,
        };
  }

  const inflightDiscontinuity = classifyJsonlPageProof(inflightSource, current);
  if (inflightDiscontinuity === null) {
    if (source === undefined) return { status: "current", inspection: current };
    // A matching full-page hash proves every byte of its accepted prefix. Use
    // the persisted prefix coordinates with the current identity/boundary
    // fields rather than issuing a redundant second read.
    const durableCurrent: JsonlSourceInspection = {
      ...current,
      ...(source.page_start_offset !== undefined
        ? {
            page_start_offset: source.page_start_offset,
            page_through_offset: source.page_through_offset,
            page_sha256: source.page_sha256,
          }
        : {}),
    };
    const durableDiscontinuity = classifyJsonlDiscontinuity(
      checkpointOffset,
      source,
      durableCurrent,
    );
    return durableDiscontinuity === null
      ? { status: "current", inspection: durableCurrent }
      : {
          status: "changed",
          inspection: durableCurrent,
          discontinuity: durableDiscontinuity,
          retry_at_durable_boundary: false,
        };
  }

  if (
    inflightDiscontinuity === "page_rewritten" &&
    source?.page_start_offset !== undefined
  ) {
    let durableCurrent: JsonlSourceInspection;
    try {
      durableCurrent = await inspectJsonlSource(
        jsonlPath,
        checkpointOffset,
        source,
      );
    } catch (err) {
      if (err instanceof JsonlSourceChangedError) {
        return { status: "unstable" };
      }
      throw err;
    }
    const durableDiscontinuity = classifyJsonlDiscontinuity(
      checkpointOffset,
      source,
      durableCurrent,
    );
    if (durableDiscontinuity === null) {
      return {
        status: "changed",
        inspection: durableCurrent,
        discontinuity: inflightDiscontinuity,
        retry_at_durable_boundary: true,
      };
    }
    return {
      status: "changed",
      inspection: durableCurrent,
      discontinuity: durableDiscontinuity,
      retry_at_durable_boundary: false,
    };
  }

  return {
    status: "changed",
    inspection: current,
    discontinuity: inflightDiscontinuity,
    retry_at_durable_boundary: false,
  };
}

export function makeJsonlCheckpointSource(
  inspection: JsonlSourceInspection,
  generation: number,
): JsonlCheckpointSource {
  if (inspection.boundary_sha256 === undefined) {
    throw new Error("cannot checkpoint a JSONL offset beyond the current EOF");
  }
  const source: JsonlCheckpointSource = {
    identity: inspection.identity,
    size: inspection.size,
    boundary_offset: inspection.boundary_offset,
    boundary_bytes: inspection.boundary_bytes,
    boundary_sha256: inspection.boundary_sha256,
    generation,
  };
  if (inspection.change_token !== undefined) {
    source.change_token = inspection.change_token;
  }
  if (
    inspection.page_start_offset !== undefined &&
    inspection.page_through_offset !== undefined &&
    inspection.page_sha256 !== undefined
  ) {
    source.page_start_offset = inspection.page_start_offset;
    source.page_through_offset = inspection.page_through_offset;
    source.page_sha256 = inspection.page_sha256;
  }
  return source;
}

export function createBoundedResourceCache<V>(): Map<string, V> {
  return new BoundedLruMap<string, V>(MAX_EXTRACTOR_RESOURCE_CACHE_ENTRIES);
}

/** Persistent non-zero gap = the watcher is dropping events. */
export async function probeFreshness(
  offsetMap: Map<string, { offset: number }>,
): Promise<FreshnessProbe> {
  const results = await Promise.all(
    Array.from(offsetMap, async ([path, entry]) => {
      try {
        const st = await stat(path);
        return { path, gap: st.size - entry.offset, ok: true as const };
      } catch {
        return { path, gap: 0, ok: false as const };
      }
    }),
  );
  let maxGapBytes = 0;
  let maxGapPath: string | null = null;
  let filesChecked = 0;
  for (const r of results) {
    if (!r.ok) continue;
    filesChecked += 1;
    if (r.gap > maxGapBytes) {
      maxGapBytes = r.gap;
      maxGapPath = r.path;
    }
  }
  return { maxGapBytes, maxGapPath, filesChecked };
}

/** Stream JSONL paths beneath `prefix` without materialising the directory
 *  tree. Only the current directory iterator (and its ancestors) are held. */
export async function* discoverJsonlPaths(
  prefix: string,
): AsyncGenerator<string> {
  let dir: Awaited<ReturnType<typeof opendir>>;
  try {
    dir = await opendir(prefix);
  } catch (err) {
    // Files and nested directories can disappear normally during rotation.
    // Treat that resource as gone; the watcher or periodic discovery will
    // observe it if it reappears. Other I/O failures remain health failures.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for await (const entry of dir) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) {
      yield* discoverJsonlPaths(path);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      yield path;
    }
  }
}

/** Visit boot files one-at-a-time. The callback is awaited before discovery
 *  advances, keeping both filesystem discovery and downstream work bounded. */
export async function bootScanJsonl(
  prefix: string,
  visit: (path: string) => Promise<boolean | void>,
  log: Logger,
): Promise<boolean> {
  try {
    for await (const path of discoverJsonlPaths(prefix)) {
      if ((await visit(path)) === false) break;
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      log.info("boot_scan_source_absent", { prefix });
      return true;
    }
    log.warn("boot_scan_failed", { prefix, message: (err as Error).message });
    return false;
  }
}

/** Read newly-appended lines from a JSONL file since `lastByteOffset`.
 *  Returns `null` on stat/open failures (caller should bail). On success,
 *  `lineEndOffsets` contains the exact file-byte boundary after each parallel
 *  `lines` entry. Blank lines are deliberately retained: they occupy bytes
 *  and therefore must advance a durable capture checkpoint even though the
 *  extractors ignore their content. The returned `lines` array is empty
 *  (with a defined `mtimeMs`) when the file has not grown or has no complete
 *  line. */
export async function readJsonlTail(
  jsonlPath: string,
  lastByteOffset: number,
  log: Logger,
): Promise<{
  lines: string[];
  lineEndOffsets: number[];
  firstLineOffset: number;
  mtimeMs: number;
  snapshot?: JsonlReadSnapshot;
} | null> {
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(jsonlPath);
  } catch (err) {
    log.warn("stat_failed", {
      path: jsonlPath,
      message: (err as Error).message,
    });
    return null;
  }
  if (st.size <= lastByteOffset) {
    return {
      lines: [],
      lineEndOffsets: [],
      firstLineOffset: lastByteOffset,
      mtimeMs: st.mtimeMs,
    };
  }

  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(jsonlPath, "r");
  } catch (err) {
    log.warn("open_failed", {
      path: jsonlPath,
      message: (err as Error).message,
    });
    return null;
  }
  try {
    const before = await fh.stat({ bigint: true });
    if (before.size < 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError(
        `JSONL source size is outside the safe integer range at ${jsonlPath}`,
      );
    }
    const sourceSize = Number(before.size);
    const sourceIdentity = jsonlFileIdentity(before);
    const mtimeMs = Number(before.mtimeMs);
    if (sourceSize <= lastByteOffset) {
      return {
        lines: [],
        lineEndOffsets: [],
        firstLineOffset: lastByteOffset,
        mtimeMs,
      };
    }

    const unreadLength = sourceSize - lastByteOffset;
    const unreadReadLength = Math.min(unreadLength, MAX_JSONL_READ_BYTES);
    const prefixStart = Math.max(
      0,
      lastByteOffset - JSONL_CHECKPOINT_BOUNDARY_BYTES,
    );
    const prefixLength = lastByteOffset - prefixStart;
    const totalReadLength = prefixLength + unreadReadLength;
    const buffer = Buffer.alloc(totalReadLength);
    let bytesRead = 0;
    while (bytesRead < totalReadLength) {
      const result = await fh.read(
        buffer,
        bytesRead,
        totalReadLength - bytesRead,
        prefixStart + bytesRead,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const after = await fh.stat({ bigint: true });
    if (
      bytesRead !== totalReadLength ||
      jsonlFileIdentity(after) !== sourceIdentity ||
      jsonlFileChangeToken(after) !== jsonlFileChangeToken(before) ||
      after.size < BigInt(prefixStart + totalReadLength) ||
      after.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new JsonlSourceChangedError(jsonlPath);
    }

    let lastNewline = -1;
    for (let index = bytesRead - 1; index >= prefixLength; index -= 1) {
      if (buffer[index] === 0x0a) {
        lastNewline = index - prefixLength;
        break;
      }
    }
    if (lastNewline === -1 && unreadLength <= MAX_JSONL_READ_BYTES) {
      return {
        lines: [],
        lineEndOffsets: [],
        firstLineOffset: lastByteOffset,
        mtimeMs,
      };
    }
    // If no newline fits in one full bounded page, expose an opaque proven
    // range instead of materialising an unbounded JSON record. A shorter
    // incomplete tail remains uncheckpointed until its terminating newline
    // arrives, so a partially written next-user record is never consumed raw.
    const consumableLength =
      lastNewline === -1 ? unreadReadLength : lastNewline + 1;
    const consumable = buffer.subarray(
      prefixLength,
      prefixLength + consumableLength,
    );
    const lines =
      lastNewline === -1
        ? []
        : consumable.toString("utf8").slice(0, -1).split("\n");
    const lineEndOffsets: number[] = [];
    if (lastNewline !== -1) {
      for (let index = 0; index <= lastNewline; index += 1) {
        if (consumable[index] === 0x0a) {
          lineEndOffsets.push(lastByteOffset + index + 1);
        }
      }
    }
    const throughOffset = lastByteOffset + consumableLength;
    const sourceAt = (
      offset: number,
      pageThroughOffset = offset,
    ): JsonlSourceInspection => {
      if (
        !Number.isSafeInteger(offset) ||
        offset < lastByteOffset ||
        offset > throughOffset ||
        !Number.isSafeInteger(pageThroughOffset) ||
        pageThroughOffset < offset ||
        pageThroughOffset > throughOffset
      ) {
        throw new RangeError(
          "checkpoint offset is outside the parsed JSONL page",
        );
      }
      const boundaryBytes = Math.min(offset, JSONL_CHECKPOINT_BOUNDARY_BYTES);
      const boundaryStart = offset - boundaryBytes;
      const relativeStart = boundaryStart - prefixStart;
      const relativeEnd = offset - prefixStart;
      if (relativeStart < 0 || relativeEnd > bytesRead) {
        throw new RangeError(
          "checkpoint boundary is outside the bound JSONL page",
        );
      }
      return {
        identity: sourceIdentity,
        change_token: jsonlFileChangeToken(after),
        size: Number(after.size),
        boundary_offset: offset,
        boundary_bytes: boundaryBytes,
        boundary_sha256: createHash("sha256")
          .update(buffer.subarray(relativeStart, relativeEnd))
          .digest("hex"),
        page_start_offset: lastByteOffset,
        page_through_offset: pageThroughOffset,
        page_sha256: createHash("sha256")
          .update(
            buffer.subarray(
              prefixLength,
              prefixLength + pageThroughOffset - lastByteOffset,
            ),
          )
          .digest("hex"),
      };
    };
    const rangeAt = (
      firstOffset: number,
      rangeThroughOffset: number,
    ): JsonlReadSnapshot => {
      if (
        !Number.isSafeInteger(firstOffset) ||
        !Number.isSafeInteger(rangeThroughOffset) ||
        firstOffset < lastByteOffset ||
        rangeThroughOffset < firstOffset ||
        rangeThroughOffset > throughOffset
      ) {
        throw new RangeError("JSONL range is outside the parsed byte page");
      }
      const relativeStart = prefixLength + firstOffset - lastByteOffset;
      const relativeEnd = prefixLength + rangeThroughOffset - lastByteOffset;
      return {
        identity: sourceIdentity,
        change_token: jsonlFileChangeToken(after),
        size: Number(after.size),
        first_offset: firstOffset,
        through_offset: rangeThroughOffset,
        page_sha256: createHash("sha256")
          .update(buffer.subarray(relativeStart, relativeEnd))
          .digest("hex"),
        sourceAt,
        rangeAt,
      };
    };
    const snapshot = rangeAt(lastByteOffset, throughOffset);
    return {
      lines,
      lineEndOffsets,
      firstLineOffset: lastByteOffset,
      mtimeMs,
      snapshot,
    };
  } finally {
    await fh.close();
  }
}

/** Keep one asynchronous storage operation bound to the exact source page.
 * If the operation itself fails, a concurrent source rewrite takes
 * precedence so the extractor can rewind and retry under a new generation. */
export async function withJsonlReadSnapshot<T>(
  jsonlPath: string,
  snapshot: JsonlReadSnapshot,
  operation: () => Promise<T>,
): Promise<T> {
  await assertJsonlReadSnapshotCurrent(jsonlPath, snapshot);
  try {
    const result = await operation();
    await assertJsonlReadSnapshotCurrent(jsonlPath, snapshot);
    return result;
  } catch (err) {
    await assertJsonlReadSnapshotCurrent(jsonlPath, snapshot);
    throw err;
  }
}

/** Visit exact bounded source fragments without ever retaining more than one
 * fragment in memory. Every visitor call is wrapped by the fragment's source
 * proof, so a rewrite wins over a concurrent append/checkpoint operation. */
export async function visitJsonlRawFragments(
  jsonlPath: string,
  snapshot: JsonlReadSnapshot,
  throughOffset: number,
  startIndex: number,
  visit: (fragment: JsonlRawFragment, index: number) => Promise<void>,
): Promise<number> {
  if (
    !Number.isSafeInteger(throughOffset) ||
    throughOffset < snapshot.first_offset ||
    throughOffset > snapshot.through_offset ||
    !Number.isSafeInteger(startIndex) ||
    startIndex < 0
  ) {
    throw new RangeError("raw JSONL fragment range is outside its page proof");
  }
  const fragmentCount = Math.ceil(
    (throughOffset - snapshot.first_offset) / MAX_JSONL_RAW_FRAGMENT_BYTES,
  );
  if (startIndex > Number.MAX_SAFE_INTEGER - fragmentCount) {
    throw new RangeError("raw JSONL fragment index exceeds safe integer range");
  }
  let offset = snapshot.first_offset;
  let index = startIndex;
  while (offset < throughOffset) {
    const end = Math.min(throughOffset, offset + MAX_JSONL_RAW_FRAGMENT_BYTES);
    const proof = snapshot.rangeAt(offset, end);
    await withJsonlReadSnapshot(jsonlPath, proof, async () => {
      const fh = await open(jsonlPath, "r");
      try {
        const buffer = Buffer.alloc(end - offset);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
          const result = await fh.read(
            buffer,
            bytesRead,
            buffer.length - bytesRead,
            offset + bytesRead,
          );
          if (result.bytesRead === 0) break;
          bytesRead += result.bytesRead;
        }
        if (bytesRead !== buffer.length) {
          throw new JsonlSourceChangedError(jsonlPath);
        }
        const digest = createHash("sha256").update(buffer).digest("hex");
        if (digest !== proof.page_sha256) {
          throw new JsonlSourceChangedError(jsonlPath);
        }
        await assertJsonlReadSnapshotCurrent(jsonlPath, proof);
        await visit(
          {
            start_offset: offset,
            through_offset: end,
            bytes: buffer.length,
            sha256: digest,
            base64: buffer.toString("base64"),
          },
          index,
        );
      } finally {
        await fh.close();
      }
    });
    offset = end;
    index += 1;
  }
  return index;
}

/** Wire up a native watcher + serialised processing queue + boot scan for a
 *  JSONL prefix. Returns an `ExtractorHandle` whose `stop` shuts the watcher
 *  and drains the queue. Caller supplies the per-file handler and the offset
 *  map the freshness probe should read. */
export async function wireJsonlExtractor(opts: {
  prefix: string;
  offsetMap: Map<string, { offset: number }>;
  handle: (path: string) => Promise<void>;
  log: Logger;
  /** Exact durable offset lookup used only on bounded-cache misses. */
  getPersistedOffset?: (path: string) => Promise<number>;
  /** Optional source-identity check. This catches equal-sized replacement
   * files that an offset-only comparison would incorrectly treat as done. */
  isCheckpointCurrent?: (path: string) => Promise<boolean>;
  /** Maximum number of distinct paths waiting behind the active handler. */
  maxPendingPaths?: number;
  /** Maximum paths inspected per reconciliation turn before live work wins. */
  reconciliationBatchSize?: number;
  /** Test seam; production callers use a native recursive fs.watch. */
  watcherFactory?: (
    prefix: string,
    options: typeof JSONL_WATCH_OPTS,
  ) => FSWatcher;
}): Promise<ExtractorHandle> {
  const { prefix, offsetMap, handle, log } = opts;
  const maxPendingPaths = positiveInteger(opts.maxPendingPaths, 1024);
  const reconciliationBatchSize = positiveInteger(
    opts.reconciliationBatchSize,
    64,
  );

  let healthState: ExtractorHealthState = "starting";
  let stopped = false;
  let initialScanRunning = true;
  let overflowCount = 0;
  let errorCount = 0;
  let lastError: string | null = null;
  let sourceStatus: "active" | "absent" = existsSync(prefix)
    ? "active"
    : "absent";
  let activePath: string | null = null;
  let activePathDirty = false;
  let worker: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let reconciliationRequested = false;
  let reconciliationEpoch = 0;
  let reconciliationScanEpoch = 0;
  let reconciliationIterator: AsyncIterator<string> | null = null;
  const pendingPaths = new Set<string>();
  const pendingDrainWaiters = new Set<() => void>();
  const idleWaiters = new Set<() => void>();

  function isJsonl(p: string): boolean {
    return p.startsWith(prefix) && p.endsWith(".jsonl");
  }

  function pendingDrained(): boolean {
    return stopped || (activePath === null && pendingPaths.size === 0);
  }

  function fullyIdle(): boolean {
    return pendingDrained() && (stopped || !reconciliationRequested);
  }

  function notifyWaiters(): void {
    if (pendingDrained()) {
      for (const resolve of pendingDrainWaiters) resolve();
      pendingDrainWaiters.clear();
    }
    if (fullyIdle()) {
      for (const resolve of idleWaiters) resolve();
      idleWaiters.clear();
    }
  }

  function waitForPendingDrain(): Promise<void> {
    if (pendingDrained()) return Promise.resolve();
    return new Promise((resolve) => pendingDrainWaiters.add(resolve));
  }

  function waitForIdle(): Promise<void> {
    if (fullyIdle()) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.add(resolve));
  }

  async function handleSafely(path: string): Promise<void> {
    activePath = path;
    activePathDirty = false;
    const offsetBefore = offsetMap.get(path)?.offset ?? 0;
    let retryAfterTransientChange = false;
    try {
      await handle(path);
    } catch (err) {
      if (err instanceof JsonlSourceChangedError) {
        retryAfterTransientChange = true;
        log.warn("handler_source_changed", { path });
      } else if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // A delete/rename gap is expected during log rotation. Do not poison
        // health permanently; an add/change event will enqueue the new file.
        log.debug("handler_source_absent", { path });
      } else {
        const message = (err as Error).message;
        errorCount += 1;
        lastError = message;
        healthState = "unhealthy";
        log.error("handler_error", { path, message });
      }
    } finally {
      activePath = null;
      let rerun = activePathDirty || retryAfterTransientChange;
      const offsetAfter = offsetMap.get(path)?.offset ?? 0;
      if (!rerun && offsetAfter !== offsetBefore) {
        rerun = await pathNeedsCatchUp(path);
      } else if (!rerun && offsetAfter === offsetBefore) {
        try {
          const current = await stat(path);
          if (current.size - offsetAfter > MAX_JSONL_READ_BYTES) {
            const message =
              `JSONL parser made no checkpoint progress within ` +
              `${MAX_JSONL_READ_BYTES} bytes at ${path}`;
            errorCount += 1;
            lastError = message;
            healthState = "unhealthy";
            log.error("checkpoint_stalled", { path, message });
          }
        } catch {
          // A disappearing file is handled by the next watcher add event.
        }
      }
      activePathDirty = false;
      if (rerun) queuePath(path);
      notifyWaiters();
    }
  }

  async function pathNeedsCatchUp(path: string): Promise<boolean> {
    try {
      const current = await stat(path);
      if (
        opts.isCheckpointCurrent !== undefined &&
        !(await opts.isCheckpointCurrent(path))
      ) {
        return true;
      }
      let known = offsetMap.get(path)?.offset;
      if (known === undefined && opts.getPersistedOffset !== undefined) {
        known = await opts.getPersistedOffset(path);
      }
      return known !== current.size;
    } catch (err) {
      // The file may disappear after stat but before the identity probe. A
      // later add/change event will enqueue it if it reappears.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  function requestReconciliation(path: string): void {
    overflowCount += 1;
    reconciliationEpoch += 1;
    reconciliationRequested = true;
    if (overflowCount === 1 || overflowCount % 100 === 0) {
      log.warn("pending_queue_overflow", {
        path,
        max_pending_paths: maxPendingPaths,
        overflow_count: overflowCount,
      });
    }
  }

  function queuePath(path: string): void {
    if (stopped) return;
    if (activePath === path) {
      activePathDirty = true;
      return;
    }
    if (pendingPaths.has(path)) return;
    if (pendingPaths.size >= maxPendingPaths) {
      requestReconciliation(path);
      kickWorker();
      return;
    }
    pendingPaths.add(path);
    kickWorker();
  }

  async function runReconciliationBatch(): Promise<void> {
    if (reconciliationIterator === null) {
      reconciliationIterator =
        discoverJsonlPaths(prefix)[Symbol.asyncIterator]();
      reconciliationScanEpoch = reconciliationEpoch;
    }

    try {
      for (
        let inspected = 0;
        inspected < reconciliationBatchSize;
        inspected += 1
      ) {
        if (stopped || reconciliationIterator === null) return;
        const next = await reconciliationIterator.next();
        if (next.done === true) {
          reconciliationIterator = null;
          if (reconciliationScanEpoch === reconciliationEpoch) {
            reconciliationRequested = false;
          }
          notifyWaiters();
          return;
        }
        if (await pathNeedsCatchUp(next.value)) {
          await handleSafely(next.value);
        }
      }
    } catch (err) {
      reconciliationIterator = null;
      reconciliationRequested = false;
      const message = (err as Error).message;
      errorCount += 1;
      lastError = message;
      healthState = "unhealthy";
      log.warn("reconciliation_failed", {
        prefix,
        message,
      });
      notifyWaiters();
    }
  }

  function kickWorker(): void {
    if (stopped || worker !== null) return;
    // Defer the worker body by one microtask so `worker` is assigned before a
    // no-work run can reach its synchronous `finally` and clear the slot.
    worker = Promise.resolve().then(async () => {
      try {
        while (!stopped) {
          const next = pendingPaths.values().next();
          if (next.done !== true) {
            pendingPaths.delete(next.value);
            await handleSafely(next.value);
            continue;
          }
          if (!initialScanRunning && reconciliationRequested) {
            await runReconciliationBatch();
            continue;
          }
          break;
        }
      } finally {
        worker = null;
        notifyWaiters();
        if (
          !stopped &&
          (pendingPaths.size > 0 ||
            (!initialScanRunning && reconciliationRequested))
        ) {
          kickWorker();
        }
      }
    });
  }

  const watcher: FSWatcher =
    opts.watcherFactory?.(prefix, JSONL_WATCH_OPTS) ??
    nativeJsonlWatcher(prefix);

  let resolveWatcherReady: () => void = () => undefined;
  let watcherReadySettled = false;
  const watcherReady = new Promise<void>((resolve) => {
    resolveWatcherReady = () => {
      if (watcherReadySettled) return;
      watcherReadySettled = true;
      resolve();
    };
  });

  function dispatch(p: string): void {
    if (isJsonl(p)) {
      sourceStatus = "active";
      queuePath(p);
    }
  }

  watcher.on("add", dispatch);
  watcher.on("change", dispatch);
  watcher.once("ready", resolveWatcherReady);
  watcher.on("error", (err: unknown) => {
    const message = (err as Error).message;
    errorCount += 1;
    lastError = message;
    healthState = "unhealthy";
    log.error("watcher_error", { message });
    // A watcher startup error must not leave initialCatchUp pending forever;
    // the boot scan can still reconcile files that are already on disk.
    resolveWatcherReady();
  });
  watcher.on("raw", () => {
    if (stopped) return;
    reconciliationEpoch += 1;
    reconciliationRequested = true;
    kickWorker();
  });

  let cachedProbe: Promise<void> | null = null;
  let cachedProbeCursor = 0;
  let periodicDiscoveryIterator: AsyncIterator<string> | null = null;
  const reconciliationTimer = setInterval(() => {
    if (stopped || cachedProbe !== null) return;
    cachedProbe = (async () => {
      try {
        const paths = Array.from(offsetMap.keys());
        const checks = Math.min(reconciliationBatchSize, paths.length);
        for (let index = 0; index < checks && !stopped; index += 1) {
          const path = paths[(cachedProbeCursor + index) % paths.length];
          if (path !== undefined && (await pathNeedsCatchUp(path)))
            queuePath(path);
        }
        if (paths.length > 0) {
          cachedProbeCursor = (cachedProbeCursor + checks) % paths.length;
        }
        if (periodicDiscoveryIterator === null) {
          periodicDiscoveryIterator =
            discoverJsonlPaths(prefix)[Symbol.asyncIterator]();
        }
        for (
          let inspected = 0;
          inspected < reconciliationBatchSize && !stopped;
          inspected += 1
        ) {
          const next = await periodicDiscoveryIterator.next();
          if (next.done === true) {
            periodicDiscoveryIterator = null;
            break;
          }
          if (await pathNeedsCatchUp(next.value)) queuePath(next.value);
        }
      } catch (err) {
        periodicDiscoveryIterator = null;
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          sourceStatus = "absent";
          return;
        }
        const message = (err as Error).message;
        errorCount += 1;
        lastError = message;
        healthState = "unhealthy";
        log.warn("periodic_discovery_failed", { prefix, message });
      } finally {
        cachedProbe = null;
      }
    })();
  }, JSONL_RECONCILIATION_INTERVAL_MS);
  reconciliationTimer.unref?.();

  const initialCatchUp = (async () => {
    try {
      await watcherReady;
      if (stopped) return;
      if (lastError === null) healthState = "catching_up";
      const bootScanOk = await bootScanJsonl(
        prefix,
        async (path) => {
          if (stopped) return false;
          if (!(await pathNeedsCatchUp(path))) return true;
          queuePath(path);
          await waitForPendingDrain();
          return !stopped;
        },
        log,
      );
      if (!bootScanOk) {
        errorCount += 1;
        lastError = `boot scan failed for ${prefix}`;
        healthState = "unhealthy";
      }
    } catch (err) {
      const message = (err as Error).message;
      errorCount += 1;
      lastError = message;
      healthState = "unhealthy";
      log.error("initial_catch_up_failed", {
        prefix,
        message,
      });
    } finally {
      initialScanRunning = false;
      kickWorker();
      await waitForIdle();
      if (!stopped && lastError === null) healthState = "healthy";
      notifyWaiters();
    }
  })();

  return {
    initialCatchUp,
    getHealth: () => ({
      state: healthState,
      queueDepth: pendingPaths.size,
      overflowCount,
      reconciliationPending: reconciliationRequested,
      errorCount,
      lastError,
      sourceStatus,
    }),
    stop: async () => {
      if (stopPromise !== null) return stopPromise;
      stopPromise = (async () => {
        stopped = true;
        healthState = "stopped";
        initialScanRunning = false;
        pendingPaths.clear();
        activePathDirty = false;
        reconciliationRequested = false;
        clearInterval(reconciliationTimer);
        if (cachedProbe !== null) await cachedProbe;
        resolveWatcherReady();
        notifyWaiters();
        await watcher.close();
        await initialCatchUp;
        if (worker !== null) await worker;
        if (reconciliationIterator?.return !== undefined) {
          await reconciliationIterator.return();
        }
        reconciliationIterator = null;
        if (periodicDiscoveryIterator?.return !== undefined) {
          await periodicDiscoveryIterator.return();
        }
        periodicDiscoveryIterator = null;
      })();
      return stopPromise;
    },
    probeFreshness: () => probeFreshness(offsetMap),
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}
