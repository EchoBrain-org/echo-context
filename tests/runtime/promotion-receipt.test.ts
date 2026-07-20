import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROMOTION_RECEIPT_RELATIVE_PATH,
  PROMOTION_TREE_MAX_DEPTH,
  PROMOTION_TREE_MAX_FILE_BYTES,
  digestPromotionInstalledTree,
  digestRegularFileBounded,
  encodePromotionReceipt,
  promotionReceiptDigest,
  verifyPromotionReceipt,
  type PromotionReceipt,
} from "../../src/runtime/promotion-receipt.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("promotion receipt", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function fixture(): {
    prefix: string;
    packageRoot: string;
    cliPath: string;
    receiptPath: string;
    receipt: PromotionReceipt;
    receiptDigest: string;
  } {
    const root = mkdtempSync(join(tmpdir(), "echo-context-promotion-"));
    roots.push(root);
    const prefix = join(root, "prefix");
    const packageRoot = join(prefix, "lib", "node_modules", "echo-context");
    const cliPath = join(packageRoot, "dist", "cli.js");
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    writeFileSync(cliPath, "export {};\n");
    const manifestBody = {
      schemaVersion: 1,
      packageVersion: "1.2.3-test.1",
      sourceCommit: "a".repeat(40),
      files: [
        {
          path: "dist/cli.js",
          bytes: readFileSync(cliPath).byteLength,
          sha256: sha256(readFileSync(cliPath, "utf8")),
        },
      ],
    };
    writeFileSync(
      join(packageRoot, "dist", "artifact-manifest.json"),
      `${JSON.stringify({
        ...manifestBody,
        digest: sha256(JSON.stringify(manifestBody)),
      })}\n`,
    );
    mkdirSync(join(prefix, "bin"), { recursive: true });
    symlinkSync(
      "../lib/node_modules/echo-context/dist/cli.js",
      join(prefix, "bin", "echo-context"),
    );
    const receiptPath = join(prefix, PROMOTION_RECEIPT_RELATIVE_PATH);
    mkdirSync(join(prefix, "share", "echo-context"), { recursive: true });
    const artifact = join(root, "echo-context-1.2.3-test.1.tgz");
    writeFileSync(artifact, "exact package tarball bytes\n");
    const tree = digestPromotionInstalledTree(prefix);
    const receipt: PromotionReceipt = {
      schemaVersion: 1,
      artifact: realpathSync(artifact),
      artifactSha256: digestRegularFileBounded(artifact).digest,
      artifactDigest: sha256(JSON.stringify(manifestBody)),
      sourceCommit: manifestBody.sourceCommit,
      version: manifestBody.packageVersion,
      nodeVersion: process.versions.node,
      nodeExecutable: realpathSync(process.execPath),
      installedPrefix: realpathSync(prefix),
      cliPath: realpathSync(join(prefix, "bin", "echo-context")),
      packageRoot: realpathSync(packageRoot),
      installedTreeDigest: tree.digest,
      installedTreeEntries: tree.entries,
      installedTreeFiles: tree.files,
      installedTreeBytes: tree.bytes,
      smoke: "passed",
    };
    const bytes = encodePromotionReceipt(receipt);
    writeFileSync(receiptPath, bytes);
    return {
      prefix,
      packageRoot,
      cliPath,
      receiptPath,
      receipt,
      receiptDigest: promotionReceiptDigest(bytes),
    };
  }

  it("keeps the tree stable across receipt write and verifies every binding", () => {
    const value = fixture();
    const verified = verifyPromotionReceipt({
      startPath: value.cliPath,
      cliPath: value.cliPath,
      expectedArtifactDigest: value.receipt.artifactDigest,
      expectedPromotionReceiptDigest: value.receiptDigest,
    });
    expect(verified.receiptPath).toBe(realpathSync(value.receiptPath));
    expect(verified.receiptDigest).toBe(value.receiptDigest);
    expect(digestPromotionInstalledTree(value.prefix).digest).toBe(
      value.receipt.installedTreeDigest,
    );
  });

  it("rejects a changed installed dependency tree", () => {
    const value = fixture();
    writeFileSync(join(value.prefix, "unexpected.txt"), "mutation\n");
    expect(() =>
      verifyPromotionReceipt({
        startPath: value.cliPath,
        expectedArtifactDigest: value.receipt.artifactDigest,
        expectedPromotionReceiptDigest: value.receiptDigest,
      }),
    ).toThrow(/installed tree/);
  });

  it("rejects a changed package tarball", () => {
    const value = fixture();
    writeFileSync(value.receipt.artifact, "different package bytes\n");
    expect(() =>
      verifyPromotionReceipt({
        startPath: value.cliPath,
        expectedArtifactDigest: value.receipt.artifactDigest,
        expectedPromotionReceiptDigest: value.receiptDigest,
      }),
    ).toThrow(/tarball digest/);
  });

  it("rejects unknown receipt fields under a newly supplied byte digest", () => {
    const value = fixture();
    const withUnknownField = Buffer.from(
      `${JSON.stringify({ ...value.receipt, unexpected: true }, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(value.receiptPath, withUnknownField);
    expect(() =>
      verifyPromotionReceipt({
        startPath: value.cliPath,
        expectedArtifactDigest: value.receipt.artifactDigest,
        expectedPromotionReceiptDigest:
          promotionReceiptDigest(withUnknownField),
      }),
    ).toThrow(/missing or unknown fields/);
  });

  it("rejects noncanonical receipt bytes even when their digest is supplied", () => {
    const value = fixture();
    const noncanonical = Buffer.from(JSON.stringify(value.receipt), "utf8");
    writeFileSync(value.receiptPath, noncanonical);
    expect(() =>
      verifyPromotionReceipt({
        startPath: value.cliPath,
        expectedArtifactDigest: value.receipt.artifactDigest,
        expectedPromotionReceiptDigest: promotionReceiptDigest(noncanonical),
      }),
    ).toThrow(/not canonical/);
  });

  it("enforces per-file and traversal-depth budgets before hashing content", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-context-tree-budget-"));
    roots.push(root);
    const oversized = join(root, "oversized.bin");
    writeFileSync(oversized, "");
    truncateSync(oversized, PROMOTION_TREE_MAX_FILE_BYTES + 1);
    expect(() => digestPromotionInstalledTree(root)).toThrow(
      /file exceeds byte budget/,
    );
    rmSync(oversized);

    const outsideRoot = mkdtempSync(
      join(tmpdir(), "echo-context-tree-outside-"),
    );
    roots.push(outsideRoot);
    const outside = join(outsideRoot, "outside.txt");
    writeFileSync(outside, "outside tree\n");
    const escapingLink = join(root, "escaping-link");
    symlinkSync(outside, escapingLink);
    expect(() => digestPromotionInstalledTree(root)).toThrow(
      /symlink escapes prefix/,
    );
    rmSync(escapingLink);

    let current = root;
    for (let depth = 0; depth <= PROMOTION_TREE_MAX_DEPTH; depth += 1) {
      current = join(current, `depth-${depth}`);
      mkdirSync(current);
    }
    expect(() => digestPromotionInstalledTree(root)).toThrow(
      /depth exceeds budget/,
    );
  });
});
