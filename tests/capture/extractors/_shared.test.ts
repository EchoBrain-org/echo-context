import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FSWatcher } from "chokidar";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertJsonlReadSnapshotCurrent,
  assertJsonlSourceSnapshotCurrent,
  classifyJsonlDiscontinuity,
  inspectJsonlSource,
  JsonlSourceChangedError,
  makeJsonlCheckpointSource,
  MAX_JSONL_RAW_FRAGMENT_BYTES,
  MAX_JSONL_READ_BYTES,
  readJsonlTail,
  visitJsonlRawFragments,
  wireJsonlExtractor,
  type ExtractorHandle,
} from "../../../src/capture/extractors/_shared.js";
import type { Logger } from "../../../src/logging/index.js";
import { waitFor } from "../../fixtures/jsonl.js";

class FakeWatcher extends EventEmitter {
  closed = false;

  async close(): Promise<void> {
    this.closed = true;
  }

  asFsWatcher(): FSWatcher {
    return this as unknown as FSWatcher;
  }
}

const silentLog: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe("wireJsonlExtractor bounded startup", () => {
  const dirs: string[] = [];
  let handle: ExtractorHandle | null = null;

  afterEach(async () => {
    if (handle !== null) {
      await handle.stop();
      handle = null;
    }
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  it("starts the watcher first, then streams only missing or changed boot files serially", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "echo-shared-boot-"));
    dirs.push(prefix);
    const nested = join(prefix, "nested");
    mkdirSync(nested);
    const unchanged = join(prefix, "unchanged.jsonl");
    const missing = join(prefix, "missing.jsonl");
    const changed = join(nested, "changed.jsonl");
    const ignored = join(nested, "ignored.txt");
    writeFileSync(unchanged, '{"old":true}\n');
    writeFileSync(missing, '{"new":true}\n');
    writeFileSync(changed, '{"one":1}\n{"two":2}\n');
    writeFileSync(ignored, "not jsonl");

    const offsetMap = new Map<string, { offset: number }>([
      [unchanged, { offset: statSync(unchanged).size }],
      [changed, { offset: 2 }],
    ]);
    const watcher = new FakeWatcher();
    const calls: string[] = [];
    let active = 0;
    let maxActive = 0;
    let releaseFirst: () => void = () => undefined;
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted: () => void = () => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });

    handle = await wireJsonlExtractor({
      prefix,
      offsetMap,
      log: silentLog,
      watcherFactory: () => watcher.asFsWatcher(),
      handle: async (path) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        calls.push(path);
        if (calls.length === 1) {
          markFirstStarted();
          await firstRelease;
        }
        offsetMap.set(path, { offset: statSync(path).size });
        active -= 1;
      },
    });

    expect(handle.getHealth()).toMatchObject({
      state: "starting",
      queueDepth: 0,
    });
    watcher.emit("ready");
    await firstStarted;
    expect(handle.getHealth().state).toBe("catching_up");

    releaseFirst();
    await handle.initialCatchUp;

    expect(new Set(calls)).toEqual(new Set([missing, changed]));
    expect(calls).toHaveLength(2);
    expect(maxActive).toBe(1);
    expect(handle.getHealth()).toEqual({
      state: "healthy",
      sourceStatus: "active",
      queueDepth: 0,
      overflowCount: 0,
      reconciliationPending: false,
      errorCount: 0,
      lastError: null,
    });

    await handle.stop();
    expect(watcher.closed).toBe(true);
    expect(handle.getHealth().state).toBe("stopped");
    handle = null;
  });

  it("coalesces duplicate paths, caps the pending queue, and reconciles overflow", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "echo-shared-overflow-"));
    dirs.push(prefix);
    const paths = ["one", "two", "three", "four"].map((name) =>
      join(prefix, `${name}.jsonl`),
    );
    const offsetMap = new Map<string, { offset: number }>();
    for (const path of paths) {
      writeFileSync(path, '{"before":true}\n');
      offsetMap.set(path, { offset: statSync(path).size });
    }

    const watcher = new FakeWatcher();
    const calls: string[] = [];
    let active = 0;
    let maxActive = 0;
    let releaseFirst: () => void = () => undefined;
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted: () => void = () => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });

    handle = await wireJsonlExtractor({
      prefix,
      offsetMap,
      log: silentLog,
      maxPendingPaths: 2,
      reconciliationBatchSize: 1,
      watcherFactory: () => watcher.asFsWatcher(),
      handle: async (path) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        calls.push(path);
        if (calls.length === 1) {
          markFirstStarted();
          await firstRelease;
        }
        offsetMap.set(path, { offset: statSync(path).size });
        active -= 1;
      },
    });
    watcher.emit("ready");
    await handle.initialCatchUp;

    for (const path of paths) appendFileSync(path, '{"after":true}\n');
    watcher.emit("change", paths[0]);
    await firstStarted;
    watcher.emit("change", paths[0]);
    watcher.emit("change", paths[0]);
    watcher.emit("change", paths[1]);
    watcher.emit("change", paths[1]);
    watcher.emit("change", paths[2]);
    watcher.emit("change", paths[3]);

    expect(handle.getHealth().queueDepth).toBe(2);
    expect(handle.getHealth().overflowCount).toBeGreaterThanOrEqual(1);
    expect(handle.getHealth().reconciliationPending).toBe(true);

    releaseFirst();
    await waitFor(() => {
      const health = handle?.getHealth();
      return (
        health?.queueDepth === 0 &&
        health.reconciliationPending === false &&
        calls.includes(paths[3]!)
      );
    });

    expect(maxActive).toBe(1);
    expect(calls.filter((path) => path === paths[1])).toHaveLength(1);
    expect(calls).toEqual(expect.arrayContaining(paths));
    expect(handle.getHealth().queueDepth).toBeLessThanOrEqual(2);
  });

  it("never materializes more than one JSONL byte page", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "echo-shared-read-budget-"));
    dirs.push(prefix);
    const path = join(prefix, "large.jsonl");
    const first = JSON.stringify({ value: "a".repeat(3 * 1024 * 1024) });
    const second = JSON.stringify({ value: "b".repeat(3 * 1024 * 1024) });
    writeFileSync(path, `${first}\n${second}\n`);

    const page = await readJsonlTail(path, 0, silentLog);
    expect(page?.lines).toEqual([first]);
    expect(Buffer.byteLength(page!.lines.join("\n"))).toBeLessThan(
      MAX_JSONL_READ_BYTES,
    );
  });

  it("retains blank lines and reports exact byte boundaries for checkpoints", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "echo-shared-offsets-"));
    dirs.push(prefix);
    const path = join(prefix, "blank-lines.jsonl");
    const first = JSON.stringify({ value: "first" });
    const second = JSON.stringify({ value: "雪" });
    writeFileSync(path, `${first}\n\n\n${second}\npartial`);

    const page = await readJsonlTail(path, 0, silentLog);

    expect(page?.lines).toEqual([first, "", "", second]);
    expect(page?.lineEndOffsets).toEqual([
      Buffer.byteLength(`${first}\n`),
      Buffer.byteLength(`${first}\n\n`),
      Buffer.byteLength(`${first}\n\n\n`),
      Buffer.byteLength(`${first}\n\n\n${second}\n`),
    ]);
  });

  it("exposes one oversized JSONL record as bounded, exact raw fragments", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "echo-shared-read-budget-"));
    dirs.push(prefix);
    const path = join(prefix, "oversized.jsonl");
    const source = Buffer.from("x".repeat(MAX_JSONL_READ_BYTES + 1));
    writeFileSync(path, source);

    const page = await readJsonlTail(path, 0, silentLog);
    expect(page?.lines).toEqual([]);
    expect(page?.snapshot).toMatchObject({
      first_offset: 0,
      through_offset: MAX_JSONL_READ_BYTES,
    });

    const fragments: Buffer[] = [];
    const nextIndex = await visitJsonlRawFragments(
      path,
      page!.snapshot!,
      page!.snapshot!.through_offset,
      0,
      async (fragment) => {
        expect(fragment.bytes).toBeLessThanOrEqual(
          MAX_JSONL_RAW_FRAGMENT_BYTES,
        );
        fragments.push(Buffer.from(fragment.base64, "base64"));
      },
    );
    expect(nextIndex).toBe(
      Math.ceil(MAX_JSONL_READ_BYTES / MAX_JSONL_RAW_FRAGMENT_BYTES),
    );
    const reconstructed = Buffer.concat(fragments);
    expect(reconstructed.byteLength).toBe(MAX_JSONL_READ_BYTES);
    expect(createHash("sha256").update(reconstructed).digest("hex")).toBe(
      createHash("sha256")
        .update(source.subarray(0, MAX_JSONL_READ_BYTES))
        .digest("hex"),
    );

    const finalPage = await readJsonlTail(
      path,
      MAX_JSONL_READ_BYTES,
      silentLog,
    );
    expect(finalPage?.lines).toEqual([]);
    expect(finalPage?.snapshot).toBeUndefined();
    expect(finalPage?.firstLineOffset).toBe(MAX_JSONL_READ_BYTES);
  });

  it("detects an atomic replacement before candidates can be emitted", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "echo-shared-source-proof-"));
    dirs.push(prefix);
    const path = join(prefix, "session.jsonl");
    const replacement = join(prefix, "replacement.jsonl");
    writeFileSync(path, '{"old":true}\n');
    writeFileSync(replacement, '{"new":true}\n');
    const expected = await inspectJsonlSource(path, statSync(path).size);

    renameSync(replacement, path);

    await expect(
      assertJsonlSourceSnapshotCurrent(path, expected),
    ).rejects.toBeInstanceOf(JsonlSourceChangedError);
  });

  it("binds the complete parsed page when an unread tail is rewritten in place", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "echo-shared-page-proof-"));
    dirs.push(prefix);
    const path = join(prefix, "session.jsonl");
    const accepted = '{"accepted":true}\n';
    const oldTail = '{"tail":"old"}\n';
    const newTail = '{"tail":"new"}\n';
    const offset = Buffer.byteLength(accepted);
    writeFileSync(path, `${accepted}${oldTail}`);
    const durableBoundary = await inspectJsonlSource(path, offset);
    const page = await readJsonlTail(path, offset, silentLog);
    expect(page?.snapshot).toBeDefined();

    // writeFileSync truncates/reuses the inode. The accepted prefix and its
    // 4 KiB boundary are byte-identical, so only the parsed-page proof can
    // distinguish this from an append-only continuation.
    writeFileSync(path, `${accepted}${newTail}`);
    await expect(
      assertJsonlSourceSnapshotCurrent(path, durableBoundary),
    ).resolves.toBeUndefined();
    await expect(
      assertJsonlReadSnapshotCurrent(path, page!.snapshot!),
    ).rejects.toBeInstanceOf(JsonlSourceChangedError);
    expect(
      classifyJsonlDiscontinuity(
        offset,
        makeJsonlCheckpointSource(durableBoundary, 0),
        await inspectJsonlSource(path, offset),
      ),
    ).toBe("rewritten");
  });

  it("detects a rewritten checkpoint page even when the source also grows", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "echo-shared-page-crash-"));
    dirs.push(prefix);
    const path = join(prefix, "session.jsonl");
    const suffix = "x".repeat(6_000);
    writeFileSync(path, `OLD${suffix}\n`);
    const page = await readJsonlTail(path, 0, silentLog);
    const snapshot = page!.snapshot!;
    const persisted = makeJsonlCheckpointSource(
      snapshot.sourceAt(snapshot.through_offset),
      0,
    );

    // Simulate a crash after the old checkpoint was committed: change bytes
    // outside its final 4 KiB boundary and append more data in the same write.
    // Identity, boundary hash, and growth all look append-only; the bounded
    // persisted page proof is what makes the rewrite observable on restart.
    writeFileSync(path, `NEW${suffix}\n{"later":true}\n`);
    const current = await inspectJsonlSource(
      path,
      persisted.boundary_offset,
      persisted,
    );

    expect(current.size).toBeGreaterThan(persisted.size);
    expect(current.boundary_sha256).toBe(persisted.boundary_sha256);
    expect(
      classifyJsonlDiscontinuity(persisted.boundary_offset, persisted, current),
    ).toBe("page_rewritten");
  });

  it("does not replay an accepted prefix when only its unread tail shrinks", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "echo-shared-unread-tail-"));
    dirs.push(prefix);
    const path = join(prefix, "session.jsonl");
    const accepted = '{"accepted":true}\n';
    writeFileSync(path, `${accepted}{"partial":`);
    const offset = Buffer.byteLength(accepted);
    const before = await inspectJsonlSource(path, offset);
    const persisted = makeJsonlCheckpointSource(before, 0);

    writeFileSync(path, accepted);
    const after = await inspectJsonlSource(path, offset);

    expect(after.size).toBeLessThan(persisted.size);
    expect(classifyJsonlDiscontinuity(offset, persisted, after)).toBeNull();
  });

  it("treats a transient delete gap as recoverable without poisoning health", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "echo-shared-delete-gap-"));
    dirs.push(prefix);
    const path = join(prefix, "session.jsonl");
    writeFileSync(path, '{"old":true}\n');
    const offsetMap = new Map([[path, { offset: statSync(path).size }]]);
    const watcher = new FakeWatcher();
    let attempts = 0;
    handle = await wireJsonlExtractor({
      prefix,
      offsetMap,
      log: silentLog,
      watcherFactory: () => watcher.asFsWatcher(),
      handle: async (changedPath) => {
        attempts += 1;
        if (attempts === 1) {
          const missing = new Error("rotated away") as NodeJS.ErrnoException;
          missing.code = "ENOENT";
          throw missing;
        }
        offsetMap.set(changedPath, { offset: statSync(changedPath).size });
      },
    });
    watcher.emit("ready");
    await handle.initialCatchUp;

    appendFileSync(path, '{"one":1}\n');
    watcher.emit("change", path);
    await waitFor(() => attempts === 1);
    expect(handle.getHealth()).toMatchObject({
      state: "healthy",
      errorCount: 0,
      lastError: null,
    });

    watcher.emit("change", path);
    await waitFor(
      () =>
        attempts === 2 && offsetMap.get(path)?.offset === statSync(path).size,
    );
    expect(handle.getHealth()).toMatchObject({
      state: "healthy",
      errorCount: 0,
      lastError: null,
    });
  });

  it("does not claim healthy after a watcher failure", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "echo-shared-health-"));
    dirs.push(prefix);
    const watcher = new FakeWatcher();
    handle = await wireJsonlExtractor({
      prefix,
      offsetMap: new Map(),
      log: silentLog,
      watcherFactory: () => watcher.asFsWatcher(),
      handle: async () => undefined,
    });
    watcher.emit("error", new Error("watch failed"));
    await handle.initialCatchUp;
    expect(handle.getHealth()).toMatchObject({
      state: "unhealthy",
      errorCount: 1,
      lastError: "watch failed",
    });
  });

  it("reports unhealthy instead of looping when a parser cannot checkpoint a byte page", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "echo-shared-stalled-"));
    dirs.push(prefix);
    const path = join(prefix, "stalled.jsonl");
    writeFileSync(path, `${"x".repeat(MAX_JSONL_READ_BYTES + 1)}\n`);
    const watcher = new FakeWatcher();
    handle = await wireJsonlExtractor({
      prefix,
      offsetMap: new Map(),
      log: silentLog,
      watcherFactory: () => watcher.asFsWatcher(),
      handle: async () => undefined,
    });
    watcher.emit("ready");
    await handle.initialCatchUp;
    expect(handle.getHealth()).toMatchObject({
      state: "unhealthy",
      errorCount: 1,
    });
    expect(handle.getHealth().lastError).toMatch(/made no checkpoint progress/);
  });
});
