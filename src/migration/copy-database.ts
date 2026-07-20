import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { SqliteStorage } from '../storage/sqlite.js';
import { databaseIdentityDigest } from '../runtime/artifact-identity.js';
import { writeCopyLineage } from './copy-lineage.js';

export interface DatabaseCopyResult {
  source: string;
  destination: string;
  events: number;
  integrity: 'ok';
  snapshotLastRowid: number;
  snapshotLastEventId: string | null;
  transformations: readonly ['canonicalize_legacy_timestamps', 'backfill_source_key'];
}

export interface DatabaseCopyOptions {
  /** Test/observability seam invoked after the source read snapshot is pinned. */
  afterSnapshotEstablished?: () => void | Promise<void>;
}

/**
 * Copy an existing ECHO ledger with SQLite's online-backup API, then apply the
 * echo-context additive migrations to the copy. The source is always opened
 * read-only and is never rewritten.
 */
export async function copyDatabaseForContext(
  sourcePath: string,
  destinationPath: string,
  options: DatabaseCopyOptions = {},
): Promise<DatabaseCopyResult> {
  const source = resolve(sourcePath);
  const destination = resolve(destinationPath);
  if (source === destination) {
    throw new Error('source and destination database paths must differ');
  }
  if (existsSync(destination)) {
    throw new Error(`destination database already exists: ${destination}`);
  }

  // Apply a private mode only to directories created for the new authority;
  // never chmod a pre-existing caller-owned destination parent.
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(
    `${dirname(destination)}/.echo-context-migrate-${randomUUID()}-`,
  );
  if (process.platform !== 'win32') chmodSync(staging, 0o700);
  const partial = `${staging}/context.db`;
  let sourceDb: Database.Database | undefined;
  try {
    sourceDb = new Database(source, { readonly: true, fileMustExist: true });
    sourceDb.exec('BEGIN');
    const sourceCount = (sourceDb.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number })
      .n;
    const snapshotTail = sourceDb
      .prepare(
        `SELECT rowid, CAST(rowid AS TEXT) AS rowid_text, id, timestamp
           FROM events
          ORDER BY events.rowid DESC
          LIMIT 1`,
      )
      .get() as
      | { rowid: number; rowid_text: string; id: string; timestamp: string }
      | undefined;
    await options.afterSnapshotEstablished?.();
    await sourceDb.backup(partial);
    if (process.platform !== 'win32') chmodSync(partial, 0o600);
    sourceDb.exec('ROLLBACK');
    sourceDb.close();
    sourceDb = undefined;

    const migrated = new SqliteStorage(partial);
    const copiedCount = await migrated.count();
    migrated.close();
    if (copiedCount !== sourceCount) {
      throw new Error(
        `database copy count mismatch: source=${sourceCount}, destination=${copiedCount}`,
      );
    }

    const lineageDb = new Database(partial);
    try {
      writeCopyLineage(lineageDb, {
        sourceDatabaseDigest: databaseIdentityDigest(source),
        sourceEventCount: sourceCount,
        snapshotLastRowid: snapshotTail?.rowid_text ?? null,
        snapshotLastEventId: snapshotTail?.id ?? null,
        snapshotLastTimestamp: snapshotTail?.timestamp ?? null,
        copiedAt: new Date().toISOString(),
      });
    } finally {
      lineageDb.close();
    }

    const verify = new Database(partial, { readonly: true, fileMustExist: true });
    const integrityRows = verify.pragma('quick_check') as Array<{ quick_check: string }>;
    verify.close();
    if (integrityRows.length !== 1 || integrityRows[0]?.quick_check !== 'ok') {
      throw new Error('database copy failed SQLite quick_check');
    }

    // Publish without a TOCTOU overwrite: hard-link creation is atomic and
    // fails with EEXIST if another migration won the destination race. POSIX
    // rename would silently replace that winner.
    linkSync(partial, destination);
    unlinkSync(partial);
    rmSync(staging, { recursive: true, force: true });
    return {
      source,
      destination,
      events: copiedCount,
      integrity: 'ok',
      snapshotLastRowid: snapshotTail?.rowid ?? 0,
      snapshotLastEventId: snapshotTail?.id ?? null,
      transformations: ['canonicalize_legacy_timestamps', 'backfill_source_key'],
    };
  } catch (err) {
    if (sourceDb?.open === true) sourceDb.close();
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}
