import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CAPTURE_CHECKPOINT_CURSOR_BYTES,
  CAPTURE_CHECKPOINT_EXTRACTOR_BYTES,
  CAPTURE_CHECKPOINT_PARTITION_BYTES,
  CAPTURE_CHECKPOINT_RESOURCE_BYTES,
  CAPTURE_CHECKPOINT_STATE_BYTES,
  CAPTURE_CHECKPOINT_UPDATED_AT_BYTES,
  MAX_CAPTURE_CHECKPOINT_PAGE_SIZE,
} from "../../src/storage/checkpoint.js";
import { STORAGE_DESCRIPTOR_SOURCE_BYTES } from "../../src/storage/budgets.js";
import type {
  CaptureCheckpointInput,
  CaptureCheckpointListOptions,
  Storage,
} from "../../src/storage/interface.js";
import { MemoryStorage } from "../../src/storage/memory.js";
import { loadMigrations } from "../../src/storage/migrate.js";
import { SqliteStorage } from "../../src/storage/sqlite.js";

const INITIAL_MIGRATION = new URL(
  "../../src/storage/migrations/0001_initial.sql",
  import.meta.url,
).pathname;
const MIGRATIONS_DIR = new URL("../../src/storage/migrations/", import.meta.url)
  .pathname;
const MIGRATIONS = loadMigrations(MIGRATIONS_DIR);
const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

interface StorageHarness {
  storage: Storage;
  close: () => void;
}

function checkpointContract(name: string, create: () => StorageHarness): void {
  describe(`${name} capture checkpoints`, () => {
    let harness: StorageHarness;

    beforeEach(() => {
      harness = create();
    });

    afterEach(() => {
      harness.close();
    });

    it("upserts, exactly reads, replaces, and isolates returned state", async () => {
      const state = { cwd: "/repo", nested: { branch: "main" } };
      const written = await harness.storage.upsertCaptureCheckpoint({
        extractor: "codex",
        resource: "/sessions/a.jsonl",
        position: 123,
        ordinal: 4,
        mtime_ms: 99.5,
        state,
        updated_at: "2026-07-20T10:00:00Z",
      });

      expect(written).toEqual({
        extractor: "codex",
        resource: "/sessions/a.jsonl",
        partition: "",
        position: 123,
        ordinal: 4,
        mtime_ms: 99.5,
        state,
        updated_at: "2026-07-20T10:00:00.000Z",
      });
      state.cwd = "/mutated-input";
      written.state["cwd"] = "/mutated-output";
      expect(
        await harness.storage.getCaptureCheckpoint({
          extractor: "codex",
          resource: "/sessions/a.jsonl",
        }),
      ).toMatchObject({ state: { cwd: "/repo", nested: { branch: "main" } } });

      const replaced = await harness.storage.upsertCaptureCheckpoint({
        extractor: "codex",
        resource: "/sessions/a.jsonl",
        cursor: "turn-5",
        updated_at: "2026-07-20T10:01:00.000Z",
      });
      expect(replaced.position).toBeUndefined();
      expect(replaced.cursor).toBe("turn-5");
      expect(replaced.state).toEqual({});
      expect(
        await harness.storage.getCaptureCheckpoint({
          extractor: "codex",
          resource: "/sessions/missing.jsonl",
        }),
      ).toBeNull();
    });

    it("pages one extractor by composite key without duplicates or gaps", async () => {
      const inputs: CaptureCheckpointInput[] = [
        {
          extractor: "codex",
          resource: "/b.jsonl",
          position: 2,
          updated_at: "2026-07-20T10:00:02.000Z",
        },
        {
          extractor: "codex",
          resource: "/a.jsonl",
          partition: "worker",
          position: 1,
          updated_at: "2026-07-20T10:00:01.000Z",
        },
        {
          extractor: "codex",
          resource: "/a.jsonl",
          position: 0,
          updated_at: "2026-07-20T10:00:00.000Z",
        },
        {
          extractor: "codex",
          resource: "/c.jsonl",
          position: 3,
          updated_at: "2026-07-20T10:00:03.000Z",
        },
        {
          extractor: "claude_code",
          resource: "/not-in-codex-page.jsonl",
          position: 9,
          updated_at: "2026-07-20T10:00:09.000Z",
        },
      ];
      for (const input of inputs)
        await harness.storage.upsertCaptureCheckpoint(input);

      const first = await harness.storage.listCaptureCheckpoints({
        extractor: "codex",
        limit: 2,
      });
      expect(
        first.checkpoints.map((checkpoint) => [
          checkpoint.resource,
          checkpoint.partition,
        ]),
      ).toEqual([
        ["/a.jsonl", ""],
        ["/a.jsonl", "worker"],
      ]);
      expect(first.next_cursor).toEqual({
        extractor: "codex",
        resource: "/a.jsonl",
        partition: "worker",
      });

      const second = await harness.storage.listCaptureCheckpoints({
        extractor: "codex",
        limit: 2,
        after: first.next_cursor!,
      });
      expect(
        second.checkpoints.map((checkpoint) => checkpoint.resource),
      ).toEqual(["/b.jsonl", "/c.jsonl"]);
      expect(second.next_cursor).toBeNull();
      expect([...first.checkpoints, ...second.checkpoints]).toHaveLength(4);
    });

    it("requires a bounded page and rejects a cursor from another extractor", async () => {
      await expect(
        harness.storage.listCaptureCheckpoints({
          extractor: "codex",
        } as CaptureCheckpointListOptions),
      ).rejects.toThrow(/limit must be a positive integer/);
      await expect(
        harness.storage.listCaptureCheckpoints({
          extractor: "codex",
          limit: 0,
        }),
      ).rejects.toThrow(/positive integer/);
      await expect(
        harness.storage.listCaptureCheckpoints({
          extractor: "codex",
          limit: MAX_CAPTURE_CHECKPOINT_PAGE_SIZE + 1,
        }),
      ).rejects.toThrow(new RegExp(`<= ${MAX_CAPTURE_CHECKPOINT_PAGE_SIZE}`));
      await expect(
        harness.storage.listCaptureCheckpoints({
          extractor: "codex",
          limit: 1,
          after: { extractor: "claude_code", resource: "/a", partition: "" },
        }),
      ).rejects.toThrow(/cursor extractor must match/);
    });

    it.each([
      {
        field: "extractor",
        input: {
          extractor: "e".repeat(CAPTURE_CHECKPOINT_EXTRACTOR_BYTES + 1),
          resource: "/resource",
          updated_at: "2026-07-20T10:00:00.000Z",
        },
      },
      {
        field: "resource",
        input: {
          extractor: "codex",
          resource: "💥".repeat(
            Math.floor(CAPTURE_CHECKPOINT_RESOURCE_BYTES / 4) + 1,
          ),
          updated_at: "2026-07-20T10:00:00.000Z",
        },
      },
      {
        field: "partition",
        input: {
          extractor: "cursor",
          resource: "/resource",
          partition: "p".repeat(CAPTURE_CHECKPOINT_PARTITION_BYTES + 1),
          updated_at: "2026-07-20T10:00:00.000Z",
        },
      },
      {
        field: "cursor",
        input: {
          extractor: "cursor",
          resource: "/resource",
          cursor: "c".repeat(CAPTURE_CHECKPOINT_CURSOR_BYTES + 1),
          updated_at: "2026-07-20T10:00:00.000Z",
        },
      },
      {
        field: "state",
        input: {
          extractor: "codex",
          resource: "/resource",
          state: { payload: "s".repeat(CAPTURE_CHECKPOINT_STATE_BYTES) },
          updated_at: "2026-07-20T10:00:00.000Z",
        },
      },
      {
        field: "updated_at",
        input: {
          extractor: "codex",
          resource: "/resource",
          updated_at: "u".repeat(CAPTURE_CHECKPOINT_UPDATED_AT_BYTES + 1),
        },
      },
    ] as const)(
      "rejects an oversized $field before a checkpoint write",
      async ({ field, input }) => {
        await expect(
          harness.storage.upsertCaptureCheckpoint(
            input as CaptureCheckpointInput,
          ),
        ).rejects.toMatchObject({
          code: "checkpoint_field_too_large",
          field,
        });
      },
    );

    it("rejects oversized exact/list lookup keys before storage work", async () => {
      await expect(
        harness.storage.getCaptureCheckpoint({
          extractor: "codex",
          resource: "r".repeat(CAPTURE_CHECKPOINT_RESOURCE_BYTES + 1),
        }),
      ).rejects.toMatchObject({
        code: "checkpoint_field_too_large",
        field: "resource",
      });
      await expect(
        harness.storage.listCaptureCheckpoints({
          extractor: "e".repeat(CAPTURE_CHECKPOINT_EXTRACTOR_BYTES + 1),
          limit: 1,
        }),
      ).rejects.toMatchObject({
        code: "checkpoint_field_too_large",
        field: "extractor",
      });
    });
  });
}

checkpointContract("MemoryStorage", () => ({
  storage: new MemoryStorage(),
  close: () => undefined,
}));

checkpointContract("SqliteStorage", () => {
  const storage = new SqliteStorage(":memory:");
  return { storage, close: () => storage.close() };
});

describe("SqliteStorage legacy checkpoint read budgets", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "echo-checkpoint-budget-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    {
      field: "resource",
      value: "r".repeat(CAPTURE_CHECKPOINT_RESOURCE_BYTES + 1),
      read: "list",
    },
    {
      field: "partition",
      value: "p".repeat(CAPTURE_CHECKPOINT_PARTITION_BYTES + 1),
      read: "list",
    },
    {
      field: "cursor",
      value: "c".repeat(CAPTURE_CHECKPOINT_CURSOR_BYTES + 1),
      read: "exact",
    },
    {
      field: "state",
      value: JSON.stringify({
        payload: "s".repeat(CAPTURE_CHECKPOINT_STATE_BYTES),
      }),
      read: "exact",
    },
    {
      field: "updated_at",
      value: "u".repeat(CAPTURE_CHECKPOINT_UPDATED_AT_BYTES + 1),
      read: "exact",
    },
  ] as const)(
    "rejects an oversized legacy $field before checkpoint materialization",
    async ({ field, value, read }) => {
      const dbPath = join(dir, `${field}.db`);
      new SqliteStorage(dbPath).close();
      const db = new Database(dbPath);
      db.pragma("ignore_check_constraints = ON");
      const row: Record<string, unknown> = {
        extractor: `legacy-${field}`,
        resource: "/resource",
        partition: "",
        position: null,
        cursor: null,
        ordinal: null,
        mtime_ms: null,
        state: "{}",
        updated_at: "2026-07-20T10:00:00.000Z",
      };
      row[field] = value;
      db.prepare(
        `INSERT INTO capture_checkpoints (
           extractor, resource, partition, position, cursor, ordinal, mtime_ms, state, updated_at
         ) VALUES (
           @extractor, @resource, @partition, @position, @cursor, @ordinal, @mtime_ms, @state, @updated_at
         )`,
      ).run(row);
      db.close();

      const storage = new SqliteStorage(dbPath);
      const result =
        read === "exact"
          ? storage.getCaptureCheckpoint({
              extractor: `legacy-${field}`,
              resource: "/resource",
            })
          : storage.listCaptureCheckpoints({
              extractor: `legacy-${field}`,
              limit: 1,
            });
      await expect(result).rejects.toMatchObject({
        code: "checkpoint_field_too_large",
        field,
      });
      storage.close();
    },
  );
});

describe("capture checkpoint migration", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "echo-checkpoint-migration-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails before migration 0002 processes an oversized legacy event", () => {
    const dbPath = join(dir, "oversized-v1.db");
    const legacy = new Database(dbPath);
    legacy.exec(readFileSync(INITIAL_MIGRATION, "utf8"));
    legacy.pragma("user_version = 1");
    legacy
      .prepare(
        `INSERT INTO events (id, source, timestamp, content, metadata)
         VALUES (?, ?, ?, 'poison', ?)`,
      )
      .run(
        "legacy",
        "s".repeat(STORAGE_DESCRIPTOR_SOURCE_BYTES + 1),
        "2026-07-20T10:00:00.000Z",
        JSON.stringify({ byte_offset: 1, turn_index: 0 }),
      );
    legacy.close();

    expect(() => new SqliteStorage(dbPath)).toThrow(/CHECK constraint failed/);
    const unchanged = new Database(dbPath);
    expect(unchanged.pragma("user_version", { simple: true })).toBe(1);
    expect(
      unchanged
        .prepare(
          `SELECT COUNT(*) AS count
           FROM sqlite_master
           WHERE type = 'table' AND name = 'capture_checkpoints'`,
        )
        .get(),
    ).toEqual({ count: 0 });
    unchanged.close();
  });

  it("additively backfills current Claude/Codex and legacy Cursor progress without changing events", async () => {
    const dbPath = join(dir, "echo.db");
    const legacy = new Database(dbPath);
    legacy.exec(readFileSync(INITIAL_MIGRATION, "utf8"));
    legacy.pragma("user_version = 1");
    const insert = legacy.prepare(
      `INSERT INTO events (id, source, timestamp, content, metadata)
       VALUES (@id, @source, @timestamp, @content, @metadata)`,
    );
    const claudeResource = "/Users/test/.claude/projects/repo/session.jsonl";
    const codexResource = "/Users/test/.codex/sessions/2026/07/session.jsonl";
    const cursorResource =
      "/Users/test/Library/Application Support/Cursor/User/globalStorage/state.vscdb";
    const appendLegacy = (
      id: string,
      source: string,
      timestamp: string,
      metadata: Record<string, unknown>,
    ): void => {
      insert.run({
        id,
        source: `fs:${source}`,
        timestamp,
        content: id,
        metadata: JSON.stringify(metadata),
      });
    };

    appendLegacy("cc-1", claudeResource, "2026-07-20T10:00:00.000Z", {
      byte_offset: 100,
      turn_index: 0,
      mtime: 1000,
      repo_root: "/repo-old",
    });
    appendLegacy("cc-2", claudeResource, "2026-07-20T10:02:00.000Z", {
      byte_offset: 300,
      turn_index: 2,
      mtime: 3000,
      repo_root: "/repo",
    });
    // Later append with lower progress must not regress the backfilled offset.
    appendLegacy("cc-stale", claudeResource, "2026-07-20T10:03:00.000Z", {
      byte_offset: 200,
      turn_index: 1,
      mtime: 2000,
      repo_root: "/repo-stale",
    });
    appendLegacy("codex-1", codexResource, "2026-07-20T11:00:00.000Z", {
      byte_offset: 450,
      turn_index: 5,
      mtime: 4500,
      cwd: "/repo",
      git: { branch: "main" },
      codex: { model: "gpt-test" },
    });
    appendLegacy("cursor-c1-1", cursorResource, "2026-07-20T12:00:00.000Z", {
      composer_id: "c1",
      assistant_bubble_id: "b1",
      workspace_id: "w1",
    });
    appendLegacy("cursor-c2-1", cursorResource, "2026-07-20T12:01:00.000Z", {
      composer_id: "c2",
      assistant_bubble_id: "x1",
      workspace_id: "w2",
    });
    appendLegacy("cursor-c1-2", cursorResource, "2026-07-20T12:02:00.000Z", {
      composer_id: "c1",
      assistant_bubble_id: "b2",
      workspace_id: "w1",
      repo_root: "/repo",
    });
    appendLegacy(
      "raw-fs",
      "/Users/test/.claude/projects/repo/raw.jsonl",
      "2026-07-20T13:00:00.000Z",
      {
        surface: "fs",
      },
    );
    const before = legacy
      .prepare(
        "SELECT id, source, timestamp, content, metadata FROM events ORDER BY rowid",
      )
      .all();
    legacy.close();

    const migrated = new SqliteStorage(dbPath);
    expect(
      await migrated.getCaptureCheckpoint({
        extractor: "claude_code",
        resource: claudeResource,
      }),
    ).toEqual({
      extractor: "claude_code",
      resource: claudeResource,
      partition: "",
      position: 300,
      ordinal: 2,
      mtime_ms: 3000,
      state: { repo_root: "/repo" },
      updated_at: "2026-07-20T10:02:00.000Z",
    });
    expect(
      await migrated.getCaptureCheckpoint({
        extractor: "codex",
        resource: codexResource,
      }),
    ).toMatchObject({
      position: 450,
      ordinal: 5,
      state: {
        cwd: "/repo",
        git: { branch: "main" },
        codex: { model: "gpt-test" },
      },
    });
    expect(
      await migrated.getCaptureCheckpoint({
        extractor: "cursor",
        resource: cursorResource,
        partition: "c1",
      }),
    ).toMatchObject({
      cursor: "b2",
      state: { workspace_id: "w1", repo_root: "/repo" },
    });
    expect(
      await migrated.getCaptureCheckpoint({
        extractor: "cursor",
        resource: cursorResource,
        partition: "c2",
      }),
    ).toMatchObject({ cursor: "x1" });
    migrated.close();

    const inspect = new Database(dbPath);
    expect(inspect.pragma("user_version", { simple: true })).toBe(
      LATEST_SCHEMA_VERSION,
    );
    expect(
      inspect
        .prepare(
          "SELECT id, source, timestamp, content, metadata FROM events ORDER BY rowid",
        )
        .all(),
    ).toEqual(before);
    expect(
      (
        inspect
          .prepare("SELECT COUNT(*) AS count FROM capture_checkpoints")
          .get() as { count: number }
      ).count,
    ).toBe(4);
    const checkpointTable = inspect
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'capture_checkpoints'",
      )
      .get() as { sql: string };
    expect(checkpointTable.sql).toContain("WITHOUT ROWID");
    const indexes = inspect
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name",
      )
      .all() as { name: string }[];
    expect(indexes.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "idx_capture_checkpoints_updated_at",
        "idx_events_source_timestamp_id",
        "idx_events_timestamp_id",
      ]),
    );
    inspect.close();
  });

  it("runs the backfill once and preserves subsequent checkpoint upserts across reopen", async () => {
    const dbPath = join(dir, "echo.db");
    const legacy = new Database(dbPath);
    legacy.exec(readFileSync(INITIAL_MIGRATION, "utf8"));
    legacy.pragma("user_version = 1");
    legacy
      .prepare(
        `INSERT INTO events (id, source, timestamp, content, metadata)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy",
        "fs:/Users/test/.codex/sessions/a.jsonl",
        "2026-07-20T10:00:00.000Z",
        "legacy",
        JSON.stringify({ byte_offset: 10, turn_index: 0 }),
      );
    legacy.close();

    const first = new SqliteStorage(dbPath);
    await first.upsertCaptureCheckpoint({
      extractor: "codex",
      resource: "/Users/test/.codex/sessions/a.jsonl",
      position: 99,
      ordinal: 9,
      updated_at: "2026-07-20T11:00:00.000Z",
    });
    first.close();

    const reopened = new SqliteStorage(dbPath);
    expect(
      await reopened.getCaptureCheckpoint({
        extractor: "codex",
        resource: "/Users/test/.codex/sessions/a.jsonl",
      }),
    ).toMatchObject({ position: 99, ordinal: 9 });
    reopened.close();
  });
});
