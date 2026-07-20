import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteStorage } from '../../src/storage/sqlite.js';
import {
  authorityReceiptPath,
  createAuthorityReceipt,
  readAuthorityReceipt,
  sha256File,
  writeAuthorityReceipt,
} from '../../src/runtime/authority-receipt.js';

describe('authority receipt', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('records both database identities and append watermarks before cutover', async () => {
    const root = mkdtempSync(join(tmpdir(), 'echo-context-receipt-'));
    roots.push(root);
    const legacyPath = join(root, 'legacy.db');
    const nextPath = join(root, 'next.db');
    const legacy = new SqliteStorage(legacyPath);
    const next = new SqliteStorage(nextPath);
    let legacyId = await legacy.append({
      source: 'fs:/legacy',
      timestamp: '2026-07-20T00:00:00.000Z',
      content: 'legacy',
    });
    for (let index = 1; index < 12; index += 1) {
      legacyId = await legacy.append({
        source: 'fs:/legacy',
        timestamp: `2026-07-20T00:00:${String(index).padStart(2, '0')}.000Z`,
        content: `legacy-${index}`,
      });
    }
    const nextId = await next.append({
      source: 'fs:/next',
      timestamp: '2026-07-20T00:00:01.000Z',
      content: 'next',
    });
    legacy.close();
    next.close();
    const legacyPlistPath = join(root, 'legacy.plist');
    writeFileSync(legacyPlistPath, '<plist>legacy</plist>\n', { mode: 0o600 });

    const prepared = createAuthorityReceipt({
      home: root,
      legacyLabel: 'com.echo.daemon',
      nextLabel: 'com.echo.context',
      legacyInitiallyRunning: false,
      artifact: {
        expectedDigest: 'a'.repeat(64),
        verifiedDigest: 'a'.repeat(64),
        expectedPromotionReceiptDigest: 'c'.repeat(64),
        verifiedPromotionReceiptDigest: 'c'.repeat(64),
        promotionReceiptPath:
          '/opt/echo-context/share/echo-context/promotion-receipt.json',
        installedTreeDigest: 'd'.repeat(64),
        nodeExecutableRealpath: '/opt/node/bin/node',
        sourceCommit: 'b'.repeat(40),
        cliRealpath: '/opt/echo-context/dist/cli.js',
        packageRootRealpath: '/opt/echo-context',
      },
      runtime: {
        home: root,
        dbPath: realpathSync(nextPath),
        host: '127.0.0.1',
        port: 38478,
      },
      legacyPlist: {
        path: realpathSync(legacyPlistPath),
        sha256: sha256File(legacyPlistPath),
      },
      legacyDbPath: legacyPath,
      nextDbPath: nextPath,
    });
    const receipt = readAuthorityReceipt(root);
    expect(receipt.schemaVersion).toBe(3);
    expect(receipt.status).toBe('preparing');
    expect(receipt.legacyInitiallyRunning).toBe(false);
    expect(receipt.legacyDb.lastEventId).toBe(legacyId);
    expect(receipt.legacyDb.lastRowid).toBe('12');
    expect(receipt.nextDbBefore.lastEventId).toBe(nextId);
    expect(receipt.artifact.sourceCommit).toBe('b'.repeat(40));
    expect(receipt.artifact.verifiedPromotionReceiptDigest).toBe(
      'c'.repeat(64),
    );
    expect(receipt.legacyPlist.sha256).toBe(sha256File(legacyPlistPath));
    expect(receipt.legacyDb.identityDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(authorityReceiptPath(root)).toContain('state/cutover.json');

    writeAuthorityReceipt(root, {
      ...prepared,
      status: 'legacy_stopped',
      updatedAt: '2026-07-20T00:01:00.000Z',
    });
    expect(readAuthorityReceipt(root).status).toBe('legacy_stopped');
    expect(() =>
      writeAuthorityReceipt(root, {
        ...prepared,
        status: 'active_next',
        updatedAt: '2026-07-20T00:02:00.000Z',
      }),
    ).toThrow(/invalid authority receipt/);
    expect(() =>
      writeAuthorityReceipt(root, {
        ...prepared,
        nextLabel: prepared.legacyLabel,
      }),
    ).toThrow(/invalid authority receipt/);
    expect(() =>
      writeAuthorityReceipt(root, {
        ...prepared,
        nextPlist: prepared.legacyPlist,
      }),
    ).toThrow(/invalid authority receipt/);
  });
});
