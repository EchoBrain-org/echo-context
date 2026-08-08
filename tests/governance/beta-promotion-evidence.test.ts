import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// @ts-expect-error the committed release verifier is intentionally plain .mjs.
import * as promotionEvidence from '../../tools/beta-promotion-evidence.mjs';

const { digestStagedInstalledTree, verifyStagedPromotion } = promotionEvidence;

const SOURCE_SHA = '1'.repeat(40);

function sha256(value: Buffer | string) {
  return createHash('sha256').update(value).digest('hex');
}

function promotionFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'echo-promotion-evidence-')));
  const prefix = join(root, 'prefix');
  const packageRoot = join(prefix, 'lib', 'node_modules', 'echo-context');
  const dist = join(packageRoot, 'dist');
  const cliPath = join(dist, 'cli.js');
  const indexPath = join(dist, 'index.js');
  const receiptDirectory = join(prefix, 'share', 'echo-context');
  const receiptPath = join(receiptDirectory, 'promotion-receipt.json');
  const artifact = join(root, 'echo-context-0.1.0-beta.9.tgz');
  mkdirSync(dist, { recursive: true });
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  mkdirSync(receiptDirectory, { recursive: true });
  writeFileSync(cliPath, '#!/usr/bin/env node\n', { mode: 0o755 });
  writeFileSync(indexPath, 'export const safe = true;\n');
  symlinkSync('../lib/node_modules/echo-context/dist/cli.js', join(prefix, 'bin', 'echo-context'));
  writeFileSync(artifact, 'exact package tarball');
  const files = [
    {
      bytes: Buffer.byteLength('#!/usr/bin/env node\n'),
      path: 'dist/cli.js',
      sha256: sha256('#!/usr/bin/env node\n'),
    },
    {
      bytes: Buffer.byteLength('export const safe = true;\n'),
      path: 'dist/index.js',
      sha256: sha256('export const safe = true;\n'),
    },
  ];
  const runtimeBody = {
    schemaVersion: 1,
    packageVersion: '0.1.0-beta.9',
    sourceCommit: SOURCE_SHA,
    files,
  };
  const artifactDigest = sha256(JSON.stringify(runtimeBody));
  writeFileSync(
    join(dist, 'artifact-manifest.json'),
    JSON.stringify({ ...runtimeBody, digest: artifactDigest }),
  );
  const installedTree = digestStagedInstalledTree(prefix);
  const receipt = {
    schemaVersion: 1,
    artifact: realpathSync(artifact),
    artifactSha256: sha256('exact package tarball'),
    artifactDigest,
    sourceCommit: SOURCE_SHA,
    version: '0.1.0-beta.9',
    nodeVersion: process.versions.node,
    nodeExecutable: realpathSync(process.execPath),
    installedPrefix: realpathSync(prefix),
    cliPath: realpathSync(join(prefix, 'bin', 'echo-context')),
    packageRoot: realpathSync(packageRoot),
    installedTreeDigest: installedTree.digest,
    installedTreeEntries: installedTree.entries,
    installedTreeFiles: installedTree.files,
    installedTreeBytes: installedTree.bytes,
    smoke: 'passed',
  };
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  writeFileSync(receiptPath, receiptBytes, { mode: 0o600 });
  return {
    cleanup: () => rmSync(root, { force: true, recursive: true }),
    cliPath,
    smoke: {
      ...receipt,
      promotionReceipt: receiptPath,
      promotionReceiptDigest: sha256(receiptBytes),
    },
  };
}

describe('trusted staged-promotion evidence', () => {
  it('recomputes the receipt, package manifest, tarball, and installed tree without candidate code', () => {
    const fixture = promotionFixture();
    try {
      expect(verifyStagedPromotion(fixture.smoke)).toMatchObject({
        receipt: { sourceCommit: SOURCE_SHA, version: '0.1.0-beta.9' },
      });
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects mutable result counts, package bytes, and a non-executable CLI', () => {
    for (const mutate of [
      (fixture: ReturnType<typeof promotionFixture>) => ({
        ...fixture.smoke,
        installedTreeFiles: fixture.smoke.installedTreeFiles + 1,
      }),
      (fixture: ReturnType<typeof promotionFixture>) => {
        writeFileSync(fixture.cliPath, 'tampered\n');
        return fixture.smoke;
      },
      (fixture: ReturnType<typeof promotionFixture>) => {
        chmodSync(fixture.cliPath, 0o001);
        return fixture.smoke;
      },
    ]) {
      const fixture = promotionFixture();
      try {
        expect(() => verifyStagedPromotion(mutate(fixture))).toThrow(/beta promotion evidence/u);
      } finally {
        fixture.cleanup();
      }
    }
  });
});
