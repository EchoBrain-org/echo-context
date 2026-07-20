import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLI_PATH = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const ARTIFACT_DIGEST = "a".repeat(64);

describe("exact-artifact CLI promotion gate", () => {
  for (const [command, args] of [
    ["install", ["--expected-artifact-digest", ARTIFACT_DIGEST]],
    [
      "cutover",
      [
        "--legacy-label",
        "com.echo.legacy",
        "--legacy-db",
        "/tmp/legacy.db",
        "--expected-artifact-digest",
        ARTIFACT_DIGEST,
      ],
    ],
    [
      "rollback",
      [
        "--legacy-label",
        "com.echo.legacy",
        "--expected-artifact-digest",
        ARTIFACT_DIGEST,
      ],
    ],
    ["recover", ["--expected-artifact-digest", ARTIFACT_DIGEST]],
  ] as const) {
    it(`requires the external promotion receipt digest for ${command}`, () => {
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", CLI_PATH, command, ...args],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `${command} requires --expected-promotion-receipt-digest SHA256`,
      );
    });
  }
});
