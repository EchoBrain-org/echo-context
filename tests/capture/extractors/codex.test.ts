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
import { occurredAtFromUuidV7 } from "../../../src/capture/logical-identity.js";
import { normalizeEvent } from "../../../src/context-adapters/normalization.js";
import {
  extractCodexTurns,
  startCodexExtractor,
  type CodexExtractorHandle,
} from "../../../src/capture/extractors/codex.js";
import {
  JSONL_RAW_FRAGMENT_CONTENT_PREFIX,
  JsonlSourceChangedError,
  MAX_JSONL_READ_BYTES,
} from "../../../src/capture/extractors/_shared.js";
import { projectLogicalTurns } from "../../../src/normalize/logical-turns.js";
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
  writeJsonl,
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

/** Rewrites the source after its parsed-page proof has passed but before the
 * candidate append completes. Keeping the rewrite inside append makes the
 * otherwise tiny validation/storage TOCTOU window deterministic. */
class SameInodeRewriteDuringAppendStorage extends MemoryStorage {
  private rewritten = false;

  constructor(
    private readonly sourcePath: string,
    private readonly replacement: CodexLine[],
  ) {
    super();
  }

  override async append(
    event: Omit<CaptureEvent, "id">,
    options?: Parameters<MemoryStorage["append"]>[1],
  ): Promise<EventId> {
    if (!this.rewritten) {
      this.rewritten = true;
      writeJsonl(this.sourcePath, this.replacement);
    }
    return super.append(event, options);
  }
}

/** Combines a rewrite with an ordinary storage failure on turn two. The
 * extractor must prefer the source-change signal, rewind the whole parsed
 * page, and retry under a new generation. */
class SameInodeRewriteAndFailStorage extends MemoryStorage {
  private appendCount = 0;

  constructor(
    private readonly sourcePath: string,
    private readonly replacement: CodexLine[],
  ) {
    super();
  }

  override async append(
    event: Omit<CaptureEvent, "id">,
    options?: Parameters<MemoryStorage["append"]>[1],
  ): Promise<EventId> {
    this.appendCount += 1;
    if (this.appendCount === 2) {
      writeJsonl(this.sourcePath, this.replacement);
      throw new Error("synthetic append failure after source rewrite");
    }
    return super.append(event, options);
  }
}

/** Persists a candidate and then throws before its per-turn checkpoint. This
 * models a process dying in the append-to-checkpoint crash window. */
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
    private readonly appended: CodexLine[],
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
    private readonly replacement: CodexLine[],
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
      writeJsonl(this.sourcePath, this.replacement);
    }
    return checkpoint;
  }
}

// ─── JSONL line builders matching Codex's wire format ───────────────────────

interface CodexLine {
  timestamp: string;
  type: string;
  payload: Record<string, unknown>;
}

function sessionMeta(
  opts: {
    id?: string;
    cwd?: string;
    ts?: string;
    source?: string;
    cli_version?: string;
    model_provider?: string;
    session_id?: string;
    forked_from_id?: string;
    parent_thread_id?: string;
    thread_source?: string;
    agent_path?: string;
    history_mode?: string;
    agent_depth?: number;
    git?: { commit_hash?: string; branch?: string; repository_url?: string };
  } = {},
): CodexLine {
  const payload: Record<string, unknown> = {
    id: opts.id ?? "019de2b0-6551-7682-a51b-2affaa0a7bbf",
    cwd: opts.cwd ?? "/Users/x/proj",
  };
  if (opts.source !== undefined) payload["source"] = opts.source;
  if (opts.cli_version !== undefined) payload["cli_version"] = opts.cli_version;
  if (opts.model_provider !== undefined)
    payload["model_provider"] = opts.model_provider;
  if (opts.session_id !== undefined) payload["session_id"] = opts.session_id;
  if (opts.forked_from_id !== undefined)
    payload["forked_from_id"] = opts.forked_from_id;
  if (opts.parent_thread_id !== undefined)
    payload["parent_thread_id"] = opts.parent_thread_id;
  if (opts.thread_source !== undefined)
    payload["thread_source"] = opts.thread_source;
  if (opts.agent_path !== undefined) payload["agent_path"] = opts.agent_path;
  if (opts.history_mode !== undefined)
    payload["history_mode"] = opts.history_mode;
  if (opts.agent_depth !== undefined) {
    payload["source"] = {
      subagent: {
        thread_spawn: {
          parent_thread_id: opts.parent_thread_id,
          depth: opts.agent_depth,
          agent_path: opts.agent_path,
          agent_nickname: "TestAgent",
        },
      },
    };
  }
  if (opts.git !== undefined) payload["git"] = opts.git;
  return {
    timestamp: opts.ts ?? "2026-05-01T10:00:00.000Z",
    type: "session_meta",
    payload,
  };
}

function turnContext(
  opts: {
    turn_id?: unknown;
    cwd?: string;
    model?: string;
    effort?: string;
    personality?: string;
    approval_policy?: string;
    sandbox_policy_type?: string;
    sandbox_network_access?: boolean;
    sandbox_writable_roots?: string[];
    sandbox_exclude_tmpdir_env_var?: boolean;
    sandbox_exclude_slash_tmp?: boolean;
    permission_profile_type?: string;
    permission_file_system_type?: string;
    permission_network?: string;
    file_system_sandbox_kind?: string;
  } = {},
): CodexLine {
  const payload: Record<string, unknown> = {};
  if (opts.turn_id !== undefined) payload["turn_id"] = opts.turn_id;
  if (opts.cwd !== undefined) payload["cwd"] = opts.cwd;
  if (opts.model !== undefined) payload["model"] = opts.model;
  if (opts.effort !== undefined) payload["effort"] = opts.effort;
  if (opts.personality !== undefined) payload["personality"] = opts.personality;
  if (opts.approval_policy !== undefined)
    payload["approval_policy"] = opts.approval_policy;
  if (opts.sandbox_policy_type !== undefined) {
    const sandboxPolicy: Record<string, unknown> = {
      type: opts.sandbox_policy_type,
    };
    if (opts.sandbox_network_access !== undefined) {
      sandboxPolicy["network_access"] = opts.sandbox_network_access;
    }
    if (opts.sandbox_writable_roots !== undefined) {
      sandboxPolicy["writable_roots"] = opts.sandbox_writable_roots;
    }
    if (opts.sandbox_exclude_tmpdir_env_var !== undefined) {
      sandboxPolicy["exclude_tmpdir_env_var"] =
        opts.sandbox_exclude_tmpdir_env_var;
    }
    if (opts.sandbox_exclude_slash_tmp !== undefined) {
      sandboxPolicy["exclude_slash_tmp"] = opts.sandbox_exclude_slash_tmp;
    }
    payload["sandbox_policy"] = sandboxPolicy;
  }
  if (
    opts.permission_profile_type !== undefined ||
    opts.permission_file_system_type !== undefined ||
    opts.permission_network !== undefined
  ) {
    const permissionProfile: Record<string, unknown> = {};
    if (opts.permission_profile_type !== undefined) {
      permissionProfile["type"] = opts.permission_profile_type;
    }
    if (opts.permission_file_system_type !== undefined) {
      permissionProfile["file_system"] = {
        type: opts.permission_file_system_type,
      };
    }
    if (opts.permission_network !== undefined) {
      permissionProfile["network"] = opts.permission_network;
    }
    payload["permission_profile"] = permissionProfile;
  }
  if (opts.file_system_sandbox_kind !== undefined) {
    payload["file_system_sandbox_policy"] = {
      kind: opts.file_system_sandbox_kind,
    };
  }
  return {
    timestamp: "2026-05-01T10:00:00.500Z",
    type: "turn_context",
    payload,
  };
}

function userMsg(
  text: string,
  ts = "2026-05-01T10:00:01.000Z",
  turnId?: string,
): CodexLine {
  return {
    timestamp: ts,
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
      ...(turnId !== undefined
        ? { internal_chat_message_metadata_passthrough: { turn_id: turnId } }
        : {}),
    },
  };
}

function assistantMsg(
  text: string,
  ts = "2026-05-01T10:00:02.000Z",
  turnId?: string,
): CodexLine {
  return {
    timestamp: ts,
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
      ...(turnId !== undefined
        ? { internal_chat_message_metadata_passthrough: { turn_id: turnId } }
        : {}),
    },
  };
}

function developerMsg(text: string): CodexLine {
  return {
    timestamp: "2026-05-01T10:00:00.001Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text }],
    },
  };
}

function functionCall(
  name = "shell",
  argsStr = "{}",
  call_id = "call_001",
): CodexLine {
  return {
    timestamp: "2026-05-01T10:00:01.500Z",
    type: "response_item",
    payload: { type: "function_call", name, arguments: argsStr, call_id },
  };
}

function functionCallOutput(call_id = "call_001", output = "ok"): CodexLine {
  return {
    timestamp: "2026-05-01T10:00:01.600Z",
    type: "response_item",
    payload: { type: "function_call_output", call_id, output },
  };
}

function reasoning(text?: string): CodexLine {
  return {
    timestamp: "2026-05-01T10:00:01.700Z",
    type: "response_item",
    payload: {
      type: "reasoning",
      summary: text === undefined ? [] : [{ type: "summary_text", text }],
    },
  };
}

function eventMsg(
  payload: Record<string, unknown> = { kind: "token_count", total: 100 },
  ts = "2026-05-01T10:00:00.500Z",
): CodexLine {
  return { timestamp: ts, type: "event_msg", payload };
}

function taskComplete(ts = "2026-05-01T10:00:03.000Z"): CodexLine {
  return eventMsg(
    {
      type: "task_complete",
      turn_id: "019de2b0-6551-7682-a51b-2affaa0a7bbf",
      last_agent_message: "done",
    },
    ts,
  );
}

function interAgentTrigger(ts: string, trigger = true): CodexLine {
  return {
    timestamp: ts,
    type: "inter_agent_communication_metadata",
    payload: { trigger_turn: trigger },
  };
}

function agentMessage(
  text: string,
  recipient: string,
  turnId: string,
  ts: string,
): CodexLine {
  return {
    timestamp: ts,
    type: "response_item",
    payload: {
      type: "agent_message",
      author: "/root",
      recipient,
      content: [{ type: "input_text", text }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    },
  };
}

// ─── Pure parser tests ──────────────────────────────────────────────────────

describe("extractCodexTurns (pure)", () => {
  let dir: string;
  let path: string;
  let captured: ReturnType<typeof captureStdout>;

  beforeEach(() => {
    dir = tmpDir("echo-codex-");
    path = join(
      dir,
      "rollout-2026-05-01T10-00-00-019de2b0-6551-7682-a51b-2affaa0a7bbf.jsonl",
    );
    captured = captureStdout();
  });

  afterEach(() => {
    captured.restore();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns no turns and unchanged offset for an empty file", async () => {
    writeJsonl(path, []);
    const r = await extractCodexTurns(path, 0);
    expect(r.turns).toHaveLength(0);
    expect(r.newOffset).toBe(0);
  });

  it("returns no turns when only session_meta is present (no message yet)", async () => {
    writeJsonl(path, [sessionMeta()]);
    const r = await extractCodexTurns(path, 0);
    expect(r.turns).toHaveLength(0);
  });

  it("does not emit a turn for a trailing user with no assistant", async () => {
    const meta = sessionMeta();
    writeJsonl(path, [meta, userMsg("hi")]);
    const r = await extractCodexTurns(path, 0);
    expect(r.turns).toHaveLength(0);
    // Metadata is durable, while the pending user remains unread for restart.
    expect(r.newOffset).toBe(Buffer.byteLength(`${JSON.stringify(meta)}\n`));
  });

  it("does not emit even after assistant arrives — cluster only closes on next user", async () => {
    const meta = sessionMeta();
    writeJsonl(path, [meta, userMsg("hi"), assistantMsg("hello")]);
    const r = await extractCodexTurns(path, 0);
    expect(r.turns).toHaveLength(0);
    expect(r.newOffset).toBe(Buffer.byteLength(`${JSON.stringify(meta)}\n`));
  });

  it("stops at a bounded page when one logical cluster exceeds the budget", async () => {
    const huge = "x".repeat(1_500_000);
    writeJsonl(path, [
      sessionMeta(),
      userMsg("oversized question"),
      assistantMsg(huge),
      assistantMsg(huge),
      assistantMsg(huge),
      taskComplete(),
      userMsg("bounded question"),
      assistantMsg("bounded answer"),
      taskComplete(),
    ]);

    const prefix = await extractCodexTurns(path, 0);
    const result = await extractCodexTurns(path, prefix.newOffset);

    expect(result.turns).toEqual([]);
    expect(result.newOffset).toBe(prefix.newOffset);
    expect(result.firstUserOffset).toBe(prefix.newOffset);
    expect(
      result.readSnapshot!.through_offset - result.readSnapshot!.first_offset,
    ).toBeLessThanOrEqual(MAX_JSONL_READ_BYTES);
  });

  it("emits the first cluster as a turn once a SECOND user arrives", async () => {
    writeJsonl(path, [
      sessionMeta(),
      userMsg("q1", "2026-05-01T10:00:01Z"),
      assistantMsg("a1", "2026-05-01T10:00:02Z"),
      userMsg("q2"), // closes the first cluster
    ]);
    const r = await extractCodexTurns(path, 0);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]).toMatchObject({
      user_message: "q1",
      assistant_message: "a1",
      timestamp: "2026-05-01T10:00:02Z",
      cwd: "/Users/x/proj",
      had_tool_use: false,
    });
    // Offset advanced past the first assistant line. Exact value is asserted in
    // the dedicated byte-offset progression test below.
    expect(r.newOffset).toBeGreaterThan(0);
  });

  it("clusters multiple consecutive assistant messages into one turn", async () => {
    writeJsonl(path, [
      sessionMeta(),
      userMsg("build it"),
      assistantMsg("thinking…"),
      assistantMsg("I see the issue"),
      assistantMsg("here is the fix"),
      userMsg("thanks"), // closes the cluster
    ]);
    const r = await extractCodexTurns(path, 0);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]?.user_message).toBe("build it");
    expect(r.turns[0]?.assistant_message).toBe(
      "thinking…\n\nI see the issue\n\nhere is the fix",
    );
  });

  it("marks had_tool_use when function_call appears between user and next user", async () => {
    writeJsonl(path, [
      sessionMeta(),
      userMsg("run something"),
      functionCall(),
      assistantMsg("done"),
      userMsg("next"),
    ]);
    const r = await extractCodexTurns(path, 0);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]?.had_tool_use).toBe(true);
  });

  it("skips reasoning and event_msg lines without affecting pairing", async () => {
    writeJsonl(path, [
      sessionMeta(),
      eventMsg(),
      userMsg("q"),
      reasoning(),
      assistantMsg("a"),
      eventMsg(),
      userMsg("next"),
    ]);
    const r = await extractCodexTurns(path, 0);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]?.user_message).toBe("q");
    expect(r.turns[0]?.assistant_message).toBe("a");
    expect(r.turns[0]?.had_tool_use).toBe(false);
  });

  it("ignores developer-role messages (treated as system noise)", async () => {
    writeJsonl(path, [
      sessionMeta(),
      developerMsg("AGENTS.md instructions…"),
      userMsg("actual q"),
      assistantMsg("actual a"),
      userMsg("next"),
    ]);
    const r = await extractCodexTurns(path, 0);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]?.user_message).toBe("actual q");
  });

  it("emits two turns from a session with two complete clusters", async () => {
    writeJsonl(path, [
      sessionMeta(),
      userMsg("q1"),
      assistantMsg("a1a"),
      assistantMsg("a1b"),
      userMsg("q2"),
      assistantMsg("a2"),
      userMsg("q3"), // closes cluster 2
    ]);
    const r = await extractCodexTurns(path, 0);
    expect(r.turns).toHaveLength(2);
    expect(r.turns[0]?.assistant_message).toBe("a1a\n\na1b");
    expect(r.turns[1]?.user_message).toBe("q2");
    expect(r.turns[1]?.assistant_message).toBe("a2");
  });

  it("skips malformed JSON lines and continues parsing", async () => {
    const valid = JSON.stringify(sessionMeta());
    const u = JSON.stringify(userMsg("q"));
    const a = JSON.stringify(assistantMsg("a"));
    const next = JSON.stringify(userMsg("next"));
    writeFileSync(path, [valid, "{not json", u, a, next, ""].join("\n"));
    const r = await extractCodexTurns(path, 0);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]?.user_message).toBe("q");
  });

  it("preserves cwd across incremental passes when session_meta is past lastByteOffset", async () => {
    writeJsonl(path, [
      sessionMeta({ cwd: "/Users/x/proj" }),
      userMsg("q1"),
      assistantMsg("a1"),
      userMsg("q2"),
    ]);
    const pass1 = await extractCodexTurns(path, 0);
    expect(pass1.turns).toHaveLength(1);
    expect(pass1.turns[0]?.cwd).toBe("/Users/x/proj");
    expect(pass1.cwd).toBe("/Users/x/proj");

    appendJsonl(path, [assistantMsg("a2"), userMsg("q3")]);
    const pass2 = await extractCodexTurns(path, pass1.newOffset, {
      lastKnownCwd: pass1.cwd,
    });
    expect(pass2.turns).toHaveLength(1);
    expect(pass2.turns[0]?.user_message).toBe("q2");
    expect(pass2.turns[0]?.cwd).toBe("/Users/x/proj");
  });

  it("omitting lastKnownCwd causes cwd to be dropped on later passes (regression guard)", async () => {
    writeJsonl(path, [
      sessionMeta(),
      userMsg("q1"),
      assistantMsg("a1"),
      userMsg("q2"),
    ]);
    const pass1 = await extractCodexTurns(path, 0);
    appendJsonl(path, [assistantMsg("a2"), userMsg("q3")]);
    const pass2 = await extractCodexTurns(path, pass1.newOffset);
    expect(pass2.turns).toHaveLength(1);
    expect(pass2.turns[0]?.cwd).toBeUndefined();
  });

  it("byte-offset progression: a second pass starting at returned offset emits the next cluster", async () => {
    writeJsonl(path, [
      sessionMeta(),
      userMsg("q1"),
      assistantMsg("a1"),
      userMsg("q2"), // closes cluster 1
    ]);
    const pass1 = await extractCodexTurns(path, 0);
    expect(pass1.turns).toHaveLength(1);
    const offsetAfterPass1 = pass1.newOffset;

    appendJsonl(path, [
      assistantMsg("a2a"),
      assistantMsg("a2b"),
      userMsg("q3"), // closes cluster 2
    ]);
    const pass2 = await extractCodexTurns(path, offsetAfterPass1);
    expect(pass2.turns).toHaveLength(1);
    expect(pass2.turns[0]?.user_message).toBe("q2");
    expect(pass2.turns[0]?.assistant_message).toBe("a2a\n\na2b");
  });

  it("counts blank-line bytes exactly across a checkpoint restart without replay or skip", async () => {
    const firstLines = [
      JSON.stringify(sessionMeta()),
      JSON.stringify(userMsg("q1")),
      "",
      "",
      JSON.stringify(assistantMsg("a1")),
      JSON.stringify(userMsg("q2")),
    ];
    const initial = `${firstLines.join("\n")}\n`;
    writeFileSync(path, initial);
    const expectedFirstOffset = Buffer.byteLength(
      `${firstLines.slice(0, 5).join("\n")}\n`,
    );

    const first = await extractCodexTurns(path, 0);
    expect(first.turns.map((turn) => turn.user_message)).toEqual(["q1"]);
    expect(first.newOffset).toBe(expectedFirstOffset);
    expect(first.turns[0]?.byte_offset).toBe(expectedFirstOffset);

    const assistant2 = JSON.stringify(assistantMsg("a2"));
    const closingUser = JSON.stringify(userMsg("q3"));
    const appended = `\n${assistant2}\n\n${closingUser}\n`;
    appendFileSync(path, appended);
    const expectedSecondOffset =
      Buffer.byteLength(initial) + Buffer.byteLength(`\n${assistant2}\n\n`);

    const second = await extractCodexTurns(path, first.newOffset);
    expect(second.turns.map((turn) => turn.user_message)).toEqual(["q2"]);
    expect(second.turns[0]?.assistant_message).toBe("a2");
    expect(second.newOffset).toBe(expectedSecondOffset);
  });

  it("returns empty when the JSONL file does not exist", async () => {
    const r = await extractCodexTurns(join(dir, "missing.jsonl"), 0);
    expect(r.turns).toHaveLength(0);
    expect(r.newOffset).toBe(0);
    expect(captured.writes.join("")).toContain("stat_failed");
  });

  it("extracts session_id from the rollout filename UUID", async () => {
    writeJsonl(path, [
      sessionMeta(),
      userMsg("q"),
      assistantMsg("a"),
      userMsg("next"),
    ]);
    const r = await extractCodexTurns(path, 0);
    expect(r.turns[0]?.session_id).toBe("019de2b0-6551-7682-a51b-2affaa0a7bbf");
  });

  // ─── Tier-1 metadata: session_meta + turn_context extras ──────────────────

  it("extracts git metadata from session_meta.payload.git", async () => {
    writeJsonl(path, [
      sessionMeta({
        git: {
          commit_hash: "3f178d784381cf45f56ad4bf044f6f0aed852f83",
          branch: "fix/extraction-quality-gaps",
          repository_url: "https://github.com/zhenye0616/Echo_Extension.git",
        },
      }),
      userMsg("q"),
      assistantMsg("a"),
      userMsg("next"),
    ]);
    const r = await extractCodexTurns(path, 0);
    expect(r.turns[0]?.git).toEqual({
      sha: "3f178d784381cf45f56ad4bf044f6f0aed852f83",
      branch: "fix/extraction-quality-gaps",
      origin_url: "https://github.com/zhenye0616/Echo_Extension.git",
    });
    expect(r.git).toEqual(r.turns[0]?.git);
  });

  it("extracts source / cli_version / model_provider from session_meta", async () => {
    writeJsonl(path, [
      sessionMeta({
        source: "vscode",
        cli_version: "0.128.0-alpha.1",
        model_provider: "openai",
      }),
      userMsg("q"),
      assistantMsg("a"),
      userMsg("next"),
    ]);
    const r = await extractCodexTurns(path, 0);
    expect(r.turns[0]?.codex).toMatchObject({
      source: "vscode",
      cli_version: "0.128.0-alpha.1",
      model_provider: "openai",
    });
  });

  it("extracts model / reasoning_effort / personality / sandbox / approval from turn_context", async () => {
    writeJsonl(path, [
      sessionMeta(),
      turnContext({
        model: "gpt-5.5",
        effort: "xhigh",
        personality: "pragmatic",
        approval_policy: "on-request",
        sandbox_policy_type: "workspace-write",
        sandbox_network_access: false,
        sandbox_writable_roots: ["/Users/x/proj", "/Users/x/proj"],
        sandbox_exclude_tmpdir_env_var: false,
        sandbox_exclude_slash_tmp: false,
        permission_profile_type: "managed",
        permission_file_system_type: "restricted",
        permission_network: "restricted",
        file_system_sandbox_kind: "restricted",
      }),
      userMsg("q"),
      assistantMsg("a"),
      userMsg("next"),
    ]);
    const r = await extractCodexTurns(path, 0);
    expect(r.turns[0]?.codex).toMatchObject({
      model: "gpt-5.5",
      reasoning_effort: "xhigh",
      personality: "pragmatic",
      approval_policy: "on-request",
      sandbox_policy_type: "workspace-write",
      sandbox_network_access: false,
      sandbox_writable_roots: ["/Users/x/proj"],
      sandbox_exclude_tmpdir_env_var: false,
      sandbox_exclude_slash_tmp: false,
      permission_profile_type: "managed",
      permission_file_system_type: "restricted",
      permission_network: "restricted",
      file_system_sandbox_kind: "restricted",
    });
  });

  it("merges session_meta + turn_context fields into one codex object per turn", async () => {
    writeJsonl(path, [
      sessionMeta({
        source: "cli",
        cli_version: "0.77.0",
        model_provider: "openai",
      }),
      turnContext({
        model: "gpt-5.5",
        effort: "xhigh",
        sandbox_policy_type: "read-only",
      }),
      userMsg("q"),
      assistantMsg("a"),
      userMsg("next"),
    ]);
    const r = await extractCodexTurns(path, 0);
    expect(r.turns[0]?.codex).toMatchObject({
      source: "cli",
      cli_version: "0.77.0",
      model_provider: "openai",
      model: "gpt-5.5",
      reasoning_effort: "xhigh",
      sandbox_policy_type: "read-only",
    });
  });

  it("separates inherited fork history from a local agent-triggered turn", async () => {
    const rootId = "019f85c3-f6b4-7022-b0bd-241fd489616b";
    const parentId = "019f88f9-3aba-77f0-9683-18fae4a82acb";
    const childPath = "/root/reviewer";
    const inheritedId = "019f6ef0-75dc-7873-a25e-d58644a2fb27";
    const localId = "019f8b24-7fd7-79d2-831e-ebeb897a19a6";
    writeJsonl(path, [
      sessionMeta({
        ts: "2026-07-22T18:44:05.000Z",
        session_id: rootId,
        forked_from_id: parentId,
        parent_thread_id: parentId,
        thread_source: "subagent",
        agent_path: childPath,
        history_mode: "legacy",
        agent_depth: 2,
      }),
      // Current Codex subagent files copy the root session header directly
      // after the authoritative physical child header. The copied header is
      // history, not a replacement for this file's child identity.
      sessionMeta({
        id: rootId,
        ts: "2026-07-22T18:44:05.001Z",
        session_id: rootId,
        thread_source: "user",
      }),
      userMsg(
        "copied parent question",
        "2026-07-22T18:44:08.000Z",
        inheritedId,
      ),
      assistantMsg(
        "copied parent answer",
        "2026-07-22T18:44:08.001Z",
        inheritedId,
      ),
      interAgentTrigger("2026-07-22T18:44:15.000Z"),
      agentMessage(
        "review the HTTP boundary",
        childPath,
        localId,
        "2026-07-22T18:44:15.001Z",
      ),
      userMsg(
        "<recommended_plugins>noise</recommended_plugins>",
        "2026-07-22T18:44:15.002Z",
      ),
      assistantMsg("review complete", "2026-07-22T18:49:36.000Z", localId),
      taskComplete("2026-07-22T18:49:36.001Z"),
    ]);

    const result = await extractCodexTurns(path, 0);
    expect(result.turns).toHaveLength(2);
    expect(result.turns[0]).toMatchObject({
      logical_turn_id: inheritedId,
      occurred_at: occurredAtFromUuidV7(inheritedId),
      observed_at: "2026-07-22T18:44:08.001Z",
      observation_kind: "inherited",
    });
    expect(result.turns[1]).toMatchObject({
      user_message: "review the HTTP boundary",
      logical_turn_id: localId,
      occurred_at: occurredAtFromUuidV7(localId),
      observed_at: "2026-07-22T18:49:36.000Z",
      observation_kind: "original",
      initiator: "agent",
      codex: {
        root_thread_id: rootId,
        parent_thread_id: parentId,
        thread_kind: "subagent",
        agent_path: childPath,
        agent_depth: 2,
      },
    });
  });

  it("preserves physical child lineage when a copied root header arrives after a nonzero checkpoint", async () => {
    const rootId = "019f85c3-f6b4-7022-b0bd-241fd489616b";
    const parentId = "019f88f9-3aba-77f0-9683-18fae4a82acb";
    const childPath = "/root/reviewer";
    const inheritedId = "019f6ef0-75dc-7873-a25e-d58644a2fb27";
    writeJsonl(path, [
      sessionMeta({
        ts: "2026-07-22T18:44:05.000Z",
        session_id: rootId,
        parent_thread_id: parentId,
        thread_source: "subagent",
        agent_path: childPath,
        agent_depth: 2,
      }),
    ]);

    const first = await extractCodexTurns(path, 0);
    expect(first.turns).toEqual([]);
    expect(first.codex).toMatchObject({
      root_thread_id: rootId,
      parent_thread_id: parentId,
      thread_kind: "subagent",
      agent_path: childPath,
    });

    appendJsonl(path, [
      sessionMeta({
        id: rootId,
        ts: "2026-07-22T18:44:05.001Z",
        session_id: rootId,
        thread_source: "user",
      }),
      userMsg("copied question", "2026-07-22T18:44:08.000Z", inheritedId),
      assistantMsg("copied answer", "2026-07-22T18:44:08.001Z", inheritedId),
      taskComplete("2026-07-22T18:44:09.000Z"),
    ]);

    const second = await extractCodexTurns(path, first.newOffset, {
      lastKnownCodex: first.codex,
    });
    expect(second.turns).toHaveLength(1);
    expect(second.turns[0]).toMatchObject({
      logical_turn_id: inheritedId,
      observation_kind: "inherited",
      codex: {
        root_thread_id: rootId,
        parent_thread_id: parentId,
        thread_kind: "subagent",
        agent_path: childPath,
      },
    });
  });

  it("uses nested thread_spawn lineage for a targeted subagent turn", async () => {
    const rootId = "019f85c3-f6b4-7022-b0bd-241fd489616b";
    const parentId = "019f88f9-3aba-77f0-9683-18fae4a82acb";
    const childPath = "/root/reviewer";
    const localId = "019f8b24-7fd7-79d2-831e-ebeb897a19a6";
    const header = sessionMeta({
      ts: "2026-07-22T18:44:05.000Z",
      session_id: rootId,
      parent_thread_id: parentId,
      agent_path: childPath,
      agent_depth: 2,
    });
    // Current Codex subagent records carry these fields in
    // source.subagent.thread_spawn; the top-level aliases are not required.
    delete header.payload["parent_thread_id"];
    delete header.payload["agent_path"];
    writeJsonl(path, [
      header,
      interAgentTrigger("2026-07-22T18:44:15.000Z"),
      agentMessage(
        "review the topology",
        childPath,
        localId,
        "2026-07-22T18:44:15.001Z",
      ),
      assistantMsg("review complete", "2026-07-22T18:44:16.000Z", localId),
      taskComplete("2026-07-22T18:44:17.000Z"),
    ]);

    const result = await extractCodexTurns(path, 0);

    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]).toMatchObject({
      logical_turn_id: localId,
      observation_kind: "original",
      initiator: "agent",
      codex: {
        root_thread_id: rootId,
        parent_thread_id: parentId,
        thread_kind: "subagent",
        agent_path: childPath,
        agent_depth: 2,
      },
    });
  });

  it("fails contradictory top-level and nested thread_spawn lineage closed", async () => {
    const rootId = "019f85c3-f6b4-7022-b0bd-241fd489616b";
    const topParentId = "019f88f9-3aba-77f0-9683-18fae4a82acb";
    const nestedParentId = "019f88f9-3aba-77f0-9683-18fae4a82acc";
    const childPath = "/root/reviewer";
    const localId = "019f8b24-7fd7-79d2-831e-ebeb897a19a6";
    const header = sessionMeta({
      ts: "2026-07-22T18:44:05.000Z",
      session_id: rootId,
      parent_thread_id: topParentId,
      agent_path: childPath,
      agent_depth: 2,
    });
    const source = header.payload["source"] as Record<string, unknown>;
    const subagent = source["subagent"] as Record<string, unknown>;
    const spawn = subagent["thread_spawn"] as Record<string, unknown>;
    spawn["parent_thread_id"] = nestedParentId;
    writeJsonl(path, [
      header,
      interAgentTrigger("2026-07-22T18:44:15.000Z"),
      agentMessage(
        "must not be promoted",
        childPath,
        localId,
        "2026-07-22T18:44:15.001Z",
      ),
      assistantMsg("orphaned", "2026-07-22T18:44:16.000Z", localId),
      taskComplete("2026-07-22T18:44:17.000Z"),
    ]);

    const result = await extractCodexTurns(path, 0);

    expect(result.turns).toEqual([]);
    expect(result.codex).toMatchObject({ thread_kind: "unknown" });
    expect(result.codex).not.toHaveProperty("thread_id");
    expect(result.codex).not.toHaveProperty("root_thread_id");
    expect(result.codex).not.toHaveProperty("parent_thread_id");
    expect(result.codex).not.toHaveProperty("agent_path");
  });

  it.each([
    {
      name: "malformed",
      laterHeader: {
        timestamp: "2026-07-22T18:44:05.001Z",
        type: "session_meta",
        payload: { id: "", session_id: "untrusted-root", cwd: "/Users/x/proj" },
      },
    },
    {
      name: "contradictory",
      laterHeader: sessionMeta({
        id: "019f85c3-f6b4-7022-b0bd-241fd489616c",
        ts: "2026-07-22T18:44:05.001Z",
        session_id: "019f85c3-f6b4-7022-b0bd-241fd489616c",
        thread_source: "user",
      }),
    },
  ])(
    "replaces prior lineage atomically with unknown after $name later evidence",
    async ({ laterHeader }) => {
      const rootId = "019f85c3-f6b4-7022-b0bd-241fd489616b";
      const parentId = "019f88f9-3aba-77f0-9683-18fae4a82acb";
      const childPath = "/root/reviewer";
      const turnId = "019f8b24-7fd7-79d2-831e-ebeb897a19a6";
      writeJsonl(path, [
        sessionMeta({
          ts: "2026-07-22T18:44:05.000Z",
          session_id: rootId,
          parent_thread_id: parentId,
          thread_source: "subagent",
          agent_path: childPath,
          agent_depth: 2,
        }),
        laterHeader,
        userMsg("ambiguous source", "2026-07-22T18:44:15.000Z", turnId),
        assistantMsg("keep physical", "2026-07-22T18:44:16.000Z", turnId),
        taskComplete("2026-07-22T18:44:17.000Z"),
      ]);

      const result = await extractCodexTurns(path, 0);

      expect(result.turns).toHaveLength(1);
      expect(result.turns[0]?.observation_kind).toBe("unknown");
      expect(result.turns[0]?.codex).toEqual({ thread_kind: "unknown" });
      expect(result.codex).toEqual({ thread_kind: "unknown" });
    },
  );

  it("fails contradictory user and assistant turn ids closed", async () => {
    const userId = "019f8b24-7fd7-79d2-831e-ebeb897a19a6";
    const assistantId = "019f8b24-7fd7-79d2-831e-ebeb897a19a7";
    writeJsonl(path, [
      sessionMeta(),
      userMsg("conflicting identity", "2026-07-22T18:44:15.000Z", userId),
      assistantMsg(
        "must remain physical",
        "2026-07-22T18:44:16.000Z",
        assistantId,
      ),
      taskComplete("2026-07-22T18:44:17.000Z"),
    ]);

    const result = await extractCodexTurns(path, 0);

    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]).not.toHaveProperty("logical_turn_id");
    expect(result.turns[0]).toMatchObject({
      occurred_at: "2026-07-22T18:44:15.000Z",
      observation_kind: "unknown",
    });
  });

  it("fails contradictory direct and passthrough ids within one record closed", async () => {
    const directId = "019f8b24-7fd7-79d2-831e-ebeb897a19a6";
    const nestedId = "019f8b24-7fd7-79d2-831e-ebeb897a19a7";
    writeJsonl(path, [
      sessionMeta(),
      {
        timestamp: "2026-07-22T18:44:15.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "conflicting payload" }],
          turn_id: directId,
          internal_chat_message_metadata_passthrough: { turn_id: nestedId },
        },
      },
      assistantMsg(
        "must remain physical",
        "2026-07-22T18:44:16.000Z",
        directId,
      ),
      taskComplete("2026-07-22T18:44:17.000Z"),
    ]);

    const result = await extractCodexTurns(path, 0);

    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]).not.toHaveProperty("logical_turn_id");
    expect(result.turns[0]).toMatchObject({
      occurred_at: "2026-07-22T18:44:15.000Z",
      observation_kind: "unknown",
    });
  });

  it("poisons logical identity when either message carries a present malformed id", async () => {
    const validId = "019f8b24-7fd7-79d2-831e-ebeb897a19a6";
    const cases: Array<{
      name: string;
      user: CodexLine;
      assistant: CodexLine;
    }> = [
      {
        name: "blank-user-passthrough",
        user: userMsg("blank user id", "2026-07-22T18:44:15.000Z", ""),
        assistant: assistantMsg(
          "valid assistant id",
          "2026-07-22T18:44:16.000Z",
          validId,
        ),
      },
      {
        name: "malformed-assistant-direct",
        user: userMsg("valid user id", "2026-07-22T18:44:15.000Z", validId),
        assistant: {
          timestamp: "2026-07-22T18:44:16.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "malformed assistant id" }],
            turn_id: "not-a-uuid",
          },
        },
      },
    ];

    for (const testCase of cases) {
      const casePath = join(dir, `${testCase.name}.jsonl`);
      writeJsonl(casePath, [
        sessionMeta(),
        testCase.user,
        testCase.assistant,
        taskComplete("2026-07-22T18:44:17.000Z"),
      ]);

      const result = await extractCodexTurns(casePath, 0);

      expect(result.turns, testCase.name).toHaveLength(1);
      expect(result.turns[0], testCase.name).not.toHaveProperty(
        "logical_turn_id",
      );
      expect(result.turns[0], testCase.name).toMatchObject({
        occurred_at: "2026-07-22T18:44:15.000Z",
        observation_kind: "unknown",
      });
    }
  });

  it("reconciles turn_context identity with only the turn it precedes", async () => {
    const firstId = "019f8b24-7fd7-79d2-831e-ebeb897a19a6";
    const secondId = "019f8b25-7fd7-79d2-831e-ebeb897a19a7";
    writeJsonl(path, [
      sessionMeta(),
      userMsg("first", "2026-07-22T18:44:15.000Z", firstId),
      assistantMsg("first answer", "2026-07-22T18:44:16.000Z", firstId),
      turnContext({ turn_id: secondId, model: "gpt-5.5" }),
      userMsg("second", "2026-07-22T18:45:15.000Z", secondId),
      assistantMsg("second answer", "2026-07-22T18:45:16.000Z", secondId),
      taskComplete("2026-07-22T18:45:17.000Z"),
    ]);

    const result = await extractCodexTurns(path, 0);

    expect(result.turns).toHaveLength(2);
    expect(result.turns.map((turn) => turn.logical_turn_id)).toEqual([
      firstId,
      secondId,
    ]);
    expect(
      result.turns.every((turn) => turn.observation_kind === "original"),
    ).toBe(true);
  });

  it("fails blank or contradictory turn_context identity closed", async () => {
    const messageId = "019f8b24-7fd7-79d2-831e-ebeb897a19a6";
    const otherId = "019f8b24-7fd7-79d2-831e-ebeb897a19a7";
    for (const [name, contextId] of [
      ["blank", ""],
      ["contradictory", otherId],
    ] as const) {
      const casePath = join(dir, `turn-context-${name}.jsonl`);
      writeJsonl(casePath, [
        sessionMeta(),
        turnContext({ turn_id: contextId }),
        userMsg("question", "2026-07-22T18:44:15.000Z", messageId),
        assistantMsg("answer", "2026-07-22T18:44:16.000Z", messageId),
        taskComplete("2026-07-22T18:44:17.000Z"),
      ]);

      const result = await extractCodexTurns(casePath, 0);

      expect(result.turns, name).toHaveLength(1);
      expect(result.turns[0], name).not.toHaveProperty("logical_turn_id");
      expect(result.turns[0]?.observation_kind, name).toBe("unknown");
    }
  });

  it("keeps an inter-agent trigger durable across an interposed config line and restart", async () => {
    const rootId = "019f85c3-f6b4-7022-b0bd-241fd489616b";
    const parentId = "019f88f9-3aba-77f0-9683-18fae4a82acb";
    const childPath = "/root/reviewer";
    const localId = "019f8b24-7fd7-79d2-831e-ebeb897a19a6";
    writeJsonl(path, [
      sessionMeta({
        ts: "2026-07-22T18:44:05.000Z",
        session_id: rootId,
        parent_thread_id: parentId,
        agent_path: childPath,
        agent_depth: 1,
      }),
      interAgentTrigger("2026-07-22T18:44:15.000Z"),
      turnContext({ turn_id: localId, model: "gpt-5.5" }),
    ]);

    const first = await extractCodexTurns(path, 0);
    expect(first.turns).toEqual([]);
    expect(first.newOffset).toBeGreaterThan(0);
    expect(first.newOffset).toBeLessThan(readFileSync(path).length);

    appendJsonl(path, [
      agentMessage(
        "review the topology",
        childPath,
        localId,
        "2026-07-22T18:44:16.000Z",
      ),
      assistantMsg("review complete", "2026-07-22T18:44:17.000Z", localId),
      taskComplete("2026-07-22T18:44:18.000Z"),
    ]);
    const second = await extractCodexTurns(path, first.newOffset, {
      lastKnownCodex: first.codex,
    });

    expect(second.turns).toHaveLength(1);
    expect(second.turns[0]).toMatchObject({
      user_message: "review the topology",
      initiator: "agent",
      observation_kind: "original",
      codex: {
        root_thread_id: rootId,
        parent_thread_id: parentId,
        thread_kind: "subagent",
        agent_path: childPath,
      },
    });
  });

  it("does not let an unrelated turn consume a stale inter-agent trigger", async () => {
    const rootId = "019f85c3-f6b4-7022-b0bd-241fd489616b";
    const parentId = "019f88f9-3aba-77f0-9683-18fae4a82acb";
    const childPath = "/root/reviewer";
    const humanId = "019f8b24-7fd7-79d2-831e-ebeb897a19a6";
    const agentId = "019f8b25-7fd7-79d2-831e-ebeb897a19a7";
    writeJsonl(path, [
      sessionMeta({
        ts: "2026-07-22T18:44:05.000Z",
        session_id: rootId,
        parent_thread_id: parentId,
        thread_source: "subagent",
        agent_path: childPath,
        agent_depth: 1,
      }),
      interAgentTrigger("2026-07-22T18:44:15.000Z"),
      userMsg("unrelated human turn", "2026-07-22T18:44:15.001Z", humanId),
      assistantMsg("human answer", "2026-07-22T18:44:16.000Z", humanId),
      taskComplete("2026-07-22T18:44:17.000Z"),
      agentMessage(
        "must require a fresh marker",
        childPath,
        agentId,
        "2026-07-22T18:44:18.000Z",
      ),
      assistantMsg("must remain orphaned", "2026-07-22T18:44:19.000Z", agentId),
      taskComplete("2026-07-22T18:44:20.000Z"),
    ]);

    const result = await extractCodexTurns(path, 0);

    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]).toMatchObject({
      user_message: "unrelated human turn",
      logical_turn_id: humanId,
      initiator: "unknown",
    });
    expect(result.turns.some((turn) => turn.initiator === "agent")).toBe(false);
  });

  it.each([
    {
      name: "assistant message",
      interruption: assistantMsg(
        "unrelated assistant output",
        "2026-07-22T18:44:15.001Z",
      ),
    },
    {
      name: "other record",
      interruption: {
        timestamp: "2026-07-22T18:44:15.001Z",
        type: "event_msg",
        payload: { type: "task_started" },
      },
    },
  ])(
    "invalidates a pending agent trigger on an incompatible $name",
    async ({ interruption }) => {
      const rootId = "019f85c3-f6b4-7022-b0bd-241fd489616b";
      const childPath = "/root/reviewer";
      const agentId = "019f8b25-7fd7-79d2-831e-ebeb897a19a7";
      writeJsonl(path, [
        sessionMeta({
          ts: "2026-07-22T18:44:05.000Z",
          session_id: rootId,
          parent_thread_id: rootId,
          thread_source: "subagent",
          agent_path: childPath,
          agent_depth: 1,
        }),
        interAgentTrigger("2026-07-22T18:44:15.000Z"),
        interruption,
        agentMessage(
          "must require a fresh marker",
          childPath,
          agentId,
          "2026-07-22T18:44:16.000Z",
        ),
        assistantMsg(
          "must remain orphaned",
          "2026-07-22T18:44:17.000Z",
          agentId,
        ),
        taskComplete("2026-07-22T18:44:18.000Z"),
      ]);

      const result = await extractCodexTurns(path, 0);

      expect(result.turns).toEqual([]);
    },
  );

  it("does not let a system injection replace a pending human prompt", async () => {
    const turnId = "019f8b24-7fd7-79d2-831e-ebeb897a19a6";
    writeJsonl(path, [
      sessionMeta({ ts: "2026-07-22T18:44:05.000Z" }),
      userMsg(
        "Explain the current thread.",
        "2026-07-22T18:44:15.000Z",
        turnId,
      ),
      userMsg(
        "<recommended_plugins>noise</recommended_plugins>",
        "2026-07-22T18:44:15.500Z",
      ),
      assistantMsg(
        "It is the topology thread.",
        "2026-07-22T18:44:16.000Z",
        turnId,
      ),
      taskComplete("2026-07-22T18:44:17.000Z"),
    ]);

    const result = await extractCodexTurns(path, 0);

    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]).toMatchObject({
      user_message: "Explain the current thread.",
      logical_turn_id: turnId,
      initiator: "human",
    });
  });

  it("retains thread lineage even when session config fields are absent", async () => {
    writeJsonl(path, [
      // session_meta with cwd only — no source/cli_version/git
      {
        timestamp: "2026-05-01T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "x", cwd: "/Users/x/proj", thread_source: "user" },
      },
      userMsg("q"),
      assistantMsg("a"),
      userMsg("next"),
    ]);
    const r = await extractCodexTurns(path, 0);
    expect(r.turns[0]?.git).toBeUndefined();
    expect(r.turns[0]?.codex).toMatchObject({
      thread_id: "x",
      root_thread_id: "x",
      thread_kind: "root",
    });
  });

  it("fails ambiguous observation lineage to unknown when session_meta is missing", async () => {
    const turnId = "019f8b24-7fd7-79d2-831e-ebeb897a19a6";
    writeJsonl(path, [
      userMsg("q", "2026-07-22T18:44:15.000Z", turnId),
      assistantMsg("a", "2026-07-22T18:44:16.000Z", turnId),
      userMsg("next", "2026-07-22T18:44:17.000Z"),
    ]);

    const result = await extractCodexTurns(path, 0);
    expect(result.turns[0]).toMatchObject({
      logical_turn_id: turnId,
      observation_kind: "unknown",
    });
  });

  it("fails incomplete Codex session identity closed", async () => {
    const turnId = "019f8b24-7fd7-79d2-831e-ebeb897a19a6";
    const cases: Array<{ name: string; header: CodexLine }> = [
      {
        name: "root-without-physical-thread-id",
        header: {
          timestamp: "2026-07-22T18:44:05.000Z",
          type: "session_meta",
          payload: { cwd: "/Users/x/proj" },
        },
      },
      {
        name: "subagent-without-root-thread-id",
        header: sessionMeta({
          ts: "2026-07-22T18:44:05.000Z",
          parent_thread_id: "019f88f9-3aba-77f0-9683-18fae4a82acb",
          agent_path: "/root/reviewer",
        }),
      },
    ];

    for (const testCase of cases) {
      const casePath = join(dir, `${testCase.name}.jsonl`);
      writeJsonl(casePath, [
        testCase.header,
        userMsg("q", "2026-07-22T18:44:15.000Z", turnId),
        assistantMsg("a", "2026-07-22T18:44:16.000Z", turnId),
        taskComplete("2026-07-22T18:44:17.000Z"),
      ]);

      const result = await extractCodexTurns(casePath, 0);
      expect(result.turns, testCase.name).toHaveLength(1);
      expect(result.turns[0]?.observation_kind, testCase.name).toBe("unknown");
      expect(result.turns[0]?.codex?.thread_kind, testCase.name).toBe(
        "unknown",
      );
      expect(result.turns[0]?.codex?.thread_id, testCase.name).toBeUndefined();
      expect(
        result.turns[0]?.codex?.root_thread_id,
        testCase.name,
      ).toBeUndefined();
    }
  });

  it("does not promote an untargeted agent message into a local turn", async () => {
    const rootId = "019f85c3-f6b4-7022-b0bd-241fd489616b";
    const childPath = "/root/reviewer";
    const localId = "019f8b24-7fd7-79d2-831e-ebeb897a19a6";
    const untargeted = agentMessage(
      "review the topology",
      childPath,
      localId,
      "2026-07-22T18:44:16.000Z",
    );
    delete untargeted.payload["recipient"];
    writeJsonl(path, [
      sessionMeta({
        ts: "2026-07-22T18:44:05.000Z",
        session_id: rootId,
        parent_thread_id: "019f88f9-3aba-77f0-9683-18fae4a82acb",
        agent_path: childPath,
      }),
      interAgentTrigger("2026-07-22T18:44:15.000Z"),
      untargeted,
      assistantMsg("review complete", "2026-07-22T18:44:17.000Z", localId),
      taskComplete("2026-07-22T18:44:18.000Z"),
    ]);

    const result = await extractCodexTurns(path, 0);
    expect(result.turns).toEqual([]);
  });

  it("preserves git + codex across incremental passes via lastKnownGit/lastKnownCodex", async () => {
    writeJsonl(path, [
      sessionMeta({
        source: "vscode",
        cli_version: "0.128.0",
        git: { commit_hash: "abc1234", branch: "main" },
      }),
      turnContext({
        model: "gpt-5.5",
        sandbox_policy_type: "workspace-write",
        sandbox_network_access: false,
        sandbox_writable_roots: ["/Users/x/proj"],
      }),
      userMsg("q1"),
      assistantMsg("a1"),
      userMsg("q2"),
    ]);
    const pass1 = await extractCodexTurns(path, 0);
    expect(pass1.turns).toHaveLength(1);
    expect(pass1.turns[0]?.git?.sha).toBe("abc1234");
    expect(pass1.turns[0]?.codex?.model).toBe("gpt-5.5");

    appendJsonl(path, [assistantMsg("a2"), userMsg("q3")]);
    const pass2 = await extractCodexTurns(path, pass1.newOffset, {
      lastKnownCwd: pass1.cwd,
      lastKnownGit: pass1.git,
      lastKnownCodex: pass1.codex,
    });
    expect(pass2.turns).toHaveLength(1);
    expect(pass2.turns[0]?.user_message).toBe("q2");
    expect(pass2.turns[0]?.git?.sha).toBe("abc1234");
    expect(pass2.turns[0]?.codex?.model).toBe("gpt-5.5");
    expect(pass2.turns[0]?.codex?.sandbox_policy_type).toBe("workspace-write");
  });

  it("omitting lastKnownGit/lastKnownCodex causes them to be dropped on later passes (regression guard)", async () => {
    writeJsonl(path, [
      sessionMeta({ git: { commit_hash: "abc1234" } }),
      turnContext({ model: "gpt-5.5" }),
      userMsg("q1"),
      assistantMsg("a1"),
      userMsg("q2"),
    ]);
    const pass1 = await extractCodexTurns(path, 0);
    appendJsonl(path, [assistantMsg("a2"), userMsg("q3")]);
    const pass2 = await extractCodexTurns(path, pass1.newOffset);
    expect(pass2.turns).toHaveLength(1);
    expect(pass2.turns[0]?.git).toBeUndefined();
    expect(pass2.turns[0]?.codex).toBeUndefined();
    expect(pass2.turns[0]?.observation_kind).toBe("unknown");
  });

  // ─── Tier-3 metadata: tool_calls + thinking ────────────────────────────────

  it("extracts tool_calls with name + args + output, matching by call_id", async () => {
    writeJsonl(path, [
      sessionMeta(),
      userMsg("run ls"),
      functionCall("exec_command", '{"cmd":"ls -la"}', "call_xy"),
      functionCallOutput("call_xy", "total 12\nfoo.txt"),
      assistantMsg("done"),
      userMsg("next"),
    ]);
    const r = await extractCodexTurns(path, 0);
    expect(r.turns).toHaveLength(1);
    const tc = r.turns[0]?.tool_calls;
    expect(tc).toHaveLength(1);
    expect(tc?.[0]).toMatchObject({
      name: "exec_command",
      args: '{"cmd":"ls -la"}',
      output: "total 12\nfoo.txt",
      call_id: "call_xy",
    });
    expect(tc?.[0]?.is_error).toBeUndefined();
    expect(r.turns[0]?.tool_call_total).toBe(1);
    expect(r.turns[0]?.tool_calls_truncated).toBeUndefined();
  });

  it("extracts files_referenced from structured args and apply_patch payloads", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "*** Add File: src/b.ts",
      "*** Delete File: src/c.ts",
      "*** Move to: src/d.ts",
      "*** End Patch",
    ].join("\n");
    writeJsonl(path, [
      sessionMeta(),
      userMsg("touch files"),
      functionCall(
        "exec_command",
        JSON.stringify({
          cmd: "cat src/index.ts",
          path: "src/index.ts",
          nested: { file_path: "src/capture/extractors/codex.ts" },
          notebook_path: "notes/demo.ipynb",
        }),
        "c1",
      ),
      functionCall("apply_patch", patch, "c2"),
      assistantMsg("done"),
      userMsg("next"),
    ]);
    const r = await extractCodexTurns(path, 0);
    expect(r.turns[0]?.files_referenced).toEqual([
      "src/index.ts",
      "src/capture/extractors/codex.ts",
      "notes/demo.ipynb",
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "src/d.ts",
    ]);
  });

  it("marks tool_calls.is_error when output indicates non-zero exit", async () => {
    writeJsonl(path, [
      sessionMeta(),
      userMsg("try"),
      functionCall("exec_command", "{}", "c1"),
      functionCallOutput("c1", "Process exited with code 1\nbroken"),
      assistantMsg("failed"),
      userMsg("next"),
    ]);
    const r = await extractCodexTurns(path, 0);
    expect(r.turns[0]?.tool_calls?.[0]?.is_error).toBe(true);
  });

  it("extracts reasoning blocks into thinking field", async () => {
    writeJsonl(path, [
      sessionMeta(),
      userMsg("q"),
      reasoning("first I check the file…"),
      reasoning("then I verify the diff"),
      assistantMsg("a"),
      userMsg("next"),
    ]);
    const r = await extractCodexTurns(path, 0);
    expect(r.turns[0]?.thinking).toContain("first I check the file");
    expect(r.turns[0]?.thinking).toContain("then I verify the diff");
  });

  it("omits tool_calls and thinking when neither is present", async () => {
    writeJsonl(path, [
      sessionMeta(),
      userMsg("q"),
      assistantMsg("a"),
      userMsg("next"),
    ]);
    const r = await extractCodexTurns(path, 0);
    expect(r.turns[0]?.tool_calls).toBeUndefined();
    expect(r.turns[0]?.thinking).toBeUndefined();
  });

  it("caps tool_calls per turn (truncates beyond MAX_TOOL_CALLS_PER_TURN)", async () => {
    const lines: CodexLine[] = [sessionMeta(), userMsg("q")];
    for (let i = 0; i < 60; i++) {
      lines.push(functionCall("exec", "{}", `c${i}`));
      lines.push(functionCallOutput(`c${i}`, "ok"));
    }
    lines.push(assistantMsg("a"));
    lines.push(userMsg("next"));
    writeJsonl(path, lines);
    const r = await extractCodexTurns(path, 0);
    expect(r.turns[0]?.tool_calls?.length).toBe(50);
    expect(r.turns[0]?.tool_call_total).toBe(60);
    expect(r.turns[0]?.tool_calls_truncated).toBe(true);
  });

  it("a later turn_context updates codex (per-turn config drift)", async () => {
    writeJsonl(path, [
      sessionMeta(),
      turnContext({ model: "gpt-5.4", effort: "medium" }),
      userMsg("q1"),
      assistantMsg("a1"),
      // model changed between turns (rare but legal)
      turnContext({ model: "gpt-5.5", effort: "xhigh" }),
      userMsg("q2"),
      assistantMsg("a2"),
      userMsg("q3"),
    ]);
    const r = await extractCodexTurns(path, 0);
    expect(r.turns).toHaveLength(2);
    expect(r.turns[0]?.codex?.model).toBe("gpt-5.4");
    expect(r.turns[0]?.codex?.reasoning_effort).toBe("medium");
    expect(r.turns[1]?.codex?.model).toBe("gpt-5.5");
    expect(r.turns[1]?.codex?.reasoning_effort).toBe("xhigh");
  });
});

// ─── Lifecycle / integration tests ──────────────────────────────────────────

describe("startCodexExtractor (lifecycle + integration)", () => {
  let dir: string;
  let sessionsPrefix: string;
  let path: string;
  let storage: MemoryStorage;
  let handle: CodexExtractorHandle | null = null;
  let originalFsPaths: string[];
  let captured: ReturnType<typeof captureStdout>;

  beforeEach(() => {
    originalFsPaths = snapshotFsPaths();
    dir = tmpDir("echo-codex-");
    sessionsPrefix = `${dir}/.codex/sessions/`;
    mkdirSync(`${sessionsPrefix}2026/05/01`, { recursive: true });
    path = join(
      sessionsPrefix,
      "2026/05/01/rollout-2026-05-01T10-00-00-019de2b0-6551-7682-a51b-2affaa0a7bbf.jsonl",
    );
    storage = new MemoryStorage();
    captured = captureStdout();
    (CAPTURED_SOURCES.fs_paths as unknown as string[]).push(sessionsPrefix);
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

  it("accepts its configured custom sessions root without widening the global fs allowlist", async () => {
    resetAllowlist();
    restoreFsPaths(originalFsPaths);
    expect(CAPTURED_SOURCES.fs_paths).not.toContain(sessionsPrefix);
    writeJsonl(path, [
      sessionMeta(),
      userMsg("custom-root-q"),
      assistantMsg("custom-root-a"),
      userMsg("next"),
    ]);

    handle = await startCodexExtractor(storage, { sessionsPrefix });
    await waitFor(async () => (await storage.count()) >= 1);

    const events = await storage.query({ order: "asc" });
    expect(events).toHaveLength(1);
    expect(events[0]!.source).toBe(`fs:${path}`);
  });

  it("processes pre-existing JSONL files at boot (catches sessions written before daemon start)", async () => {
    // Pre-create a complete cluster (closed by a second user line) BEFORE
    // the extractor starts. With ignoreInitial:true and offset-map only
    // populated from prior storage, this file would otherwise be silently
    // skipped — same shape as the Claude Code subagent gap.
    writeJsonl(path, [
      sessionMeta(),
      userMsg("q1"),
      assistantMsg("a1"),
      userMsg("q2"),
    ]);

    handle = await startCodexExtractor(storage, { sessionsPrefix });

    // No further file changes — the file is frozen, like a finished
    // codex session that ended before this daemon boot.
    await waitFor(async () => (await storage.count()) >= 1);

    const events = await storage.query({ order: "asc" });
    expect(events).toHaveLength(1);
    expect(events[0]!.source).toBe(`fs:${path}`);
    expect(events[0]!.content).toBe("USER: q1\n\nASSISTANT: a1");
  });

  it("keeps conflicting ids separate from the genuine turn they resemble after projection", async () => {
    const conflictingUserId = "019f8b24-7fd7-79d2-831e-ebeb897a19a6";
    const genuineId = "019f8b24-7fd7-79d2-831e-ebeb897a19a7";
    writeJsonl(path, [
      sessionMeta(),
      userMsg(
        "conflicting identity",
        "2026-07-22T18:44:15.000Z",
        conflictingUserId,
      ),
      assistantMsg(
        "same assistant id as the next genuine turn",
        "2026-07-22T18:44:16.000Z",
        genuineId,
      ),
      userMsg("genuine turn", "2026-07-22T18:45:15.000Z", genuineId),
      assistantMsg("genuine answer", "2026-07-22T18:45:16.000Z", genuineId),
      taskComplete("2026-07-22T18:45:17.000Z"),
    ]);

    handle = await startCodexExtractor(storage, { sessionsPrefix });
    await handle.initialCatchUp;

    const events = await storage.query({ source: `fs:${path}`, order: "asc" });
    const atoms = events.map((event) => {
      const atom = normalizeEvent(event);
      if (atom === null) throw new Error("expected Codex event to normalize");
      return atom;
    });
    const projected = projectLogicalTurns(atoms);

    expect(events).toHaveLength(2);
    expect(events[0]?.metadata).not.toHaveProperty("logical_turn_id");
    expect(events[0]?.metadata?.["observation_kind"]).toBe("unknown");
    expect(events[1]?.metadata?.["logical_turn_id"]).toBe(genuineId);
    expect(projected.atoms).toHaveLength(2);
    expect(projected.collapsed_observation_count).toBe(0);
  });

  it("does not group blank or malformed captured ids", async () => {
    writeJsonl(path, [
      sessionMeta(),
      userMsg("blank id", "2026-07-22T18:44:15.000Z", ""),
      assistantMsg("blank answer", "2026-07-22T18:44:16.000Z", ""),
      userMsg("whitespace id", "2026-07-22T18:45:15.000Z", "   "),
      assistantMsg("whitespace answer", "2026-07-22T18:45:16.000Z", "   "),
      userMsg("malformed id", "2026-07-22T18:46:15.000Z", "not-a-uuid"),
      assistantMsg(
        "malformed answer",
        "2026-07-22T18:46:16.000Z",
        "not-a-uuid",
      ),
      taskComplete("2026-07-22T18:46:17.000Z"),
    ]);

    handle = await startCodexExtractor(storage, { sessionsPrefix });
    await handle.initialCatchUp;

    const events = await storage.query({ source: `fs:${path}`, order: "asc" });
    const atoms = events.map((event) => {
      const atom = normalizeEvent(event);
      if (atom === null) throw new Error("expected Codex event to normalize");
      return atom;
    });
    const projected = projectLogicalTurns(atoms);

    expect(events).toHaveLength(3);
    expect(
      events.every(
        (event) => event.metadata?.["logical_turn_id"] === undefined,
      ),
    ).toBe(true);
    expect(projected.atoms).toHaveLength(3);
    expect(projected.collapsed_observation_count).toBe(0);
  });

  it("projects mixed-offset observation clocks by instant", async () => {
    const logicalId = "019f8b24-7fd7-79d2-831e-ebeb897a19a6";
    writeJsonl(path, [
      sessionMeta(),
      userMsg("earlier instant", "2026-07-22T23:29:00+09:00", logicalId),
      assistantMsg("earlier answer", "2026-07-22T23:30:00+09:00", logicalId),
      userMsg("later instant", "2026-07-22T14:59:00Z", logicalId),
      assistantMsg("later answer", "2026-07-22T15:00:00Z", logicalId),
      taskComplete("2026-07-22T15:01:00Z"),
    ]);

    handle = await startCodexExtractor(storage, { sessionsPrefix });
    await handle.initialCatchUp;

    const events = await storage.query({ source: `fs:${path}`, order: "asc" });
    const atoms = events.map((event) => {
      const atom = normalizeEvent(event);
      if (atom === null) throw new Error("expected Codex event to normalize");
      return atom;
    });
    const projected = projectLogicalTurns(atoms);

    expect(projected.atoms).toHaveLength(1);
    expect(projected.atoms[0]?.action.input).toBe("earlier instant");
    expect(projected.atoms[0]?.time.observed_at).toBe("2026-07-22T15:00:00Z");
  });

  it("preserves an oversized multi-line cluster exactly across a crash and restart", async () => {
    const huge = "x".repeat(1_500_000);
    const metadataBytes = Buffer.from(`${JSON.stringify(sessionMeta())}\n`);
    const oversizedBytes = Buffer.from(
      [
        userMsg("oversized question"),
        assistantMsg(huge),
        assistantMsg(huge),
        assistantMsg(huge),
        taskComplete(),
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
    );
    const boundedUserBytes = Buffer.from(
      `${JSON.stringify(userMsg("bounded question"))}\n`,
    );
    const boundedRestBytes = Buffer.from(
      [assistantMsg("bounded answer"), taskComplete()]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
    );
    const boundedBytes = Buffer.concat([boundedUserBytes, boundedRestBytes]);
    const continuationBytes = Buffer.from(
      `${JSON.stringify(assistantMsg("oversized continuation"))}\n`,
    );
    expect(oversizedBytes.byteLength).toBeGreaterThan(MAX_JSONL_READ_BYTES);
    const sourceBeforeBoundary = Buffer.concat([metadataBytes, oversizedBytes]);
    const completedOversizedBytes = Buffer.concat([
      oversizedBytes,
      continuationBytes,
    ]);
    const source = Buffer.concat([
      sourceBeforeBoundary,
      continuationBytes,
      boundedBytes,
    ]);
    writeFileSync(path, sourceBeforeBoundary);

    const flaky = new AppendThenFailStorage(JSONL_RAW_FRAGMENT_CONTENT_PREFIX);
    storage = flaky;
    handle = await startCodexExtractor(flaky, { sessionsPrefix });
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
    handle = await startCodexExtractor(flaky, { sessionsPrefix });
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
      expectedExtractor: "codex",
      expectedStart: metadataBytes.byteLength,
    });
    expect(raw.ids.filter((id) => id === firstFragment!.id)).toHaveLength(1);
    const activeCheckpoint = await flaky.getCaptureCheckpoint({
      extractor: "codex",
      resource: path,
    });
    expect(activeCheckpoint?.position).toBe(sourceBeforeBoundary.byteLength);
    expect(activeCheckpoint?.state).toHaveProperty("jsonl_raw_fallback");

    const idsBeforeBoundaryRestart = activeEvents
      .map((event) => event.id)
      .sort();
    await handle.stop();
    handle = null;
    handle = await startCodexExtractor(flaky, { sessionsPrefix });
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
      extractor: "codex",
      resource: path,
    });
    expect(boundaryRestartedCheckpoint?.state["jsonl_raw_fallback"]).toEqual(
      activeCheckpoint?.state["jsonl_raw_fallback"],
    );

    const partialUserLength = Math.floor(boundedUserBytes.byteLength / 2);
    appendFileSync(
      path,
      Buffer.concat([
        continuationBytes,
        boundedUserBytes.subarray(0, partialUserLength),
      ]),
    );
    const partialCheckpointPosition =
      sourceBeforeBoundary.byteLength + continuationBytes.byteLength;
    await waitFor(async () => {
      const checkpoint = await flaky.getCaptureCheckpoint({
        extractor: "codex",
        resource: path,
      });
      return checkpoint?.position === partialCheckpointPosition;
    });
    const partialCheckpoint = await flaky.getCaptureCheckpoint({
      extractor: "codex",
      resource: path,
    });
    expect(partialCheckpoint?.state).toHaveProperty("jsonl_raw_fallback");
    expect(
      (await flaky.query({ source: `fs:${path}`, limit: 500 })).some((event) =>
        event.content.includes("bounded question"),
      ),
    ).toBe(false);

    appendFileSync(
      path,
      Buffer.concat([
        boundedUserBytes.subarray(partialUserLength),
        boundedRestBytes,
      ]),
    );
    await waitFor(async () => {
      const checkpoint = await flaky.getCaptureCheckpoint({
        extractor: "codex",
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
      expectedExtractor: "codex",
      expectedStart: metadataBytes.byteLength,
    });
    const semantic = events.filter(
      (event) =>
        event.content === "USER: bounded question\n\nASSISTANT: bounded answer",
    );
    expect(semantic).toHaveLength(1);
    expect(semantic[0]?.metadata?.["turn_index"]).toBe(0);
    const checkpoint = await flaky.getCaptureCheckpoint({
      extractor: "codex",
      resource: path,
    });
    expect(checkpoint?.position).toBe(source.byteLength);
    expect(checkpoint?.state).not.toHaveProperty("jsonl_raw_fallback");

    const idsBeforeCleanRestart = events.map((event) => event.id).sort();
    await handle.stop();
    handle = null;
    handle = await startCodexExtractor(flaky, { sessionsPrefix });
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

  it("preserves one JSONL record larger than a read page before resuming turns", async () => {
    const oversizedRecord = Buffer.from(
      `${JSON.stringify({
        type: "unsupported",
        payload: "z".repeat(MAX_JSONL_READ_BYTES + 1024),
      })}\n`,
    );
    const boundedBytes = Buffer.from(
      [
        userMsg("after giant record"),
        assistantMsg("still captured"),
        taskComplete(),
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
    );
    expect(oversizedRecord.byteLength).toBeGreaterThan(MAX_JSONL_READ_BYTES);
    const source = Buffer.concat([oversizedRecord, boundedBytes]);
    writeFileSync(path, source);

    handle = await startCodexExtractor(storage, { sessionsPrefix });
    await handle.initialCatchUp;
    expect(handle.getHealth()).toMatchObject({
      state: "healthy",
      errorCount: 0,
    });
    const events = await storage.query({
      source: `fs:${path}`,
      order: "asc",
      limit: 500,
    });
    expectExactRawJsonlFragments({
      events,
      expected: oversizedRecord,
      expectedExtractor: "codex",
      expectedStart: 0,
    });
    expect(
      events.filter(
        (event) =>
          event.content ===
          "USER: after giant record\n\nASSISTANT: still captured",
      ),
    ).toHaveLength(1);
    const checkpoint = await storage.getCaptureCheckpoint({
      extractor: "codex",
      resource: path,
    });
    expect(checkpoint?.position).toBe(source.byteLength);
    expect(checkpoint?.state).not.toHaveProperty("jsonl_raw_fallback");
  }, 20_000);

  it("degrades an oversized legacy session header to unknown and advances from its checkpoint", async () => {
    const oversizedHeader = sessionMeta({
      ts: "2026-07-22T18:44:05.000Z",
      session_id: "019f85c3-f6b4-7022-b0bd-241fd489616b",
      parent_thread_id: "019f88f9-3aba-77f0-9683-18fae4a82acb",
      agent_path: "/root/reviewer",
    });
    oversizedHeader.payload["padding"] = "z".repeat(
      MAX_JSONL_READ_BYTES + 1024,
    );
    const headerBytes = Buffer.from(`${JSON.stringify(oversizedHeader)}\n`);
    const turnId = "019f8b24-7fd7-79d2-831e-ebeb897a19a6";
    const freshBytes = Buffer.from(
      [
        userMsg(
          "fresh after legacy checkpoint",
          "2026-07-22T18:44:15.000Z",
          turnId,
        ),
        assistantMsg("captured once", "2026-07-22T18:44:16.000Z", turnId),
        taskComplete("2026-07-22T18:44:17.000Z"),
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
    );
    const source = Buffer.concat([headerBytes, freshBytes]);
    expect(headerBytes.byteLength).toBeGreaterThan(MAX_JSONL_READ_BYTES);
    writeFileSync(path, source);
    await storage.upsertCaptureCheckpoint({
      extractor: "codex",
      resource: path,
      position: headerBytes.byteLength,
      ordinal: 7,
      state: { codex: { model: "legacy-model" } },
      updated_at: "2026-07-22T18:44:10.000Z",
    });

    handle = await startCodexExtractor(storage, { sessionsPrefix });
    await handle.initialCatchUp;

    const events = await storage.query({ source: `fs:${path}`, order: "asc" });
    expect(events).toHaveLength(1);
    expect(events[0]?.content).toBe(
      "USER: fresh after legacy checkpoint\n\nASSISTANT: captured once",
    );
    expect(events[0]?.metadata).toMatchObject({
      turn_index: 8,
      logical_turn_id: turnId,
      observation_kind: "unknown",
      codex: { model: "legacy-model", thread_kind: "unknown" },
    });
    expect(
      events.some(
        (event) => event.metadata?.["capture_fragment"] !== undefined,
      ),
    ).toBe(false);
    const checkpoint = await storage.getCaptureCheckpoint({
      extractor: "codex",
      resource: path,
    });
    expect(checkpoint?.position).toBe(source.byteLength);
    expect(checkpoint?.state["codex"]).toMatchObject({
      model: "legacy-model",
      thread_kind: "unknown",
    });
    expect(checkpoint?.state).not.toHaveProperty("jsonl_raw_fallback");
  }, 20_000);

  it("seeds source identity for a migrated offset-only checkpoint at EOF without replay", async () => {
    writeJsonl(path, [
      sessionMeta(),
      userMsg("already captured"),
      assistantMsg("old answer"),
      taskComplete(),
    ]);
    await storage.upsertCaptureCheckpoint({
      extractor: "codex",
      resource: path,
      position: readFileSync(path).length,
      ordinal: 0,
      state: {},
      updated_at: "2026-07-20T00:00:00.000Z",
    });

    handle = await startCodexExtractor(storage, { sessionsPrefix });
    await handle.initialCatchUp;

    const checkpoint = await storage.getCaptureCheckpoint({
      extractor: "codex",
      resource: path,
    });
    expect(checkpoint?.state["jsonl_source"]).toMatchObject({
      boundary_offset: readFileSync(path).length,
      generation: 0,
    });
    expect(await storage.count()).toBe(0);
  });

  it("emits a CaptureEvent through the pipeline once a cluster closes", async () => {
    handle = await startCodexExtractor(storage, { sessionsPrefix });
    writeJsonl(path, [
      sessionMeta(),
      userMsg("q1"),
      assistantMsg("a1"),
      userMsg("q2"), // closes the cluster
    ]);
    await waitFor(async () => (await storage.count()) >= 1);
    const events = await storage.query({ order: "asc" });
    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.source).toBe(`fs:${path}`);
    expect(evt.content).toBe("USER: q1\n\nASSISTANT: a1");
    expect(evt.metadata).toMatchObject({
      session_id: "019de2b0-6551-7682-a51b-2affaa0a7bbf",
      turn_index: 0,
      cwd: "/Users/x/proj",
    });
    expect(evt.metadata).not.toHaveProperty("had_tool_use");
  });

  it("recovers from truncation and an equal-sized replacement across restart", async () => {
    writeJsonl(path, [
      sessionMeta(),
      userMsg("old prompt with a deliberately long suffix"),
      assistantMsg("old answer with a deliberately long suffix"),
      taskComplete(),
    ]);
    handle = await startCodexExtractor(storage, { sessionsPrefix });
    await waitFor(async () => (await storage.count()) >= 1);

    // In-place truncation must rewind the byte checkpoint and replay the new
    // file instead of leaving the extractor healthy at an impossible offset.
    writeJsonl(path, [
      sessionMeta(),
      userMsg("Q1"),
      assistantMsg("A1"),
      taskComplete(),
    ]);
    await waitFor(async () => (await storage.count()) >= 2);
    expect(handle.getHealth().state).not.toBe("unhealthy");

    await handle.stop();
    handle = null;
    const replacement = `${path}.replacement`;
    writeJsonl(replacement, [
      sessionMeta(),
      userMsg("Q2"),
      assistantMsg("A2"),
      taskComplete(),
    ]);
    expect(readFileSync(replacement).length).toBe(readFileSync(path).length);
    renameSync(replacement, path);

    // Both files end at the checkpoint offset. Only persisted source identity
    // can make the cold-start scan notice the atomic replacement.
    handle = await startCodexExtractor(storage, { sessionsPrefix });
    await waitFor(async () => (await storage.count()) >= 3);
    const events = await storage.query({ order: "asc" });
    expect(
      events.some((event) => event.content === "USER: Q1\n\nASSISTANT: A1"),
    ).toBe(true);
    expect(
      events.some((event) => event.content === "USER: Q2\n\nASSISTANT: A2"),
    ).toBe(true);
    const checkpoint = await storage.getCaptureCheckpoint({
      extractor: "codex",
      resource: path,
    });
    expect(
      (checkpoint?.state["jsonl_source"] as Record<string, unknown>)[
        "generation"
      ],
    ).toBe(2);
  });

  it("keeps the generation stable when benign growth races an accepted append before its checkpoint", async () => {
    writeJsonl(path, [
      sessionMeta(),
      userMsg("q1"),
      assistantMsg("a1"),
      taskComplete(),
    ]);
    storage = new BenignAppendThenSignalStorage(path, [
      userMsg("q2"),
      assistantMsg("a2"),
      taskComplete(),
    ]);

    handle = await startCodexExtractor(storage, { sessionsPrefix });
    await waitFor(async () => (await storage.count()) === 2);

    const events = await storage.query({ order: "asc" });
    expect(
      events.filter((event) => event.content === "USER: q1\n\nASSISTANT: a1"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.content === "USER: q2\n\nASSISTANT: a2"),
    ).toHaveLength(1);
    const checkpoint = await storage.getCaptureCheckpoint({
      extractor: "codex",
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
    const firstTurn = [
      sessionMeta(),
      userMsg("q1"),
      assistantMsg("a1"),
      taskComplete(),
    ];
    writeJsonl(path, [
      ...firstTurn,
      userMsg("OLD2"),
      assistantMsg("a2"),
      taskComplete(),
    ]);
    storage = new RewriteAfterFirstTurnCheckpointStorage(path, [
      ...firstTurn,
      userMsg("NEW2"),
      assistantMsg("a2"),
      taskComplete(),
    ]);

    handle = await startCodexExtractor(storage, { sessionsPrefix });
    await waitFor(async () =>
      (await storage.query({ order: "asc" })).some(
        (event) => event.content === "USER: NEW2\n\nASSISTANT: a2",
      ),
    );

    const events = await storage.query({ order: "asc" });
    const first = events.filter(
      (event) => event.content === "USER: q1\n\nASSISTANT: a1",
    );
    expect(first).toHaveLength(1);
    expect(
      events.some((event) => event.content === "USER: OLD2\n\nASSISTANT: a2"),
    ).toBe(false);
    const firstOffset = (first[0]!.metadata as Record<string, unknown>)[
      "byte_offset"
    ];
    const logs = captured.writes.join("");
    expect(logs).toContain('"message":"jsonl_read_retry"');
    expect(logs).toContain(`"retry_offset":${String(firstOffset)}`);
    expect(logs).toContain('"durable_boundary":true');
  });

  it("does not suppress a same-inode rewrite during candidate append", async () => {
    // The changed prefix is deliberately more than 4 KiB before EOF. The two
    // files have identical identity, size, and final checkpoint-boundary hash,
    // so only a proof spanning the append/checkpoint transaction can notice
    // that the candidate and checkpoint describe different source versions.
    const suffix = "x".repeat(6_000);
    const oldLines = [
      sessionMeta(),
      userMsg(`OLD${suffix}`),
      assistantMsg("answer"),
      taskComplete(),
    ];
    const newLines = [
      sessionMeta(),
      userMsg(`NEW${suffix}`),
      assistantMsg("answer"),
      taskComplete(),
    ];
    writeJsonl(path, oldLines);
    const initialSize = readFileSync(path).length;
    storage = new SameInodeRewriteDuringAppendStorage(path, newLines);

    handle = await startCodexExtractor(storage, { sessionsPrefix });
    await handle.initialCatchUp;
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(readFileSync(path).length).toBe(initialSize);
    const events = await storage.query({ order: "asc" });
    expect(events.some((event) => event.content.startsWith("USER: NEW"))).toBe(
      true,
    );
  });

  it("rewinds the cumulative page when a later append both rewrites and throws", async () => {
    const suffix = "x".repeat(6_000);
    const oldLines = [
      sessionMeta(),
      userMsg(`OLD${suffix}`),
      assistantMsg("answer one"),
      taskComplete(),
      userMsg("question two"),
      assistantMsg("answer two"),
      taskComplete(),
    ];
    const newLines = [
      sessionMeta(),
      userMsg(`NEW${suffix}`),
      assistantMsg("answer one"),
      taskComplete(),
      userMsg("question two"),
      assistantMsg("answer two"),
      taskComplete(),
    ];
    writeJsonl(path, oldLines);
    const initialSize = readFileSync(path).length;
    storage = new SameInodeRewriteAndFailStorage(path, newLines);

    handle = await startCodexExtractor(storage, { sessionsPrefix });
    await handle.initialCatchUp;
    await waitFor(async () =>
      (await storage.query({ order: "asc" })).some((event) =>
        event.content.startsWith("USER: NEW"),
      ),
    );

    expect(readFileSync(path).length).toBe(initialSize);
    expect(handle.getHealth().state).not.toBe("unhealthy");
    const checkpoint = await storage.getCaptureCheckpoint({
      extractor: "codex",
      resource: path,
    });
    expect(
      (checkpoint?.state["jsonl_source"] as Record<string, unknown>)[
        "generation"
      ],
    ).toBe(1);
  });

  it("uses the persisted page proof to recover a rewrite plus growth after restart", async () => {
    const suffix = "x".repeat(6_000);
    writeJsonl(path, [
      sessionMeta(),
      userMsg(`OLD${suffix}`),
      assistantMsg("answer"),
      taskComplete(),
    ]);
    handle = await startCodexExtractor(storage, { sessionsPrefix });
    await waitFor(async () => (await storage.count()) >= 1);
    await handle.stop();
    handle = null;
    const previousSize = readFileSync(path).length;

    // Reuse the inode and first-turn byte offset, but grow the file. A size-only
    // append check would accept this and the generation-0 dedupe key would hide
    // NEW forever; the persisted bounded page proof must force a page rewind.
    writeJsonl(path, [
      sessionMeta(),
      userMsg(`NEW${suffix}`),
      assistantMsg("answer"),
      taskComplete(),
      userMsg("later pending turn"),
    ]);
    expect(readFileSync(path).length).toBeGreaterThan(previousSize);

    handle = await startCodexExtractor(storage, { sessionsPrefix });
    await waitFor(async () =>
      (await storage.query({ order: "asc" })).some((event) =>
        event.content.startsWith("USER: NEW"),
      ),
    );
    const checkpoint = await storage.getCaptureCheckpoint({
      extractor: "codex",
      resource: path,
    });
    expect(
      (checkpoint?.state["jsonl_source"] as Record<string, unknown>)[
        "generation"
      ],
    ).toBe(1);
  });

  it("does not replay an accepted turn when only its complete pending tail shrinks", async () => {
    const accepted = [
      sessionMeta(),
      userMsg("accepted question"),
      assistantMsg("accepted answer"),
      taskComplete(),
    ];
    writeJsonl(path, [...accepted, userMsg("pending question")]);
    handle = await startCodexExtractor(storage, { sessionsPrefix });
    await waitFor(async () => (await storage.count()) === 1);
    await handle.stop();
    handle = null;

    // The pending user line is a complete JSONL record, but it is beyond the
    // durable turn checkpoint. Removing it must not invalidate/replay the
    // already accepted prefix under a new generation.
    writeJsonl(path, accepted);
    handle = await startCodexExtractor(storage, { sessionsPrefix });
    await handle.initialCatchUp;

    expect(await storage.count()).toBe(1);
    const checkpoint = await storage.getCaptureCheckpoint({
      extractor: "codex",
      resource: path,
    });
    expect(
      (checkpoint?.state["jsonl_source"] as Record<string, unknown>)[
        "generation"
      ],
    ).toBe(0);
  });

  it("retains a write-ahead page proof across the append-to-checkpoint crash window", async () => {
    const crashing = new AppendThenFailStorage("ASSISTANT: answer two");
    storage = crashing;
    const oldLines = [
      sessionMeta(),
      userMsg("question one"),
      assistantMsg("answer one"),
      taskComplete(),
      userMsg("OLD second"),
      assistantMsg("answer two"),
      taskComplete(),
    ];
    writeJsonl(path, oldLines);
    const oldSize = readFileSync(path).length;
    handle = await startCodexExtractor(storage, { sessionsPrefix });
    await waitFor(async () => (await storage.count()) === 2);
    await waitFor(() => captured.writes.join("").includes("handler_error"));
    await handle.stop();
    handle = null;

    const checkpointBefore = await storage.getCaptureCheckpoint({
      extractor: "codex",
      resource: path,
    });
    expect(checkpointBefore?.state["jsonl_inflight_source"]).toBeDefined();

    crashing.allowCheckpoints();
    writeJsonl(path, [
      sessionMeta(),
      userMsg("question one"),
      assistantMsg("answer one"),
      taskComplete(),
      userMsg("NEW second"),
      assistantMsg("answer two"),
      taskComplete(),
      userMsg("growth after rewritten page"),
    ]);
    expect(readFileSync(path).length).toBeGreaterThan(oldSize);

    handle = await startCodexExtractor(storage, { sessionsPrefix });
    await waitFor(async () => {
      const hasNew = (await storage.query({ order: "asc" })).some((event) =>
        event.content.startsWith("USER: NEW second"),
      );
      const checkpoint = await storage.getCaptureCheckpoint({
        extractor: "codex",
        resource: path,
      });
      return hasNew && checkpoint?.state["jsonl_inflight_source"] === undefined;
    });
    const checkpointAfter = await storage.getCaptureCheckpoint({
      extractor: "codex",
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

  // Regression: rapid in-place appends elude FSEvents; polling must catch them.
  it("captures every turn from rapid back-to-back appends within the polling interval", async () => {
    handle = await startCodexExtractor(storage, { sessionsPrefix });
    writeJsonl(path, [
      sessionMeta(),
      userMsg("q1"),
      assistantMsg("a1"),
      taskComplete(),
    ]);
    appendJsonl(path, [userMsg("q2"), assistantMsg("a2"), taskComplete()]);
    appendJsonl(path, [userMsg("q3"), assistantMsg("a3"), taskComplete()]);
    await waitFor(async () => (await storage.count()) >= 3, 4000);
    const events = await storage.query({ order: "asc" });
    // Item 025: deterministic id-ASC tie-break on same-ms timestamps —
    // rapid back-to-back appends can collide on timestamp. Compare as a set.
    expect(new Set(events.map((e) => e.content))).toEqual(
      new Set([
        "USER: q1\n\nASSISTANT: a1",
        "USER: q2\n\nASSISTANT: a2",
        "USER: q3\n\nASSISTANT: a3",
      ]),
    );
  });

  it("lands metadata.git and metadata.codex through the pipeline", async () => {
    handle = await startCodexExtractor(storage, { sessionsPrefix });
    writeJsonl(path, [
      sessionMeta({
        source: "vscode",
        cli_version: "0.128.0-alpha.1",
        model_provider: "openai",
        git: {
          commit_hash: "abc1234deadbeef",
          branch: "main",
          repository_url: "https://github.com/u/repo.git",
        },
      }),
      turnContext({
        model: "gpt-5.5",
        effort: "xhigh",
        personality: "pragmatic",
        approval_policy: "on-request",
        sandbox_policy_type: "workspace-write",
        sandbox_network_access: false,
        sandbox_writable_roots: ["/Users/x/proj"],
        sandbox_exclude_tmpdir_env_var: false,
        sandbox_exclude_slash_tmp: false,
        permission_profile_type: "managed",
        permission_file_system_type: "restricted",
        permission_network: "restricted",
        file_system_sandbox_kind: "restricted",
      }),
      userMsg("q1"),
      assistantMsg("a1"),
      userMsg("q2"),
    ]);
    await waitFor(async () => (await storage.count()) >= 1);
    const evt = (await storage.query({ order: "asc" }))[0]!;
    const md = evt.metadata as Record<string, unknown>;
    expect(md["git"]).toEqual({
      sha: "abc1234deadbeef",
      branch: "main",
      origin_url: "https://github.com/u/repo.git",
    });
    expect(md["codex"]).toMatchObject({
      source: "vscode",
      cli_version: "0.128.0-alpha.1",
      model_provider: "openai",
      model: "gpt-5.5",
      reasoning_effort: "xhigh",
      personality: "pragmatic",
      approval_policy: "on-request",
      sandbox_policy_type: "workspace-write",
      sandbox_network_access: false,
      sandbox_writable_roots: ["/Users/x/proj"],
      sandbox_exclude_tmpdir_env_var: false,
      sandbox_exclude_slash_tmp: false,
      permission_profile_type: "managed",
      permission_file_system_type: "restricted",
      permission_network: "restricted",
      file_system_sandbox_kind: "restricted",
    });
    expect(md["git_state"]).toEqual({
      head_sha: "abc1234deadbeef",
      branch: "main",
      captured_at: "2026-05-01T10:00:02.000Z",
      fresh: false,
    });
  });

  it("lands Codex tool overflow and files_referenced metadata through the pipeline", async () => {
    handle = await startCodexExtractor(storage, { sessionsPrefix });
    const lines: CodexLine[] = [sessionMeta(), userMsg("run many tools")];
    for (let i = 0; i < 60; i++) {
      lines.push(
        functionCall(
          "exec_command",
          JSON.stringify({
            cmd: `cat src/file-${i}.ts`,
            path: `src/file-${i}.ts`,
          }),
          `c${i}`,
        ),
      );
      lines.push(functionCallOutput(`c${i}`, "ok"));
    }
    lines.push(assistantMsg("done"));
    lines.push(userMsg("next"));
    writeJsonl(path, lines);

    await waitFor(async () => (await storage.count()) >= 1);
    const evt = (await storage.query({ order: "asc" }))[0]!;
    const md = evt.metadata as Record<string, unknown>;
    expect(md["tool_call_total"]).toBe(60);
    expect(md["tool_calls_truncated"]).toBe(true);
    expect((md["tool_calls"] as unknown[]).length).toBe(50);
    expect(md["files_referenced"]).toEqual(
      Array.from({ length: 60 }, (_, i) => `src/file-${i}.ts`),
    );
  });

  it("restores git + codex from a durable checkpoint on daemon restart", async () => {
    writeJsonl(path, [
      sessionMeta({
        source: "vscode",
        cli_version: "0.128.0",
        git: { commit_hash: "abc1234", branch: "main" },
      }),
      turnContext({
        model: "gpt-5.5",
        sandbox_policy_type: "workspace-write",
        sandbox_network_access: false,
        sandbox_writable_roots: ["/Users/x/proj"],
      }),
      userMsg("q1"),
      assistantMsg("a1"),
      userMsg("q2"),
    ]);
    const r1 = await extractCodexTurns(path, 0);
    expect(r1.turns).toHaveLength(1);
    await storage.append({
      source: `fs:${path}`,
      timestamp: r1.turns[0]!.timestamp,
      content: `USER: ${r1.turns[0]!.user_message}\n\nASSISTANT: ${r1.turns[0]!.assistant_message}`,
      metadata: {
        session_id: r1.turns[0]!.session_id,
        turn_index: 0,
        mtime: r1.turns[0]!.mtime,
        byte_offset: r1.turns[0]!.byte_offset,
        cwd: r1.turns[0]!.cwd,
        git: r1.turns[0]!.git,
        codex: r1.turns[0]!.codex,
      },
    });
    await storage.upsertCaptureCheckpoint({
      extractor: "codex",
      resource: path,
      position: r1.turns[0]!.byte_offset,
      ordinal: 0,
      state: {
        cwd: r1.turns[0]!.cwd,
        git: r1.turns[0]!.git,
        codex: r1.turns[0]!.codex,
      },
      updated_at: "2026-04-30T00:00:01.000Z",
    });

    handle = await startCodexExtractor(storage, { sessionsPrefix });
    appendJsonl(path, [assistantMsg("a2"), userMsg("q3")]);
    await waitFor(async () => (await storage.count()) >= 2);

    const events = await storage.query({ order: "asc" });
    const fresh = events.find((e) => e.content.includes("a2"));
    expect(fresh).toBeDefined();
    const md = fresh!.metadata as Record<string, unknown>;
    expect((md["git"] as Record<string, unknown>)["sha"]).toBe("abc1234");
    expect((md["codex"] as Record<string, unknown>)["model"]).toBe("gpt-5.5");
    expect(
      (md["codex"] as Record<string, unknown>)["sandbox_policy_type"],
    ).toBe("workspace-write");
    expect(
      (md["codex"] as Record<string, unknown>)["sandbox_network_access"],
    ).toBe(false);
    expect(
      (md["codex"] as Record<string, unknown>)["sandbox_writable_roots"],
    ).toEqual(["/Users/x/proj"]);
  });

  it("bounded-backfills lineage for a legacy nonzero checkpoint without replay", async () => {
    const rootId = "019f85c3-f6b4-7022-b0bd-241fd489616b";
    const parentId = "019f88f9-3aba-77f0-9683-18fae4a82acb";
    const childPath = "/root/reviewer";
    const inheritedId = "019f6ef0-75dc-7873-a25e-d58644a2fb27";
    const firstLocalId = "019f8b24-7fd7-79d2-831e-ebeb897a19a6";
    const secondLocalId = "019f8b25-7fd7-79d2-831e-ebeb897a19a7";
    writeJsonl(path, [
      sessionMeta({
        ts: "2026-07-22T18:44:05.000Z",
        session_id: rootId,
        forked_from_id: parentId,
        parent_thread_id: parentId,
        thread_source: "subagent",
        agent_path: childPath,
        history_mode: "legacy",
        agent_depth: 2,
      }),
      userMsg("already captured", "2026-07-22T18:44:08.000Z", inheritedId),
      assistantMsg("old answer", "2026-07-22T18:44:08.001Z", inheritedId),
      taskComplete("2026-07-22T18:44:09.000Z"),
    ]);
    const historical = await extractCodexTurns(path, 0);
    expect(historical.turns).toHaveLength(1);
    const oldTurn = historical.turns[0]!;
    await storage.append({
      source: `fs:${path}`,
      timestamp: oldTurn.timestamp,
      content: `USER: ${oldTurn.user_message}\n\nASSISTANT: ${oldTurn.assistant_message}`,
      metadata: {
        session_id: oldTurn.session_id,
        turn_index: 0,
        byte_offset: oldTurn.byte_offset,
      },
    });
    // This is the deployed pre-lineage shape: useful config survives, but the
    // session header's thread fields were never checkpointed.
    await storage.upsertCaptureCheckpoint({
      extractor: "codex",
      resource: path,
      position: oldTurn.byte_offset,
      ordinal: 0,
      state: {
        cwd: oldTurn.cwd,
        codex: { model: "legacy-model" },
      },
      updated_at: "2026-07-22T18:44:10.000Z",
    });

    handle = await startCodexExtractor(storage, { sessionsPrefix });
    await handle.initialCatchUp;
    expect(await storage.count()).toBe(1);
    const upgraded = await storage.getCaptureCheckpoint({
      extractor: "codex",
      resource: path,
    });
    expect(upgraded?.position).toBe(oldTurn.byte_offset);
    expect(upgraded?.state["codex"]).toMatchObject({
      model: "legacy-model",
      thread_id: "019de2b0-6551-7682-a51b-2affaa0a7bbf",
      root_thread_id: rootId,
      parent_thread_id: parentId,
      forked_from_id: parentId,
      thread_kind: "subagent",
      agent_path: childPath,
      agent_depth: 2,
      agent_nickname: "TestAgent",
      history_mode: "legacy",
      session_started_at: "2026-07-22T18:44:05.000Z",
    });

    appendJsonl(path, [
      interAgentTrigger("2026-07-22T18:44:15.000Z"),
      agentMessage(
        "review the topology",
        childPath,
        firstLocalId,
        "2026-07-22T18:44:15.001Z",
      ),
      assistantMsg("review complete", "2026-07-22T18:44:16.000Z", firstLocalId),
      taskComplete("2026-07-22T18:44:17.000Z"),
    ]);
    await waitFor(async () => (await storage.count()) >= 2);

    let events = await storage.query({ source: `fs:${path}`, order: "asc" });
    const firstFresh = events.find((event) =>
      event.content.includes("review complete"),
    );
    expect(firstFresh?.metadata).toMatchObject({
      turn_index: 1,
      logical_turn_id: firstLocalId,
      observation_kind: "original",
      initiator: "agent",
      thread_id: "019de2b0-6551-7682-a51b-2affaa0a7bbf",
      root_thread_id: rootId,
      parent_thread_id: parentId,
      forked_from_id: parentId,
      thread_kind: "subagent",
      agent_path: childPath,
      agent_depth: 2,
      agent_nickname: "TestAgent",
      history_mode: "legacy",
      codex: {
        model: "legacy-model",
        root_thread_id: rootId,
        thread_kind: "subagent",
      },
    });

    await handle.stop();
    handle = null;
    handle = await startCodexExtractor(storage, { sessionsPrefix });
    await handle.initialCatchUp;
    expect(await storage.count()).toBe(2);
    appendJsonl(path, [
      interAgentTrigger("2026-07-22T18:45:15.000Z"),
      agentMessage(
        "verify the restart",
        childPath,
        secondLocalId,
        "2026-07-22T18:45:15.001Z",
      ),
      assistantMsg(
        "restart verified",
        "2026-07-22T18:45:16.000Z",
        secondLocalId,
      ),
      taskComplete("2026-07-22T18:45:17.000Z"),
    ]);
    await waitFor(async () => (await storage.count()) >= 3);

    events = await storage.query({ source: `fs:${path}`, order: "asc" });
    expect(events).toHaveLength(3);
    const afterRestart = events.find((event) =>
      event.content.includes("restart verified"),
    );
    expect(afterRestart?.metadata).toMatchObject({
      turn_index: 2,
      logical_turn_id: secondLocalId,
      observation_kind: "original",
      root_thread_id: rootId,
      thread_kind: "subagent",
      agent_path: childPath,
    });
  });

  it("mirrors metadata.cwd into metadata.repo_root (cross-source canonical name)", async () => {
    handle = await startCodexExtractor(storage, { sessionsPrefix });
    writeJsonl(path, [
      sessionMeta({ cwd: "/Users/x/proj" }),
      userMsg("q1"),
      assistantMsg("a1"),
      userMsg("q2"),
    ]);
    await waitFor(async () => (await storage.count()) >= 1);
    const evt = (await storage.query({ order: "asc" }))[0]!;
    const md = evt.metadata as Record<string, unknown>;
    expect(md["cwd"]).toBe("/Users/x/proj");
    expect(md["repo_root"]).toBe("/Users/x/proj");
  });

  it("carries cwd on every turn even when extraction spans multiple daemon ticks", async () => {
    handle = await startCodexExtractor(storage, { sessionsPrefix });
    writeJsonl(path, [
      sessionMeta({ cwd: "/Users/x/proj" }),
      userMsg("q1"),
      assistantMsg("a1"),
      userMsg("q2"),
    ]);
    await waitFor(async () => (await storage.count()) >= 1);

    appendJsonl(path, [assistantMsg("a2"), userMsg("q3")]);
    await waitFor(async () => (await storage.count()) >= 2);

    appendJsonl(path, [assistantMsg("a3"), userMsg("q4")]);
    await waitFor(async () => (await storage.count()) >= 3);

    const events = await storage.query({ order: "asc" });
    expect(events).toHaveLength(3);
    for (const e of events) {
      expect((e.metadata as Record<string, unknown>)["cwd"]).toBe(
        "/Users/x/proj",
      );
    }
  });

  it("restores cwd from a durable checkpoint on daemon restart", async () => {
    writeJsonl(path, [
      sessionMeta({ cwd: "/Users/x/proj" }),
      userMsg("q1"),
      assistantMsg("a1"),
      userMsg("q2"),
    ]);
    const r1 = await extractCodexTurns(path, 0);
    expect(r1.turns).toHaveLength(1);
    await storage.append({
      source: `fs:${path}`,
      timestamp: r1.turns[0]!.timestamp,
      content: `USER: ${r1.turns[0]!.user_message}\n\nASSISTANT: ${r1.turns[0]!.assistant_message}`,
      metadata: {
        session_id: r1.turns[0]!.session_id,
        turn_index: 0,
        mtime: r1.turns[0]!.mtime,
        byte_offset: r1.turns[0]!.byte_offset,
        cwd: r1.turns[0]!.cwd,
      },
    });
    await storage.upsertCaptureCheckpoint({
      extractor: "codex",
      resource: path,
      position: r1.turns[0]!.byte_offset,
      ordinal: 0,
      state: { cwd: r1.turns[0]!.cwd },
      updated_at: "2026-04-30T00:00:01.000Z",
    });

    handle = await startCodexExtractor(storage, { sessionsPrefix });
    appendJsonl(path, [assistantMsg("a2"), userMsg("q3")]);
    await waitFor(async () => (await storage.count()) >= 2);

    const events = await storage.query({ order: "asc" });
    const fresh = events.find((e) => e.content.includes("a2"));
    expect(fresh).toBeDefined();
    expect((fresh!.metadata as Record<string, unknown>)["cwd"]).toBe(
      "/Users/x/proj",
    );
  });

  it("end-to-end: appending more clusters produces ordered, non-duplicate turns", async () => {
    handle = await startCodexExtractor(storage, { sessionsPrefix });
    writeJsonl(path, [
      sessionMeta(),
      userMsg("q1"),
      assistantMsg("a1"),
      userMsg("q2"),
    ]);
    await waitFor(async () => (await storage.count()) >= 1);

    appendJsonl(path, [assistantMsg("a2"), userMsg("q3")]);
    await waitFor(async () => (await storage.count()) >= 2);

    const events = await storage.query({ order: "asc" });
    expect(events).toHaveLength(2);
    // Item 025: deterministic id-ASC tie-break on same-second timestamps
    // means events[i] is no longer guaranteed to follow turn_index. Identify
    // by metadata.turn_index.
    const byTurn = new Map(
      events.map((e) => [
        (e.metadata as Record<string, unknown>)["turn_index"] as number,
        e,
      ]),
    );
    expect(byTurn.get(0)?.content).toBe("USER: q1\n\nASSISTANT: a1");
    expect(byTurn.get(1)?.content).toBe("USER: q2\n\nASSISTANT: a2");
  });

  it("uses a durable checkpoint on boot (idempotent resume)", async () => {
    writeJsonl(path, [
      sessionMeta(),
      userMsg("old-q"),
      assistantMsg("old-a"),
      userMsg("next"),
    ]);
    // Pre-seed storage with the first turn already processed at a known offset.
    const r = await extractCodexTurns(path, 0);
    expect(r.turns).toHaveLength(1);
    await storage.append({
      source: `fs:${path}`,
      timestamp: r.turns[0]!.timestamp,
      content: `USER: ${r.turns[0]!.user_message}\n\nASSISTANT: ${r.turns[0]!.assistant_message}`,
      metadata: {
        session_id: r.turns[0]!.session_id,
        turn_index: 0,
        mtime: r.turns[0]!.mtime,
        byte_offset: r.turns[0]!.byte_offset,
      },
    });
    await storage.upsertCaptureCheckpoint({
      extractor: "codex",
      resource: path,
      position: r.turns[0]!.byte_offset,
      ordinal: 0,
      updated_at: "2026-04-30T00:00:01.000Z",
    });

    handle = await startCodexExtractor(storage, { sessionsPrefix });
    appendJsonl(path, [assistantMsg("new-a"), userMsg("q3")]);
    await waitFor(async () => (await storage.count()) >= 2);

    const events = await storage.query({ order: "asc" });
    const fresh = events.find((e) => e.content.includes("new-a"));
    expect(fresh).toBeDefined();
    expect((fresh!.metadata as Record<string, unknown>)["turn_index"]).toBe(1);
  });

  it("does not re-append already-stored turns when a mid-batch append throws (per-turn offset checkpoint)", async () => {
    // Bug A: turns are appended one-by-one but the offset map was only
    // persisted after the loop. A throw on turn 2 left the offset at the
    // pre-batch position, so the next change event re-appended turn 1.
    const flaky = new MidBatchFailingStorage("ASSISTANT: a2");
    handle = await startCodexExtractor(flaky, { sessionsPrefix });

    // Two closed clusters in one batch: turn 1 = q1/a1 (closed by q2),
    // turn 2 = q2/a2 (closed by q3). The append for turn 2 throws once.
    writeJsonl(path, [
      sessionMeta(),
      userMsg("q1"),
      assistantMsg("a1"),
      userMsg("q2"),
      assistantMsg("a2"),
      userMsg("q3"),
    ]);

    // Turn 1 lands; turn 2 throws mid-batch and surfaces as handler_error.
    await waitFor(async () => (await flaky.count()) >= 1);
    await waitFor(() => captured.writes.join("").includes("handler_error"));

    // A later append triggers the next handler run; appends now succeed.
    appendJsonl(path, [assistantMsg("a3"), userMsg("q4")]);
    await waitFor(async () => (await flaky.count()) >= 3);

    const events = await flaky.query({ order: "asc" });
    expect(
      events.filter((e) => e.content === "USER: q1\n\nASSISTANT: a1"),
    ).toHaveLength(1);
    expect(events.some((e) => e.content === "USER: q2\n\nASSISTANT: a2")).toBe(
      true,
    );
    expect(events.some((e) => e.content === "USER: q3\n\nASSISTANT: a3")).toBe(
      true,
    );
  });

  it("stop() resolves cleanly and prevents further events", async () => {
    handle = await startCodexExtractor(storage, { sessionsPrefix });
    writeJsonl(path, [
      sessionMeta(),
      userMsg("q"),
      assistantMsg("a"),
      userMsg("next"),
    ]);
    await waitFor(async () => (await storage.count()) >= 1);
    const before = await storage.count();
    await handle.stop();
    handle = null;

    appendJsonl(path, [assistantMsg("a2"), userMsg("q3")]);
    await new Promise((r) => setTimeout(r, 300));
    expect(await storage.count()).toBe(before);
  });
});

describe("CAPTURED_SOURCES allowlist update for codex sessions", () => {
  it("declares ~/.codex/sessions/ under fs_paths", () => {
    expect(CAPTURED_SOURCES.fs_paths).toContain("~/.codex/sessions/");
  });
});
