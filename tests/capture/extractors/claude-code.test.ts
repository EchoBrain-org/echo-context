import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CAPTURED_SOURCES } from "../../../src/capture/sources.js";
import {
  extractClaudeCodeTurns,
  startClaudeCodeExtractor,
  type ClaudeCodeExtractorHandle,
} from "../../../src/capture/extractors/claude-code.js";
import {
  JSONL_RAW_FRAGMENT_CONTENT_PREFIX,
  JsonlSourceChangedError,
  MAX_JSONL_READ_BYTES,
} from "../../../src/capture/extractors/_shared.js";
import type { CaptureEvent, EventId } from "../../../src/storage/interface.js";
import { MemoryStorage } from "../../../src/storage/memory.js";
import {
  resetAllowlist,
  restoreFsPaths,
  snapshotFsPaths,
} from "../../fixtures/allowlist.js";
import {
  appendJsonl,
  tmpDir,
  waitFor,
  writeJsonl as writeJsonlFresh,
} from "../../fixtures/jsonl.js";
import { captureStdout } from "../../fixtures/stdout.js";
import { expectExactRawJsonlFragments } from "../../fixtures/raw-jsonl-fragments.js";

/** Storage whose append throws once for the event whose content contains the
 *  marker — simulates a mid-batch storage failure inside handleJsonlChange. */
class MidBatchFailingStorage extends MemoryStorage {
  private failedOnce = false;

  constructor(private readonly failContentMarker: string) {
    super();
  }

  override async append(event: Omit<CaptureEvent, "id">): Promise<EventId> {
    if (!this.failedOnce && event.content.includes(this.failContentMarker)) {
      this.failedOnce = true;
      throw new Error("synthetic append failure");
    }
    return super.append(event);
  }
}

class SameInodeRewriteDuringAppendStorage extends MemoryStorage {
  private rewritten = false;

  constructor(
    private readonly sourcePath: string,
    private readonly replacement: JsonlLine[],
  ) {
    super();
  }

  override async append(event: Omit<CaptureEvent, "id">): Promise<EventId> {
    if (!this.rewritten) {
      this.rewritten = true;
      writeJsonlFresh(this.sourcePath, this.replacement);
    }
    return super.append(event);
  }
}

class AppendThenFailStorage extends MemoryStorage {
  private failing = true;

  constructor(private readonly marker: string) {
    super();
  }

  allowCheckpoints(): void {
    this.failing = false;
  }

  override async append(
    event: Omit<CaptureEvent, "id">,
    options?: Parameters<MemoryStorage["append"]>[1],
  ): Promise<EventId> {
    const id = await super.append(event, options);
    if (this.failing && event.content.includes(this.marker)) {
      throw new Error("synthetic crash after append before checkpoint");
    }
    return id;
  }
}

/** Accepts one event, appends only beyond the parsed page, then reports the
 * transient source-change signal a snapshot check would produce if it raced
 * that append between its two stats. */
class BenignAppendThenSignalStorage extends MemoryStorage {
  private signaled = false;

  constructor(
    private readonly sourcePath: string,
    private readonly appended: JsonlLine[],
  ) {
    super();
  }

  override async append(
    event: Omit<CaptureEvent, "id">,
    options?: Parameters<MemoryStorage["append"]>[1],
  ): Promise<EventId> {
    const id = await super.append(event, options);
    if (!this.signaled) {
      this.signaled = true;
      appendJsonl(this.sourcePath, this.appended);
      throw new JsonlSourceChangedError(this.sourcePath);
    }
    return id;
  }
}

/** Rewrites only the unread suffix immediately after turn zero's checkpoint
 * reaches storage. The wrapper's post-save prefix check succeeds; the next
 * turn's wider proof then forces recovery from the latest durable boundary. */
class RewriteAfterFirstTurnCheckpointStorage extends MemoryStorage {
  private rewritten = false;

  constructor(
    private readonly sourcePath: string,
    private readonly replacement: JsonlLine[],
  ) {
    super();
  }

  override async upsertCaptureCheckpoint(
    input: Parameters<MemoryStorage["upsertCaptureCheckpoint"]>[0],
  ) {
    const checkpoint = await super.upsertCaptureCheckpoint(input);
    if (
      !this.rewritten &&
      input.ordinal === 0 &&
      input.state?.["jsonl_inflight_source"] !== undefined
    ) {
      this.rewritten = true;
      writeJsonlFresh(this.sourcePath, this.replacement);
    }
    return checkpoint;
  }
}

interface JsonlLine {
  type: "user" | "assistant";
  sessionId: string;
  cwd: string;
  message: {
    role: "user" | "assistant";
    content: unknown;
    stop_reason?: string;
  };
  uuid: string;
  timestamp: string;
  parentUuid?: string;
  isSidechain?: boolean;
  agentId?: string;
}

function userText(
  sessionId: string,
  uuid: string,
  text: string,
  ts = "2026-04-30T10:00:00Z",
): JsonlLine {
  return {
    type: "user",
    sessionId,
    cwd: "/Users/x/proj",
    message: { role: "user", content: text },
    uuid,
    timestamp: ts,
  };
}

function assistantText(
  sessionId: string,
  uuid: string,
  text: string,
  ts = "2026-04-30T10:00:00Z",
): JsonlLine {
  return {
    type: "assistant",
    sessionId,
    cwd: "/Users/x/proj",
    message: { role: "assistant", content: [{ type: "text", text }] },
    uuid,
    timestamp: ts,
  };
}

function assistantEndTurn(
  sessionId: string,
  uuid: string,
  text: string,
  ts = "2026-04-30T10:00:00Z",
): JsonlLine {
  const line = assistantText(sessionId, uuid, text, ts);
  line.message.stop_reason = "end_turn";
  return line;
}

function assistantToolUse(sessionId: string, uuid: string): JsonlLine {
  return {
    type: "assistant",
    sessionId,
    cwd: "/Users/x/proj",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } },
      ],
    },
    uuid,
    timestamp: "2026-04-30T10:00:00Z",
  };
}

function userToolResult(sessionId: string, uuid: string): JsonlLine {
  return {
    type: "user",
    sessionId,
    cwd: "/Users/x/proj",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
    },
    uuid,
    timestamp: "2026-04-30T10:00:00Z",
  };
}

describe("extractClaudeCodeTurns (pure)", () => {
  let dir: string;
  let captured: ReturnType<typeof captureStdout>;

  beforeEach(() => {
    dir = tmpDir("echo-cc-");
    captured = captureStdout();
  });

  afterEach(() => {
    captured.restore();
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses the static fixture: turns paired correctly, tools surfaced via had_tool_use", async () => {
    const fixturePath = join(
      __dirname,
      "..",
      "..",
      "fixtures",
      "claude-code-session.jsonl",
    );
    const { turns, newOffset } = await extractClaudeCodeTurns(fixturePath, 0);

    expect(turns.map((t) => [t.user_message, t.assistant_message])).toEqual([
      ["First question", "First answer"],
      ["Now with tools", "Found two files."],
      ["Thanks", "You're welcome"],
    ]);
    expect(turns[0]?.had_tool_use).toBe(false);
    expect(turns[1]?.had_tool_use).toBe(true);
    expect(turns[2]?.had_tool_use).toBe(false);
    expect(turns.every((t) => t.session_id === "claude-code-session")).toBe(
      true,
    );
    expect(turns.every((t) => t.byte_offset > 0)).toBe(true);
    // Under cluster-pairing, newOffset = end of the last emitted turn's last
    // contributing line, which is strictly less than fileSize because the
    // trailing closing-user line is consumed but pending (no closing user
    // after it).
    const fixtureSize = readFileSync(fixturePath).length;
    expect(newOffset).toBeGreaterThan(0);
    expect(newOffset).toBeLessThan(fixtureSize);
    expect(newOffset).toBe(turns[turns.length - 1]!.byte_offset);
  });

  it("pairs one user with multiple consecutive text-bearing assistant lines into a single turn", async () => {
    const path = join(dir, "sess.jsonl");
    writeJsonlFresh(path, [
      userText("s1", "u1", "fix the bug"),
      assistantText("s1", "a1", "thinking..."),
      assistantText("s1", "a2", "I see the issue"),
      assistantText("s1", "a3", "here is the fix"),
      userText("s1", "u2", "thanks"), // closes the cluster
    ]);
    const { turns } = await extractClaudeCodeTurns(path, 0);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.user_message).toBe("fix the bug");
    expect(turns[0]?.assistant_message).toBe(
      "thinking...\n\nI see the issue\n\nhere is the fix",
    );
  });

  it("keeps a Claude teammate task as the logical turn when a system reminder follows it", async () => {
    const path = join(dir, "agent-sess.jsonl");
    const teammate = userText(
      "root-session",
      "019f0000-0000-7000-8000-000000000001",
      '<teammate-message teammate_id="reviewer">Review the topology.</teammate-message>',
      "2026-04-30T10:00:00.000Z",
    );
    teammate.parentUuid = "019effff-ffff-7000-8000-000000000000";
    teammate.isSidechain = true;
    teammate.agentId = "reviewer@team";
    const reminder = userText(
      "root-session",
      "019f0000-0001-7000-8000-000000000002",
      "<system-reminder>Read-only review.</system-reminder>",
      "2026-04-30T10:00:01.000Z",
    );
    reminder.isSidechain = true;
    reminder.agentId = "reviewer@team";
    const answer = assistantEndTurn(
      "root-session",
      "019f0000-0002-7000-8000-000000000003",
      "The topology is bounded.",
      "2026-04-30T10:00:02.000Z",
    );
    answer.isSidechain = true;
    answer.agentId = "reviewer@team";
    writeJsonlFresh(path, [teammate, reminder, answer]);

    const { turns } = await extractClaudeCodeTurns(path, 0);

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      user_message:
        '<teammate-message teammate_id="reviewer">Review the topology.</teammate-message>',
      assistant_message: "The topology is bounded.",
      logical_turn_id: "019f0000-0000-7000-8000-000000000001",
      occurred_at: "2026-04-30T10:00:00.000Z",
      observed_at: "2026-04-30T10:00:02.000Z",
      root_thread_id: "root-session",
      thread_id: "reviewer@team",
      thread_kind: "subagent",
      agent_id: "reviewer@team",
      initiator: "agent",
      observation_kind: "original",
    });
    expect(turns[0]).not.toHaveProperty("parent_logical_turn_id");
  });

  it("classifies a complete root identity as original", async () => {
    const path = join(dir, "root-identity.jsonl");
    const user = userText(
      "root-session",
      "019f0000-0000-7000-8000-000000000001",
      "Continue the root task.",
    );
    user.isSidechain = false;
    writeJsonlFresh(path, [
      user,
      assistantEndTurn(
        "root-session",
        "019f0000-0001-7000-8000-000000000002",
        "Continuing.",
      ),
    ]);

    const { turns } = await extractClaudeCodeTurns(path, 0);

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      thread_id: "root-session",
      root_thread_id: "root-session",
      thread_kind: "root",
      initiator: "human",
      observation_kind: "original",
    });
  });

  it("fails incomplete or contradictory Claude thread identity closed", async () => {
    const cases: Array<{
      name: string;
      mutate: (line: JsonlLine) => void;
    }> = [
      {
        name: "missing-session",
        mutate: (line) => {
          (line as unknown as Record<string, unknown>)["sessionId"] = "";
          line.isSidechain = false;
        },
      },
      {
        name: "missing-logical-turn",
        mutate: (line) => {
          (line as unknown as Record<string, unknown>)["uuid"] = "";
          line.isSidechain = false;
        },
      },
      {
        name: "sidechain-without-agent",
        mutate: (line) => {
          line.isSidechain = true;
        },
      },
      {
        name: "root-with-agent",
        mutate: (line) => {
          line.isSidechain = false;
          line.agentId = "contradictory-agent";
        },
      },
      {
        name: "agent-without-sidechain-marker",
        mutate: (line) => {
          line.agentId = "ambiguous-agent";
        },
      },
    ];

    for (const testCase of cases) {
      const path = join(dir, `${testCase.name}.jsonl`);
      const user = userText(
        "root-session",
        "019f0000-0000-7000-8000-000000000001",
        `case: ${testCase.name}`,
      );
      testCase.mutate(user);
      writeJsonlFresh(path, [
        user,
        assistantEndTurn(
          "root-session",
          "019f0000-0001-7000-8000-000000000002",
          "observed",
        ),
      ]);

      const { turns } = await extractClaudeCodeTurns(path, 0);
      expect(turns, testCase.name).toHaveLength(1);
      expect(turns[0]?.thread_kind, testCase.name).toBe("unknown");
      expect(turns[0]?.observation_kind, testCase.name).toBe("unknown");
      expect(turns[0]?.thread_id, testCase.name).toBeUndefined();
      expect(turns[0]?.root_thread_id, testCase.name).toBeUndefined();
      expect(turns[0]?.agent_id, testCase.name).toBeUndefined();
    }
  });

  it("does not let a system reminder replace a pending human prompt", async () => {
    const path = join(dir, "human-reminder.jsonl");
    writeJsonlFresh(path, [
      userText("root-session", "human-u1", "Explain the current thread."),
      userText(
        "root-session",
        "system-u1",
        "<system-reminder>Use concise output.</system-reminder>",
      ),
      assistantEndTurn(
        "root-session",
        "assistant-a1",
        "It is the topology thread.",
      ),
    ]);

    const { turns } = await extractClaudeCodeTurns(path, 0);

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      user_message: "Explain the current thread.",
      assistant_message: "It is the topology thread.",
      logical_turn_id: "human-u1",
      initiator: "human",
    });
  });

  it("returns all turns when reading from offset 0 on a fresh JSONL", async () => {
    const path = join(dir, "sess.jsonl");
    writeJsonlFresh(path, [
      userText("s1", "u1", "Q1"),
      assistantText("s1", "a1", "A1"),
      userText("s1", "u2", "Q2"),
      assistantText("s1", "a2", "A2"),
      userText("s1", "u3", "Q3"), // closes the second cluster
    ]);

    const { turns, newOffset } = await extractClaudeCodeTurns(path, 0);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.user_message).toBe("Q1");
    expect(turns[0]?.assistant_message).toBe("A1");
    expect(turns[1]?.user_message).toBe("Q2");
    expect(turns[0]?.byte_offset).toBeLessThan(turns[1]!.byte_offset);
    expect(newOffset).toBe(turns[1]!.byte_offset);
  });

  it("resumes from a prior newOffset and returns only newly-appended turns", async () => {
    const path = join(dir, "sess.jsonl");
    // u2 closes cluster {u1, a1}; u2 stays pending until the next user arrives.
    writeJsonlFresh(path, [
      userText("s1", "u1", "Q1"),
      assistantText("s1", "a1", "A1"),
      userText("s1", "u2", "Q2"),
    ]);
    const first = await extractClaudeCodeTurns(path, 0);
    expect(first.turns).toHaveLength(1);
    expect(first.turns[0]?.user_message).toBe("Q1");

    // a2 attaches to pending u2; u3 closes that cluster.
    appendJsonl(path, [
      assistantText("s1", "a2", "A2"),
      userText("s1", "u3", "Q3"),
    ]);
    const second = await extractClaudeCodeTurns(path, first.newOffset);
    expect(second.turns).toHaveLength(1);
    expect(second.turns[0]?.user_message).toBe("Q2");
    expect(second.turns[0]?.assistant_message).toBe("A2");
  });

  it("counts blank-line bytes exactly across a checkpoint restart without replay or skip", async () => {
    const path = join(dir, "sess.jsonl");
    const firstLines = [
      JSON.stringify(userText("s1", "u1", "Q1")),
      "",
      "",
      JSON.stringify(assistantText("s1", "a1", "A1")),
      JSON.stringify(userText("s1", "u2", "Q2")),
    ];
    const initial = `${firstLines.join("\n")}\n`;
    writeFileSync(path, initial);
    const expectedFirstOffset = Buffer.byteLength(
      `${firstLines.slice(0, 4).join("\n")}\n`,
    );

    const first = await extractClaudeCodeTurns(path, 0);
    expect(first.turns.map((turn) => turn.user_message)).toEqual(["Q1"]);
    expect(first.newOffset).toBe(expectedFirstOffset);
    expect(first.turns[0]?.byte_offset).toBe(expectedFirstOffset);

    const assistant2 = JSON.stringify(assistantText("s1", "a2", "A2"));
    const closingUser = JSON.stringify(userText("s1", "u3", "Q3"));
    const appended = `\n${assistant2}\n\n${closingUser}\n`;
    appendFileSync(path, appended);
    const expectedSecondOffset =
      Buffer.byteLength(initial) + Buffer.byteLength(`\n${assistant2}\n\n`);

    const second = await extractClaudeCodeTurns(path, first.newOffset);
    expect(second.turns.map((turn) => turn.user_message)).toEqual(["Q2"]);
    expect(second.turns[0]?.assistant_message).toBe("A2");
    expect(second.newOffset).toBe(expectedSecondOffset);
  });

  it("partial line: bytes without trailing newline are NOT consumed; next call after newline returns full turn", async () => {
    const path = join(dir, "sess.jsonl");
    writeJsonlFresh(path, [
      userText("s1", "u1", "Q1"),
      assistantText("s1", "a1", "A1"),
      userText("s1", "u2", "Q2"), // closes {u1, a1}; u2 pending
    ]);
    const first = await extractClaudeCodeTurns(path, 0);
    expect(first.turns).toHaveLength(1);

    // Append a partial assistant line (no trailing newline) — would attach to
    // pending u2 once complete.
    const partial = JSON.stringify(assistantText("s1", "a2", "A2"));
    appendFileSync(path, partial);
    const second = await extractClaudeCodeTurns(path, first.newOffset);
    expect(second.turns).toHaveLength(0);
    expect(second.newOffset).toBe(first.newOffset);

    // Complete the partial line, then add a closing user.
    appendFileSync(path, "\n");
    appendFileSync(path, JSON.stringify(userText("s1", "u3", "Q3")) + "\n");
    const third = await extractClaudeCodeTurns(path, second.newOffset);
    expect(third.turns).toHaveLength(1);
    expect(third.turns[0]?.user_message).toBe("Q2");
    expect(third.turns[0]?.assistant_message).toBe("A2");
  });

  it("back-to-back user lines without an assistant reply surface dropped users with classification", async () => {
    const path = join(dir, "sess.jsonl");
    writeJsonlFresh(path, [
      userText(
        "s1",
        "u1",
        "<system-reminder>auto-mode active</system-reminder>",
      ),
      userText("s1", "u2", "real prompt that got dropped"),
      userText("s1", "u3", "second real prompt"),
      assistantText("s1", "a1", "A1"),
      userText("s1", "u4", "closes cluster"),
    ]);
    const { turns, droppedUsers } = await extractClaudeCodeTurns(path, 0);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.user_message).toBe("second real prompt");
    expect(droppedUsers).toHaveLength(2);
    expect(droppedUsers[0]?.classification).toBe("inject");
    expect(droppedUsers[1]?.classification).toBe("prompt");
    expect(droppedUsers[1]?.byte_count).toBe(
      Buffer.byteLength("real prompt that got dropped"),
    );
    expect(droppedUsers[1]).not.toHaveProperty("sha256");
    // byte_offsets are monotonic so the dispatcher can dedup with a watermark.
    expect(droppedUsers[0]!.byte_offset).toBeLessThan(
      droppedUsers[1]!.byte_offset,
    );
  });

  it("incomplete turn (only user, no assistant yet) emits zero turns", async () => {
    const path = join(dir, "sess.jsonl");
    writeJsonlFresh(path, [userText("s1", "u1", "Q1")]);
    const { turns, newOffset } = await extractClaudeCodeTurns(path, 0);
    expect(turns).toHaveLength(0);
    // No turn emitted means confirmedThroughOffset stays at lastByteOffset (0)
    // — the user line is "consumed" but pending, so the next pass re-reads it.
    expect(newOffset).toBe(0);
  });

  it("stops at a bounded page when one logical cluster exceeds the budget", async () => {
    const path = join(dir, "sess.jsonl");
    const huge = "x".repeat(1_500_000);
    writeJsonlFresh(path, [
      userText("s1", "u1", "oversized question"),
      assistantText("s1", "a1", huge),
      assistantText("s1", "a2", huge),
      assistantText("s1", "a3", huge),
      userText("s1", "u2", "bounded question"),
      assistantEndTurn("s1", "a4", "bounded answer"),
    ]);

    const result = await extractClaudeCodeTurns(path, 0);

    expect(result.turns).toEqual([]);
    expect(result.newOffset).toBe(0);
    expect(result.firstUserOffset).toBe(0);
    expect(
      result.readSnapshot!.through_offset - result.readSnapshot!.first_offset,
    ).toBeLessThanOrEqual(MAX_JSONL_READ_BYTES);
  });

  it("drops orphan assistant (no preceding user) and warns", async () => {
    const path = join(dir, "sess.jsonl");
    writeJsonlFresh(path, [
      assistantText("s1", "a1", "orphan"),
      userText("s1", "u1", "Q1"),
      assistantText("s1", "a2", "A1"),
      userText("s1", "u2", "Q2"), // closes the cluster
    ]);
    const { turns } = await extractClaudeCodeTurns(path, 0);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.user_message).toBe("Q1");
    expect(turns[0]?.assistant_message).toBe("A1");
    expect(captured.writes.join("")).toContain("orphan_assistant");
  });

  it("skips malformed JSON lines and continues", async () => {
    const path = join(dir, "sess.jsonl");
    const lines = [
      JSON.stringify(userText("s1", "u1", "Q1")),
      "{not valid json",
      JSON.stringify(assistantText("s1", "a1", "A1")),
      JSON.stringify(userText("s1", "u2", "Q2")), // closes the cluster
    ];
    writeFileSync(path, lines.join("\n") + "\n");
    const { turns } = await extractClaudeCodeTurns(path, 0);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.user_message).toBe("Q1");
    expect(turns[0]?.assistant_message).toBe("A1");
  });

  it("byte_offset on emitted turn equals the offset just past the last assistant line in the cluster", async () => {
    const path = join(dir, "sess.jsonl");
    // Compute the offset that should match: end of the assistant line, before
    // the closing user line is appended.
    writeJsonlFresh(path, [
      userText("s1", "u1", "Q1"),
      assistantText("s1", "a1", "A1"),
    ]);
    const offsetAtEndOfAssistant = readFileSync(path).length;
    appendJsonl(path, [userText("s1", "u2", "Q2")]); // closes the cluster
    const { turns } = await extractClaudeCodeTurns(path, 0);
    expect(turns[0]?.byte_offset).toBe(offsetAtEndOfAssistant);
  });

  it("tool_use + tool_result interleaved with text-bearing assistant: tool flag and text both surface", async () => {
    const path = join(dir, "sess.jsonl");
    writeJsonlFresh(path, [
      userText("s1", "u1", "Q1"),
      assistantToolUse("s1", "a1"),
      userToolResult("s1", "u2"),
      assistantText("s1", "a2", "tool-mediated answer"),
      userText("s1", "u3", "Q3"), // closes the cluster
    ]);
    const { turns } = await extractClaudeCodeTurns(path, 0);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.user_message).toBe("Q1");
    expect(turns[0]?.assistant_message).toBe("tool-mediated answer");
    expect(turns[0]?.had_tool_use).toBe(true);
  });

  it("returns no turns and same offset when file does not exist", async () => {
    const { turns, newOffset } = await extractClaudeCodeTurns(
      join(dir, "missing.jsonl"),
      0,
    );
    expect(turns).toHaveLength(0);
    expect(newOffset).toBe(0);
  });

  it("returns no turns and same offset when offset is at or past EOF", async () => {
    const path = join(dir, "sess.jsonl");
    writeJsonlFresh(path, [
      userText("s1", "u1", "Q1"),
      assistantText("s1", "a1", "A1"),
    ]);
    const fileSize = readFileSync(path).length;
    const r = await extractClaudeCodeTurns(path, fileSize);
    expect(r.turns).toHaveLength(0);
    expect(r.newOffset).toBe(fileSize);
  });

  // ─── Tier-3 metadata: tool_calls, thinking ────────────────────────────────

  it("extracts tool_calls with name + args + output, matching by tool_use_id", async () => {
    const path = join(dir, "sess.jsonl");
    const ts = "2026-04-30T10:00:00Z";
    const sessionId = "s1";
    const cwd = "/Users/x/proj";
    const u1: JsonlLine = {
      type: "user",
      sessionId,
      cwd,
      message: { role: "user", content: "do a thing" },
      uuid: "u1",
      timestamp: ts,
    };
    const aTool: JsonlLine = {
      type: "assistant",
      sessionId,
      cwd,
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu_42",
            name: "Bash",
            input: { command: "ls -la", description: "list" },
          },
        ],
      },
      uuid: "a1",
      timestamp: ts,
    };
    const uResult: JsonlLine = {
      type: "user",
      sessionId,
      cwd,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_42",
            content: "total 12\nfoo.txt",
            is_error: false,
          },
        ],
      },
      uuid: "u2",
      timestamp: ts,
    };
    const aFinal: JsonlLine = {
      type: "assistant",
      sessionId,
      cwd,
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      uuid: "a2",
      timestamp: ts,
    };
    const uClose: JsonlLine = {
      type: "user",
      sessionId,
      cwd,
      message: { role: "user", content: "next" },
      uuid: "u3",
      timestamp: ts,
    };
    writeJsonlFresh(path, [u1, aTool, uResult, aFinal, uClose]);
    const r = await extractClaudeCodeTurns(path, 0);
    expect(r.turns).toHaveLength(1);
    const tc = r.turns[0]?.tool_calls;
    expect(tc).toHaveLength(1);
    expect(tc?.[0]).toMatchObject({
      name: "Bash",
      call_id: "tu_42",
      output: "total 12\nfoo.txt",
    });
    expect(tc?.[0]?.args).toContain('"command":"ls -la"');
  });

  it("marks tool_calls.is_error when tool_result.is_error is true", async () => {
    const path = join(dir, "sess.jsonl");
    const ts = "2026-04-30T10:00:00Z";
    const lines: JsonlLine[] = [
      {
        type: "user",
        sessionId: "s1",
        cwd: "/Users/x/proj",
        message: { role: "user", content: "try" },
        uuid: "u1",
        timestamp: ts,
      },
      {
        type: "assistant",
        sessionId: "s1",
        cwd: "/Users/x/proj",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tu1",
              name: "Bash",
              input: { command: "false" },
            },
          ],
        },
        uuid: "a1",
        timestamp: ts,
      },
      {
        type: "user",
        sessionId: "s1",
        cwd: "/Users/x/proj",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu1",
              content: "oops",
              is_error: true,
            },
          ],
        },
        uuid: "u2",
        timestamp: ts,
      },
      {
        type: "assistant",
        sessionId: "s1",
        cwd: "/Users/x/proj",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "failed" }],
        },
        uuid: "a2",
        timestamp: ts,
      },
      {
        type: "user",
        sessionId: "s1",
        cwd: "/Users/x/proj",
        message: { role: "user", content: "next" },
        uuid: "u3",
        timestamp: ts,
      },
    ];
    writeJsonlFresh(path, lines);
    const r = await extractClaudeCodeTurns(path, 0);
    expect(r.turns[0]?.tool_calls?.[0]?.is_error).toBe(true);
  });

  it("extracts thinking content blocks into the thinking field", async () => {
    const path = join(dir, "sess.jsonl");
    const ts = "2026-04-30T10:00:00Z";
    const lines: JsonlLine[] = [
      {
        type: "user",
        sessionId: "s1",
        cwd: "/Users/x/proj",
        message: { role: "user", content: "q" },
        uuid: "u1",
        timestamp: ts,
      },
      {
        type: "assistant",
        sessionId: "s1",
        cwd: "/Users/x/proj",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "pondering the request…" },
            { type: "text", text: "a" },
          ],
        },
        uuid: "a1",
        timestamp: ts,
      },
      {
        type: "user",
        sessionId: "s1",
        cwd: "/Users/x/proj",
        message: { role: "user", content: "next" },
        uuid: "u2",
        timestamp: ts,
      },
    ];
    writeJsonlFresh(path, lines);
    const r = await extractClaudeCodeTurns(path, 0);
    expect(r.turns[0]?.thinking).toContain("pondering");
  });

  // ─── Per-line CC metadata (gitBranch / permissionMode / version / model) ──

  it("surfaces gitBranch, permissionMode, version, and model from JSONL lines", async () => {
    const path = join(dir, "sess.jsonl");
    const ts = "2026-04-30T10:00:00Z";
    const u1 = {
      type: "user",
      sessionId: "s1",
      cwd: "/Users/x/proj",
      gitBranch: "feature/x",
      permissionMode: "auto",
      version: "2.1.119",
      message: { role: "user", content: "q" },
      uuid: "u1",
      timestamp: ts,
    };
    const a1 = {
      type: "assistant",
      sessionId: "s1",
      cwd: "/Users/x/proj",
      gitBranch: "feature/x",
      version: "2.1.119",
      message: {
        role: "assistant",
        model: "claude-opus-4-7",
        content: [{ type: "text", text: "a" }],
      },
      uuid: "a1",
      timestamp: ts,
    };
    const u2 = {
      type: "user",
      sessionId: "s1",
      cwd: "/Users/x/proj",
      gitBranch: "feature/x",
      message: { role: "user", content: "next" },
      uuid: "u2",
      timestamp: ts,
    };
    writeFileSync(
      path,
      [u1, a1, u2].map((l) => JSON.stringify(l)).join("\n") + "\n",
    );
    const r = await extractClaudeCodeTurns(path, 0);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]?.git_branch_jsonl).toBe("feature/x");
    expect(r.turns[0]?.permission_mode).toBe("auto");
    expect(r.turns[0]?.cli_version).toBe("2.1.119");
    expect(r.turns[0]?.model).toBe("claude-opus-4-7");
  });

  it("omits per-line metadata fields when JSONL lines lack them (back-compat)", async () => {
    const path = join(dir, "sess.jsonl");
    writeJsonlFresh(path, [
      userText("s1", "u1", "q"),
      assistantText("s1", "a1", "a"),
      userText("s1", "u2", "next"),
    ]);
    const r = await extractClaudeCodeTurns(path, 0);
    expect(r.turns[0]?.git_branch_jsonl).toBeUndefined();
    expect(r.turns[0]?.permission_mode).toBeUndefined();
    expect(r.turns[0]?.cli_version).toBeUndefined();
    expect(r.turns[0]?.model).toBeUndefined();
  });

  // ─── Tool-call overflow accounting ────────────────────────────────────────

  it("emits tool_call_total + tool_calls_truncated when uses exceed MAX_TOOL_CALLS_PER_TURN", async () => {
    const path = join(dir, "sess.jsonl");
    const ts = "2026-04-30T10:00:00Z";
    const sessionId = "s1";
    const cwd = "/Users/x/proj";
    // 60 tool_use blocks in one assistant message — over the 50 cap.
    const toolUses = Array.from({ length: 60 }, (_, i) => ({
      type: "tool_use" as const,
      id: `tu_${i}`,
      name: "Bash",
      input: { command: `echo ${i}` },
    }));
    const lines = [
      {
        type: "user",
        sessionId,
        cwd,
        message: { role: "user", content: "go" },
        uuid: "u1",
        timestamp: ts,
      },
      {
        type: "assistant",
        sessionId,
        cwd,
        message: { role: "assistant", content: toolUses },
        uuid: "a1",
        timestamp: ts,
      },
      {
        type: "assistant",
        sessionId,
        cwd,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        },
        uuid: "a2",
        timestamp: ts,
      },
      {
        type: "user",
        sessionId,
        cwd,
        message: { role: "user", content: "next" },
        uuid: "u2",
        timestamp: ts,
      },
    ];
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const r = await extractClaudeCodeTurns(path, 0);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]?.tool_calls).toHaveLength(50);
    expect(r.turns[0]?.tool_call_total).toBe(60);
    expect(r.turns[0]?.tool_calls_truncated).toBe(true);
  });

  it("emits tool_call_total without truncated flag when at or under the cap", async () => {
    const path = join(dir, "sess.jsonl");
    const ts = "2026-04-30T10:00:00Z";
    const sessionId = "s1";
    const cwd = "/Users/x/proj";
    const toolUses = Array.from({ length: 3 }, (_, i) => ({
      type: "tool_use" as const,
      id: `tu_${i}`,
      name: "Bash",
      input: { command: `echo ${i}` },
    }));
    const lines = [
      {
        type: "user",
        sessionId,
        cwd,
        message: { role: "user", content: "go" },
        uuid: "u1",
        timestamp: ts,
      },
      {
        type: "assistant",
        sessionId,
        cwd,
        message: { role: "assistant", content: toolUses },
        uuid: "a1",
        timestamp: ts,
      },
      {
        type: "assistant",
        sessionId,
        cwd,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        },
        uuid: "a2",
        timestamp: ts,
      },
      {
        type: "user",
        sessionId,
        cwd,
        message: { role: "user", content: "next" },
        uuid: "u2",
        timestamp: ts,
      },
    ];
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const r = await extractClaudeCodeTurns(path, 0);
    expect(r.turns[0]?.tool_call_total).toBe(3);
    expect(r.turns[0]?.tool_calls_truncated).toBeUndefined();
  });
});

describe("startClaudeCodeExtractor (lifecycle + integration)", () => {
  let dir: string;
  let projectsPrefix: string;
  let projDir: string;
  let storage: MemoryStorage;
  let handle: ClaudeCodeExtractorHandle | null = null;
  let originalFsPaths: string[];
  let captured: ReturnType<typeof captureStdout>;

  beforeEach(() => {
    originalFsPaths = snapshotFsPaths();
    dir = tmpDir("echo-cc-int-");
    projectsPrefix = `${dir}/projects/`;
    projDir = join(projectsPrefix, "my-proj");
    mkdirSync(projDir, { recursive: true });
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

  it("accepts its configured custom projects root without widening the global fs allowlist", async () => {
    resetAllowlist();
    restoreFsPaths(originalFsPaths);
    expect(CAPTURED_SOURCES.fs_paths).not.toContain(`${dir}/`);
    const path = join(projDir, "custom-root.jsonl");
    writeJsonlFresh(path, [
      userText("custom", "u1", "Q1"),
      assistantText("custom", "a1", "A1"),
      userText("custom", "u2", "Q2"),
    ]);

    handle = await startClaudeCodeExtractor(storage, { projectsPrefix });
    await waitFor(async () => (await storage.count()) >= 1);

    const events = await storage.query({ order: "asc" });
    expect(events).toHaveLength(1);
    expect(events[0]!.source).toBe(`fs:${path}`);
  });

  it("preserves an oversized multi-line cluster exactly across a crash and restart", async () => {
    const path = join(projDir, "oversized.jsonl");
    const huge = "x".repeat(1_500_000);
    const oversizedBytes = Buffer.from(
      [
        userText("s1", "u1", "oversized question"),
        assistantText("s1", "a1", huge),
        assistantText("s1", "a2", huge),
        assistantText("s1", "a3", huge),
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
    );
    const boundedBytes = Buffer.from(
      [
        userText("s1", "u2", "bounded question"),
        assistantEndTurn("s1", "a4", "bounded answer"),
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
    );
    const continuationBytes = Buffer.from(
      `${JSON.stringify(
        assistantText("s1", "a-cont", "oversized continuation"),
      )}\n`,
    );
    expect(oversizedBytes.byteLength).toBeGreaterThan(MAX_JSONL_READ_BYTES);
    const completedOversizedBytes = Buffer.concat([
      oversizedBytes,
      continuationBytes,
    ]);
    const source = Buffer.concat([
      oversizedBytes,
      continuationBytes,
      boundedBytes,
    ]);
    writeFileSync(path, oversizedBytes);

    const flaky = new AppendThenFailStorage(JSONL_RAW_FRAGMENT_CONTENT_PREFIX);
    storage = flaky;
    handle = await startClaudeCodeExtractor(flaky, { projectsPrefix });
    await handle.initialCatchUp;
    expect(handle.getHealth().state).toBe("unhealthy");
    const crashed = await flaky.query({
      source: `fs:${path}`,
      order: "asc",
      limit: 500,
    });
    const firstFragment = crashed.find(
      (event) =>
        event.metadata?.["capture_fragment"] === "oversized_jsonl_cluster",
    );
    expect(firstFragment).toBeDefined();

    await handle.stop();
    handle = null;
    flaky.allowCheckpoints();
    handle = await startClaudeCodeExtractor(flaky, { projectsPrefix });
    await handle.initialCatchUp;
    expect(handle.getHealth()).toMatchObject({
      state: "healthy",
      errorCount: 0,
    });
    const activeEvents = await flaky.query({
      source: `fs:${path}`,
      order: "asc",
      limit: 500,
    });
    const raw = expectExactRawJsonlFragments({
      events: activeEvents,
      expected: oversizedBytes,
      expectedExtractor: "claude_code",
      expectedStart: 0,
    });
    expect(raw.ids.filter((id) => id === firstFragment!.id)).toHaveLength(1);
    const activeCheckpoint = await flaky.getCaptureCheckpoint({
      extractor: "claude_code",
      resource: path,
    });
    expect(activeCheckpoint?.position).toBe(oversizedBytes.byteLength);
    expect(activeCheckpoint?.state).toHaveProperty("jsonl_raw_fallback");

    const idsBeforeBoundaryRestart = activeEvents
      .map((event) => event.id)
      .sort();
    await handle.stop();
    handle = null;
    handle = await startClaudeCodeExtractor(flaky, { projectsPrefix });
    await handle.initialCatchUp;
    expect(handle.getHealth()).toMatchObject({
      state: "healthy",
      errorCount: 0,
    });
    const boundaryRestarted = await flaky.query({
      source: `fs:${path}`,
      order: "asc",
      limit: 500,
    });
    expect(boundaryRestarted.map((event) => event.id).sort()).toEqual(
      idsBeforeBoundaryRestart,
    );
    const boundaryRestartedCheckpoint = await flaky.getCaptureCheckpoint({
      extractor: "claude_code",
      resource: path,
    });
    expect(boundaryRestartedCheckpoint?.state["jsonl_raw_fallback"]).toEqual(
      activeCheckpoint?.state["jsonl_raw_fallback"],
    );

    appendFileSync(path, Buffer.concat([continuationBytes, boundedBytes]));
    await waitFor(async () => {
      const checkpoint = await flaky.getCaptureCheckpoint({
        extractor: "claude_code",
        resource: path,
      });
      return checkpoint?.position === source.byteLength;
    });
    const events = await flaky.query({
      source: `fs:${path}`,
      order: "asc",
      limit: 500,
    });
    expectExactRawJsonlFragments({
      events,
      expected: completedOversizedBytes,
      expectedExtractor: "claude_code",
      expectedStart: 0,
    });
    const semantic = events.filter(
      (event) =>
        event.content === "USER: bounded question\n\nASSISTANT: bounded answer",
    );
    expect(semantic).toHaveLength(1);
    expect(semantic[0]?.metadata?.["turn_index"]).toBe(0);
    const checkpoint = await flaky.getCaptureCheckpoint({
      extractor: "claude_code",
      resource: path,
    });
    expect(checkpoint?.position).toBe(source.byteLength);
    expect(checkpoint?.state).not.toHaveProperty("jsonl_raw_fallback");

    const idsBeforeCleanRestart = events.map((event) => event.id).sort();
    await handle.stop();
    handle = null;
    handle = await startClaudeCodeExtractor(flaky, { projectsPrefix });
    await handle.initialCatchUp;
    expect(handle.getHealth()).toMatchObject({
      state: "healthy",
      errorCount: 0,
    });
    const restarted = await flaky.query({
      source: `fs:${path}`,
      order: "asc",
      limit: 500,
    });
    expect(restarted.map((event) => event.id).sort()).toEqual(
      idsBeforeCleanRestart,
    );
  }, 20_000);

  it("emits one CandidateEvent per turn through the pipeline on file growth", async () => {
    handle = await startClaudeCodeExtractor(storage, { projectsPrefix });
    const path = join(projDir, "sess.jsonl");

    writeJsonlFresh(path, [
      userText("s1", "u1", "Q1"),
      assistantText("s1", "a1", "A1"),
      userText("s1", "u2", "Q2"), // closes the cluster
    ]);
    await waitFor(async () => (await storage.count()) >= 1);

    const events = await storage.query({ order: "asc" });
    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.source).toBe(`fs:${path}`);
    expect(evt.content).toBe("USER: Q1\n\nASSISTANT: A1");
    expect(evt.metadata).toMatchObject({
      project: "my-proj",
      session_id: "sess",
      turn_index: 0,
    });
    expect(evt.metadata).toHaveProperty("byte_offset");
  });

  it("seeds source identity for a migrated offset-only checkpoint at EOF without replay", async () => {
    const path = join(projDir, "migrated.jsonl");
    writeJsonlFresh(path, [
      userText("s1", "u1", "already captured"),
      assistantEndTurn("s1", "a1", "old answer"),
    ]);
    await storage.upsertCaptureCheckpoint({
      extractor: "claude_code",
      resource: path,
      position: readFileSync(path).length,
      ordinal: 0,
      state: {},
      updated_at: "2026-07-20T00:00:00.000Z",
    });

    handle = await startClaudeCodeExtractor(storage, { projectsPrefix });
    await handle.initialCatchUp;

    const checkpoint = await storage.getCaptureCheckpoint({
      extractor: "claude_code",
      resource: path,
    });
    expect(checkpoint?.state["jsonl_source"]).toMatchObject({
      boundary_offset: readFileSync(path).length,
      generation: 0,
    });
    expect(await storage.count()).toBe(0);
  });

  it("never logs malformed JSONL content or dropped user-prompt text", async () => {
    handle = await startClaudeCodeExtractor(storage, { projectsPrefix });
    const path = join(projDir, "secret-log-regression.jsonl");
    const sentinel = "SENTINEL_SECRET_DO_NOT_LOG_4b39f81e";
    const lines = [
      `{ malformed: ${sentinel}`,
      JSON.stringify(userText("s1", "u1", sentinel)),
      JSON.stringify(userText("s1", "u2", "safe prompt")),
      JSON.stringify(assistantText("s1", "a1", "safe answer")),
      JSON.stringify(userText("s1", "u3", "close")),
    ];
    writeFileSync(path, `${lines.join("\n")}\n`);

    await waitFor(async () => (await storage.count()) >= 1);
    const logs = captured.writes.join("");
    expect(logs).not.toContain(sentinel);
    expect(logs).not.toContain("previews");
    expect(logs).toContain("malformed_json");
    expect(logs).toContain("user_prompt_dropped_without_assistant_reply");
    expect(logs).toContain("total_bytes");
    expect(logs).toContain("byte_offset");
  });

  it("recovers from truncation and an equal-sized replacement across restart", async () => {
    const path = join(projDir, "rotating.jsonl");
    writeJsonlFresh(path, [
      userText("s1", "u-old", "old prompt with a deliberately long suffix"),
      assistantEndTurn(
        "s1",
        "a-old",
        "old answer with a deliberately long suffix",
      ),
    ]);
    handle = await startClaudeCodeExtractor(storage, { projectsPrefix });
    await waitFor(async () => (await storage.count()) >= 1);

    // writeFileSync truncates in place. The old offset is now beyond EOF, so
    // the extractor must reset instead of reporting healthy while skipping it.
    writeJsonlFresh(path, [
      userText("s1", "u1", "Q1"),
      assistantEndTurn("s1", "a1", "A1"),
    ]);
    await waitFor(async () => (await storage.count()) >= 2);
    expect(handle.getHealth().state).not.toBe("unhealthy");

    await handle.stop();
    handle = null;
    const replacement = join(projDir, "replacement.jsonl");
    writeJsonlFresh(replacement, [
      userText("s1", "u2", "Q2"),
      assistantEndTurn("s1", "a2", "A2"),
    ]);
    expect(readFileSync(replacement).length).toBe(readFileSync(path).length);
    renameSync(replacement, path);

    // With equal file size and an offset at EOF, an offset-only boot scan
    // would skip this replacement. Persisted identity must force a replay.
    handle = await startClaudeCodeExtractor(storage, { projectsPrefix });
    await waitFor(async () => (await storage.count()) >= 3);
    const events = await storage.query({ order: "asc" });
    expect(
      events.some((event) => event.content === "USER: Q1\n\nASSISTANT: A1"),
    ).toBe(true);
    expect(
      events.some((event) => event.content === "USER: Q2\n\nASSISTANT: A2"),
    ).toBe(true);
    const checkpoint = await storage.getCaptureCheckpoint({
      extractor: "claude_code",
      resource: path,
    });
    expect(
      (checkpoint?.state["jsonl_source"] as Record<string, unknown>)[
        "generation"
      ],
    ).toBe(2);
  });

  it("keeps the generation stable when benign growth races an accepted append before its checkpoint", async () => {
    const path = join(projDir, "benign-append-race.jsonl");
    writeJsonlFresh(path, [
      userText("s1", "u1", "Q1"),
      assistantEndTurn("s1", "a1", "A1"),
    ]);
    storage = new BenignAppendThenSignalStorage(path, [
      userText("s1", "u2", "Q2"),
      assistantEndTurn("s1", "a2", "A2"),
    ]);

    handle = await startClaudeCodeExtractor(storage, { projectsPrefix });
    await waitFor(async () => (await storage.count()) === 2);

    const events = await storage.query({ order: "asc" });
    expect(
      events.filter((event) => event.content === "USER: Q1\n\nASSISTANT: A1"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.content === "USER: Q2\n\nASSISTANT: A2"),
    ).toHaveLength(1);
    const checkpoint = await storage.getCaptureCheckpoint({
      extractor: "claude_code",
      resource: path,
    });
    expect(
      (checkpoint?.state["jsonl_source"] as Record<string, unknown>)[
        "generation"
      ],
    ).toBe(0);
    expect(captured.writes.join("")).toContain("handler_source_changed");
    expect(captured.writes.join("")).not.toContain("jsonl_read_retry");
  });

  it("retries a rewritten unread suffix from the latest durable turn", async () => {
    const path = join(projDir, "durable-turn-retry.jsonl");
    const firstTurn = [
      userText("s1", "u1", "Q1"),
      assistantEndTurn("s1", "a1", "A1"),
    ];
    writeJsonlFresh(path, [
      ...firstTurn,
      userText("s1", "u2", "OLD2"),
      assistantEndTurn("s1", "a2", "A2"),
    ]);
    storage = new RewriteAfterFirstTurnCheckpointStorage(path, [
      ...firstTurn,
      userText("s1", "u2", "NEW2"),
      assistantEndTurn("s1", "a2", "A2"),
    ]);

    handle = await startClaudeCodeExtractor(storage, { projectsPrefix });
    await waitFor(async () =>
      (await storage.query({ order: "asc" })).some(
        (event) => event.content === "USER: NEW2\n\nASSISTANT: A2",
      ),
    );

    const events = await storage.query({ order: "asc" });
    const first = events.filter(
      (event) => event.content === "USER: Q1\n\nASSISTANT: A1",
    );
    expect(first).toHaveLength(1);
    expect(
      events.some((event) => event.content === "USER: OLD2\n\nASSISTANT: A2"),
    ).toBe(false);
    const firstOffset = (first[0]!.metadata as Record<string, unknown>)[
      "byte_offset"
    ];
    const logs = captured.writes.join("");
    expect(logs).toContain('"message":"jsonl_read_retry"');
    expect(logs).toContain(`"retry_offset":${String(firstOffset)}`);
    expect(logs).toContain('"durable_boundary":true');
  });

  it("rewinds the bounded page start when the cumulative durable prefix was rewritten", async () => {
    const path = join(projDir, "durable-prefix-rewrite.jsonl");
    const suffix = "x".repeat(6_000);
    writeJsonlFresh(path, [
      userText("s1", "u1", `OLD${suffix}`),
      assistantEndTurn("s1", "a1", "A1"),
      userText("s1", "u2", "Q2"),
      assistantEndTurn("s1", "a2", "A2"),
    ]);
    storage = new RewriteAfterFirstTurnCheckpointStorage(path, [
      userText("s1", "u1", `NEW${suffix}`),
      assistantEndTurn("s1", "a1", "A1"),
      userText("s1", "u2", "Q2"),
      assistantEndTurn("s1", "a2", "A2"),
    ]);

    handle = await startClaudeCodeExtractor(storage, { projectsPrefix });
    await waitFor(async () =>
      (await storage.query({ order: "asc" })).some((event) =>
        event.content.startsWith("USER: NEW"),
      ),
    );

    const checkpoint = await storage.getCaptureCheckpoint({
      extractor: "claude_code",
      resource: path,
    });
    expect(
      (checkpoint?.state["jsonl_source"] as Record<string, unknown>)[
        "generation"
      ],
    ).toBe(1);
    const logs = captured.writes.join("");
    expect(logs).toContain('"message":"jsonl_read_retry"');
    expect(logs).toContain('"retry_offset":0');
    expect(logs).toContain('"durable_boundary":false');
  });

  it("does not suppress a same-inode rewrite during candidate append", async () => {
    const path = join(projDir, "append-race.jsonl");
    const suffix = "x".repeat(6_000);
    const oldLines = [
      userText("s1", "u1", `OLD${suffix}`),
      assistantEndTurn("s1", "a1", "answer"),
    ];
    const newLines = [
      userText("s1", "u1", `NEW${suffix}`),
      assistantEndTurn("s1", "a1", "answer"),
    ];
    writeJsonlFresh(path, oldLines);
    const initialSize = readFileSync(path).length;
    storage = new SameInodeRewriteDuringAppendStorage(path, newLines);

    handle = await startClaudeCodeExtractor(storage, { projectsPrefix });
    await handle.initialCatchUp;
    await waitFor(async () =>
      (await storage.query({ order: "asc" })).some((event) =>
        event.content.startsWith("USER: NEW"),
      ),
    );

    expect(readFileSync(path).length).toBe(initialSize);
    expect(handle.getHealth().state).not.toBe("unhealthy");
  });

  it("uses the persisted page proof to recover a rewrite plus growth after restart", async () => {
    const path = join(projDir, "restart-page-proof.jsonl");
    const suffix = "x".repeat(6_000);
    writeJsonlFresh(path, [
      userText("s1", "u1", `OLD${suffix}`),
      assistantEndTurn("s1", "a1", "answer"),
    ]);
    handle = await startClaudeCodeExtractor(storage, { projectsPrefix });
    await waitFor(async () => (await storage.count()) >= 1);
    await handle.stop();
    handle = null;
    const previousSize = readFileSync(path).length;

    writeJsonlFresh(path, [
      userText("s1", "u1", `NEW${suffix}`),
      assistantEndTurn("s1", "a1", "answer"),
      userText("s1", "u2", "later pending turn"),
    ]);
    expect(readFileSync(path).length).toBeGreaterThan(previousSize);

    handle = await startClaudeCodeExtractor(storage, { projectsPrefix });
    await waitFor(async () =>
      (await storage.query({ order: "asc" })).some((event) =>
        event.content.startsWith("USER: NEW"),
      ),
    );
    const checkpoint = await storage.getCaptureCheckpoint({
      extractor: "claude_code",
      resource: path,
    });
    expect(
      (checkpoint?.state["jsonl_source"] as Record<string, unknown>)[
        "generation"
      ],
    ).toBe(1);
  });

  it("retains a write-ahead page proof across the append-to-checkpoint crash window", async () => {
    const path = join(projDir, "inflight-page-proof.jsonl");
    const crashing = new AppendThenFailStorage("ASSISTANT: answer two");
    storage = crashing;
    const oldLines = [
      userText("s1", "u1", "question one"),
      assistantEndTurn("s1", "a1", "answer one"),
      userText("s1", "u2", "OLD second"),
      assistantEndTurn("s1", "a2", "answer two"),
    ];
    writeJsonlFresh(path, oldLines);
    const oldSize = readFileSync(path).length;
    handle = await startClaudeCodeExtractor(storage, { projectsPrefix });
    await waitFor(async () => (await storage.count()) === 2);
    await waitFor(() => captured.writes.join("").includes("handler_error"));
    await handle.stop();
    handle = null;

    const checkpointBefore = await storage.getCaptureCheckpoint({
      extractor: "claude_code",
      resource: path,
    });
    expect(checkpointBefore?.state["jsonl_inflight_source"]).toBeDefined();

    crashing.allowCheckpoints();
    writeJsonlFresh(path, [
      userText("s1", "u1", "question one"),
      assistantEndTurn("s1", "a1", "answer one"),
      userText("s1", "u2", "NEW second"),
      assistantEndTurn("s1", "a2", "answer two"),
      userText("s1", "u3", "growth after rewritten page"),
    ]);
    expect(readFileSync(path).length).toBeGreaterThan(oldSize);

    handle = await startClaudeCodeExtractor(storage, { projectsPrefix });
    await waitFor(async () => {
      const hasNew = (await storage.query({ order: "asc" })).some((event) =>
        event.content.startsWith("USER: NEW second"),
      );
      const checkpoint = await storage.getCaptureCheckpoint({
        extractor: "claude_code",
        resource: path,
      });
      return hasNew && checkpoint?.state["jsonl_inflight_source"] === undefined;
    });
    const checkpointAfter = await storage.getCaptureCheckpoint({
      extractor: "claude_code",
      resource: path,
    });
    expect(checkpointAfter?.state["jsonl_inflight_source"]).toBeUndefined();
    expect(
      (checkpointAfter?.state["jsonl_source"] as Record<string, unknown>)[
        "generation"
      ],
    ).toBe(1);
    const eventsAfter = await storage.query({ order: "asc" });
    expect(
      eventsAfter.filter(
        (event) =>
          event.content === "USER: question one\n\nASSISTANT: answer one",
      ),
    ).toHaveLength(1);
  });

  it("reconciles a stale inflight proof when the unread suffix shrinks exactly to the durable offset", async () => {
    const path = join(projDir, "inflight-equal-size.jsonl");
    const crashing = new AppendThenFailStorage("ASSISTANT: answer two");
    storage = crashing;
    writeJsonlFresh(path, [
      userText("s1", "u1", "question one"),
      assistantEndTurn("s1", "a1", "answer one"),
      userText("s1", "u2", "question two"),
      assistantEndTurn("s1", "a2", "answer two"),
    ]);
    handle = await startClaudeCodeExtractor(storage, { projectsPrefix });
    await waitFor(async () => (await storage.count()) === 2);
    await waitFor(() => captured.writes.join("").includes("handler_error"));
    await handle.stop();
    handle = null;

    const before = await storage.getCaptureCheckpoint({
      extractor: "claude_code",
      resource: path,
    });
    expect(before?.state["jsonl_inflight_source"]).toBeDefined();
    const durableOffset = before!.position!;
    writeFileSync(path, readFileSync(path).subarray(0, durableOffset));
    expect(readFileSync(path).length).toBe(durableOffset);

    crashing.allowCheckpoints();
    handle = await startClaudeCodeExtractor(storage, { projectsPrefix });
    await waitFor(async () => {
      const checkpoint = await storage.getCaptureCheckpoint({
        extractor: "claude_code",
        resource: path,
      });
      return checkpoint?.state["jsonl_inflight_source"] === undefined;
    });

    const after = await storage.getCaptureCheckpoint({
      extractor: "claude_code",
      resource: path,
    });
    expect(after?.position).toBe(durableOffset);
    expect(
      (after?.state["jsonl_source"] as Record<string, unknown>)["generation"],
    ).toBe(1);
  });

  it("populates metadata.repo_root from the cwd field on JSONL lines", async () => {
    handle = await startClaudeCodeExtractor(storage, { projectsPrefix });
    const path = join(projDir, "sess.jsonl");

    writeJsonlFresh(path, [
      userText("s1", "u1", "Q1"),
      assistantText("s1", "a1", "A1"),
      userText("s1", "u2", "Q2"),
    ]);
    await waitFor(async () => (await storage.count()) >= 1);

    const evt = (await storage.query({ order: "asc" }))[0]!;
    expect((evt.metadata as Record<string, unknown>)["repo_root"]).toBe(
      "/Users/x/proj",
    );
  });

  it("extracts file_path / path / notebook_path inputs from tool_use blocks into metadata.files_referenced", async () => {
    handle = await startClaudeCodeExtractor(storage, { projectsPrefix });
    const path = join(projDir, "sess.jsonl");

    const assistantWithToolUses: JsonlLine = {
      type: "assistant",
      sessionId: "s1",
      cwd: "/Users/x/proj",
      uuid: "a1",
      timestamp: "2026-04-30T10:00:00Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Reading and editing." },
          {
            type: "tool_use",
            id: "t1",
            name: "Read",
            input: { file_path: "/proj/a.ts" },
          },
          {
            type: "tool_use",
            id: "t2",
            name: "Edit",
            input: { file_path: "/proj/b.ts" },
          },
          {
            type: "tool_use",
            id: "t3",
            name: "Read",
            input: { file_path: "/proj/a.ts" },
          },
          {
            type: "tool_use",
            id: "t4",
            name: "Bash",
            input: { command: "ls" },
          },
          {
            type: "tool_use",
            id: "t5",
            name: "Glob",
            input: { path: "/proj/lib" },
          },
          { type: "text", text: "Done." },
        ],
      },
    };

    writeJsonlFresh(path, [
      userText("s1", "u1", "Q1"),
      assistantWithToolUses,
      userText("s1", "u2", "Q2"),
    ]);
    await waitFor(async () => (await storage.count()) >= 1);

    const evt = (await storage.query({ order: "asc" }))[0]!;
    expect(
      (evt.metadata as Record<string, unknown>)["files_referenced"],
    ).toEqual(["/proj/a.ts", "/proj/b.ts", "/proj/lib"]);
  });

  it("omits metadata.files_referenced when assistant has no tool_use file inputs", async () => {
    handle = await startClaudeCodeExtractor(storage, { projectsPrefix });
    const path = join(projDir, "sess.jsonl");

    writeJsonlFresh(path, [
      userText("s1", "u1", "Q1"),
      assistantText("s1", "a1", "A1"),
      userText("s1", "u2", "Q2"),
    ]);
    await waitFor(async () => (await storage.count()) >= 1);

    const evt = (await storage.query({ order: "asc" }))[0]!;
    expect(evt.metadata as Record<string, unknown>).not.toHaveProperty(
      "files_referenced",
    );
  });

  it("end-to-end: chronological appends produce ordered, non-duplicate events", async () => {
    handle = await startClaudeCodeExtractor(storage, { projectsPrefix });
    const path = join(projDir, "sess.jsonl");

    // Cluster pairing: each round needs the *next* user line to close the
    // current cluster. Each appended user closes the prior pending cluster.
    writeJsonlFresh(path, [
      userText("s1", "u1", "Q1"),
      assistantText("s1", "a1", "A1"),
      userText("s1", "u2", "Q2"),
    ]);
    await waitFor(async () => (await storage.count()) >= 1);

    appendJsonl(path, [
      assistantText("s1", "a2", "A2"),
      userText("s1", "u3", "Q3"),
    ]);
    await waitFor(async () => (await storage.count()) >= 2);

    appendJsonl(path, [
      assistantText("s1", "a3", "A3"),
      userText("s1", "u4", "Q4"),
    ]);
    await waitFor(async () =>
      (await storage.query({ order: "asc" })).some(
        (event) =>
          (event.metadata as Record<string, unknown>)["turn_index"] === 2,
      ),
    );

    const events = await storage.query({ order: "asc" });
    expect(events).toHaveLength(3);
    // Item 025: deterministic id-ASC tie-break on same-ms timestamps means we
    // can no longer assume events[i] follows turn_index. Index by turn_index.
    const byTurn = new Map(
      events.map((e) => [
        (e.metadata as Record<string, unknown>)["turn_index"] as number,
        e,
      ]),
    );
    expect(byTurn.get(0)?.content).toBe("USER: Q1\n\nASSISTANT: A1");
    expect(byTurn.get(1)?.content).toBe("USER: Q2\n\nASSISTANT: A2");
    expect(byTurn.get(2)?.content).toBe("USER: Q3\n\nASSISTANT: A3");
  });

  it("resumes from a durable checkpoint without replaying storage history", async () => {
    const path = join(projDir, "sess.jsonl");
    writeJsonlFresh(path, [
      userText("s1", "u1", "Q1"),
      assistantText("s1", "a1", "A1"),
    ]);
    const fileSize = readFileSync(path).length;

    // Pre-populate storage as if a prior daemon run had emitted this turn.
    await storage.append({
      source: `fs:${path}`,
      timestamp: "2026-04-30T00:00:00Z",
      content: "USER: Q1\n\nASSISTANT: A1",
      metadata: {
        project: "my-proj",
        session_id: "sess",
        turn_index: 0,
        byte_offset: fileSize,
      },
    });
    await storage.upsertCaptureCheckpoint({
      extractor: "claude_code",
      resource: path,
      position: fileSize,
      ordinal: 0,
      updated_at: "2026-04-30T00:00:01.000Z",
    });

    handle = await startClaudeCodeExtractor(storage, { projectsPrefix });
    appendJsonl(path, [
      userText("s1", "u2", "Q2"),
      assistantText("s1", "a2", "A2"),
      userText("s1", "u3", "Q3"), // closes the second cluster
    ]);
    await waitFor(async () => (await storage.count()) >= 2);

    const events = await storage.query({ order: "asc" });
    expect(events).toHaveLength(2);
    const fresh = events.find((e) => e.content.includes("Q2"))!;
    expect(fresh.content).toBe("USER: Q2\n\nASSISTANT: A2");
    expect((fresh.metadata as Record<string, unknown>)["turn_index"]).toBe(1);
  });

  it("processes pre-existing JSONL files at boot (catches subagent files written before daemon start)", async () => {
    // Create a subagent JSONL BEFORE the extractor starts. Subagent JSONLs
    // are short-lived: written-then-closed by a transient run, so they often
    // see zero `change` events after their initial write. With the
    // ignoreInitial:true watcher and offset-map backfill that only knows
    // about files already in storage, these files get silently skipped
    // forever on daemon boot — empirically observed in echo.db (0 parsed
    // turns from 69 distinct subagent files).
    const subagentsDir = join(projDir, "session-abc", "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    const subagentPath = join(subagentsDir, "agent-xyz.jsonl");
    // Subagent JSONL with a closing user line — the cluster-pairing pattern
    // requires the next user to close a pending cluster. Real subagent files
    // ending on a final assistant text are a known followup gap.
    writeJsonlFresh(subagentPath, [
      userText("subagent-xyz", "u1", "Q1"),
      assistantText("subagent-xyz", "a1", "A1"),
      userText("subagent-xyz", "u2", "Q2"),
    ]);

    // Start the extractor AFTER the file already exists.
    handle = await startClaudeCodeExtractor(storage, { projectsPrefix });

    // Don't write any further changes — the file is frozen, like a finished
    // subagent run.
    await waitFor(async () => (await storage.count()) >= 1);

    const events = await storage.query({ order: "asc" });
    expect(events).toHaveLength(1);
    expect(events[0]!.source).toBe(`fs:${subagentPath}`);
    expect(events[0]!.content).toBe("USER: Q1\n\nASSISTANT: A1");
  });

  it("captures turns from subagent JSONLs created mid-session in a nested subdir", async () => {
    handle = await startClaudeCodeExtractor(storage, { projectsPrefix });

    // Subagent layout per real Claude Code:
    //   <project>/<session-id>/subagents/agent-<id>.jsonl
    // The session dir + subagents dir are both created mid-session, AFTER the
    // watcher started. This tests that chokidar's recursive watch picks up
    // new subdirectories created after watcher start.
    const sessionDir = join(projDir, "session-abc");
    const subagentsDir = join(sessionDir, "subagents");
    mkdirSync(subagentsDir, { recursive: true });

    // No grace period — write the file immediately after creating the dir,
    // matching how Claude Code spawns a subagent and writes its first
    // message in the same tick.
    const path = join(subagentsDir, "agent-xyz.jsonl");
    writeJsonlFresh(path, [
      userText("subagent-xyz", "u1", "Q1"),
      assistantText("subagent-xyz", "a1", "A1"),
      userText("subagent-xyz", "u2", "Q2"),
    ]);

    await waitFor(async () => (await storage.count()) >= 1);

    const events = await storage.query({ order: "asc" });
    expect(events).toHaveLength(1);
    expect(events[0]!.source).toBe(`fs:${path}`);
    expect(events[0]!.content).toBe("USER: Q1\n\nASSISTANT: A1");
  });

  it("emits stale git_state (fresh:false, branch only) when probe refuses but JSONL gitBranch is present", async () => {
    handle = await startClaudeCodeExtractor(storage, { projectsPrefix });
    const path = join(projDir, "sess.jsonl");
    // Old timestamp → probeGitState's 30s freshness gate refuses.
    // cwd at non-existent path → readBranch can't help either.
    const ts = "2024-01-01T00:00:00Z";
    const u1 = {
      type: "user",
      sessionId: "s1",
      cwd: "/no/such/dir",
      gitBranch: "feature/y",
      message: { role: "user", content: "q" },
      uuid: "u1",
      timestamp: ts,
    };
    const a1 = {
      type: "assistant",
      sessionId: "s1",
      cwd: "/no/such/dir",
      gitBranch: "feature/y",
      message: { role: "assistant", content: [{ type: "text", text: "a" }] },
      uuid: "a1",
      timestamp: ts,
    };
    const u2 = {
      type: "user",
      sessionId: "s1",
      cwd: "/no/such/dir",
      gitBranch: "feature/y",
      message: { role: "user", content: "next" },
      uuid: "u2",
      timestamp: ts,
    };
    writeFileSync(
      path,
      [u1, a1, u2].map((l) => JSON.stringify(l)).join("\n") + "\n",
    );
    await waitFor(async () => (await storage.count()) >= 1);

    const evt = (await storage.query({ order: "asc" }))[0]!;
    const md = evt.metadata as Record<string, unknown>;
    const gs = md["git_state"] as Record<string, unknown>;
    expect(gs).toBeDefined();
    expect(gs["fresh"]).toBe(false);
    expect(gs["branch"]).toBe("feature/y");
    expect(gs["head_sha"]).toBeUndefined();
    expect(gs["dirty_count"]).toBeUndefined();
  });

  it("threads JSONL gitBranch / permissionMode / cli version / model into metadata", async () => {
    handle = await startClaudeCodeExtractor(storage, { projectsPrefix });
    const path = join(projDir, "sess.jsonl");
    const ts = "2026-04-30T10:00:00Z";
    // cwd is intentionally a non-existent path so readBranch can't resolve a
    // real branch — proving metadata.branch comes from the JSONL gitBranch.
    const u1 = {
      type: "user",
      sessionId: "s1",
      cwd: "/no/such/dir",
      gitBranch: "feature/x",
      permissionMode: "auto",
      version: "2.1.119",
      message: { role: "user", content: "q" },
      uuid: "u1",
      timestamp: ts,
    };
    const a1 = {
      type: "assistant",
      sessionId: "s1",
      cwd: "/no/such/dir",
      gitBranch: "feature/x",
      version: "2.1.119",
      message: {
        role: "assistant",
        model: "claude-opus-4-7",
        content: [{ type: "text", text: "a" }],
      },
      uuid: "a1",
      timestamp: ts,
    };
    const u2 = {
      type: "user",
      sessionId: "s1",
      cwd: "/no/such/dir",
      gitBranch: "feature/x",
      message: { role: "user", content: "next" },
      uuid: "u2",
      timestamp: ts,
    };
    writeFileSync(
      path,
      [u1, a1, u2].map((l) => JSON.stringify(l)).join("\n") + "\n",
    );
    await waitFor(async () => (await storage.count()) >= 1);

    const evt = (await storage.query({ order: "asc" }))[0]!;
    const md = evt.metadata as Record<string, unknown>;
    expect(md["branch"]).toBe("feature/x");
    expect(md["permission_mode"]).toBe("auto");
    expect(md["cli_version"]).toBe("2.1.119");
    expect(md["model"]).toBe("claude-opus-4-7");
  });

  it("does not re-append already-stored turns when a mid-batch append throws (per-turn offset checkpoint)", async () => {
    // Bug A: turns are appended one-by-one but the offset map was only
    // persisted after the loop. A throw on turn 2 left the offset at the
    // pre-batch position, so the next change event re-appended turn 1.
    const flaky = new MidBatchFailingStorage("ASSISTANT: A2");
    handle = await startClaudeCodeExtractor(flaky, { projectsPrefix });
    const path = join(projDir, "sess.jsonl");

    // Two closed clusters in one batch: turn 1 = Q1/A1 (closed by u2),
    // turn 2 = Q2/A2 (closed by u3). The append for turn 2 throws once.
    writeJsonlFresh(path, [
      userText("s1", "u1", "Q1"),
      assistantText("s1", "a1", "A1"),
      userText("s1", "u2", "Q2"),
      assistantText("s1", "a2", "A2"),
      userText("s1", "u3", "Q3"),
    ]);

    // Turn 1 lands; turn 2 throws mid-batch and surfaces as handler_error.
    await waitFor(async () => (await flaky.count()) >= 1);
    await waitFor(() => captured.writes.join("").includes("handler_error"));

    // A later append triggers the next handler run; appends now succeed.
    appendJsonl(path, [
      assistantText("s1", "a3", "A3"),
      userText("s1", "u4", "Q4"),
    ]);
    await waitFor(async () => (await flaky.count()) >= 3);

    const events = await flaky.query({ order: "asc" });
    expect(
      events.filter((e) => e.content === "USER: Q1\n\nASSISTANT: A1"),
    ).toHaveLength(1);
    expect(events.some((e) => e.content === "USER: Q2\n\nASSISTANT: A2")).toBe(
      true,
    );
    expect(events.some((e) => e.content === "USER: Q3\n\nASSISTANT: A3")).toBe(
      true,
    );
  });

  it("stop() resolves cleanly and prevents further events", async () => {
    handle = await startClaudeCodeExtractor(storage, { projectsPrefix });
    const path = join(projDir, "sess.jsonl");

    writeJsonlFresh(path, [
      userText("s1", "u1", "Q1"),
      assistantText("s1", "a1", "A1"),
      userText("s1", "u2", "Q2"),
    ]);
    await waitFor(async () => (await storage.count()) >= 1);
    const before = await storage.count();

    await handle.stop();
    handle = null;

    appendJsonl(path, [
      assistantText("s1", "a2", "A2"),
      userText("s1", "u3", "Q3"),
    ]);
    await new Promise((r) => setTimeout(r, 300));
    expect(await storage.count()).toBe(before);
  });
});
