import { createHash } from "node:crypto";
import { expect } from "vitest";
import {
  JSONL_RAW_FRAGMENT_CONTENT_PREFIX,
  MAX_JSONL_RAW_FRAGMENT_BYTES,
} from "../../src/capture/extractors/_shared.js";
import type { CaptureEvent } from "../../src/storage/interface.js";

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function expectExactRawJsonlFragments(args: {
  events: CaptureEvent[];
  expected: Buffer;
  expectedExtractor: "codex" | "claude_code";
  expectedStart: number;
  expectedGeneration?: number;
  expectedGroupGeneration?: number;
}): { fragments: CaptureEvent[]; ids: string[] } {
  const fragments = args.events
    .filter(
      (event) =>
        event.metadata?.["capture_fragment"] === "oversized_jsonl_cluster",
    )
    .sort(
      (left, right) =>
        Number(left.metadata?.["byte_start"]) -
        Number(right.metadata?.["byte_start"]),
    );
  expect(fragments.length).toBeGreaterThan(0);

  const decoded: Buffer[] = [];
  let expectedOffset = args.expectedStart;
  let fragmentGroup: unknown;
  for (let index = 0; index < fragments.length; index += 1) {
    const event = fragments[index]!;
    const metadata = event.metadata!;
    const byteStart = metadata["byte_start"];
    const byteThrough = metadata["byte_through"];
    const byteCount = metadata["byte_count"];
    expect(byteStart).toBe(expectedOffset);
    expect(typeof byteThrough).toBe("number");
    expect(typeof byteCount).toBe("number");
    expect((byteThrough as number) - (byteStart as number)).toBe(byteCount);
    expect(byteCount as number).toBeGreaterThan(0);
    expect(byteCount as number).toBeLessThanOrEqual(
      MAX_JSONL_RAW_FRAGMENT_BYTES,
    );
    expect(metadata).toMatchObject({
      capture_fragment: "oversized_jsonl_cluster",
      fragment_schema: "jsonl_raw_v1",
      extractor: args.expectedExtractor,
      encoding: "base64",
      source_generation: args.expectedGeneration ?? 0,
      group_generation: args.expectedGroupGeneration ?? 0,
      cluster_start_offset: args.expectedStart,
      fragment_index: index,
    });
    expect(metadata).not.toHaveProperty("byte_offset");
    expect(metadata).not.toHaveProperty("turn_index");
    if (index === 0) fragmentGroup = metadata["fragment_group"];
    expect(metadata["fragment_group"]).toBe(fragmentGroup);
    expect(typeof fragmentGroup).toBe("string");

    expect(event.content.startsWith(JSONL_RAW_FRAGMENT_CONTENT_PREFIX)).toBe(
      true,
    );
    const encoded = event.content.slice(
      JSONL_RAW_FRAGMENT_CONTENT_PREFIX.length,
    );
    const bytes = Buffer.from(encoded, "base64");
    expect(bytes.toString("base64")).toBe(encoded);
    expect(bytes.byteLength).toBe(byteCount);
    expect(sha256(bytes)).toBe(metadata["sha256"]);
    decoded.push(bytes);
    expectedOffset = byteThrough as number;
  }

  const reconstructed = Buffer.concat(decoded);
  expect(reconstructed.byteLength).toBe(args.expected.byteLength);
  expect(expectedOffset).toBe(args.expectedStart + args.expected.byteLength);
  expect(reconstructed.equals(args.expected)).toBe(true);
  expect(sha256(reconstructed)).toBe(sha256(args.expected));
  return { fragments, ids: fragments.map((event) => event.id) };
}
