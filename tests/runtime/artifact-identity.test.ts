import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ARTIFACT_MANIFEST_MAX_BYTES,
  verifyRuntimeArtifact,
} from "../../src/runtime/artifact-identity.js";

describe("runtime artifact manifest budgets", () => {
  let packageRoot: string;
  let cliPath: string;

  beforeEach(() => {
    packageRoot = mkdtempSync(join(tmpdir(), "echo-artifact-manifest-"));
    const distDir = join(packageRoot, "dist");
    mkdirSync(distDir);
    cliPath = join(distDir, "cli.js");
    writeFileSync(cliPath, "");
  });

  afterEach(() => {
    rmSync(packageRoot, { recursive: true, force: true });
  });

  it("rejects an oversized manifest before reading or parsing it", () => {
    writeFileSync(
      join(packageRoot, "dist", "artifact-manifest.json"),
      "x".repeat(ARTIFACT_MANIFEST_MAX_BYTES + 1),
    );

    expect(() => verifyRuntimeArtifact(cliPath)).toThrow(
      /runtime artifact manifest exceeds byte budget/,
    );
  });
});
