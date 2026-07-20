import Database from 'better-sqlite3';
import { databaseIdentityDigest } from '../runtime/artifact-identity.js';

export interface DatabaseSnapshotLineage {
  sourceDatabaseDigest: string;
  sourceEventCount: number;
  snapshotLastRowid: string | null;
  snapshotLastEventId: string | null;
  snapshotLastTimestamp: string | null;
  copiedAt: string;
}

interface SnapshotTail {
  rowid: string;
  id: string;
  timestamp: string;
}

export function writeCopyLineage(
  db: Database.Database,
  lineage: DatabaseSnapshotLineage,
): void {
  db.exec(`
    CREATE TABLE context_copy_lineage (
      singleton_id           INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      source_database_digest TEXT NOT NULL CHECK (length(source_database_digest) = 64),
      source_event_count     INTEGER NOT NULL CHECK (source_event_count >= 0),
      snapshot_last_rowid    TEXT,
      snapshot_last_event_id TEXT,
      snapshot_last_timestamp TEXT,
      copied_at              TEXT NOT NULL
    )
  `);
  db.prepare(
    `INSERT INTO context_copy_lineage (
       singleton_id,
       source_database_digest,
       source_event_count,
       snapshot_last_rowid,
       snapshot_last_event_id,
       snapshot_last_timestamp,
       copied_at
     ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
  ).run(
    lineage.sourceDatabaseDigest,
    lineage.sourceEventCount,
    lineage.snapshotLastRowid,
    lineage.snapshotLastEventId,
    lineage.snapshotLastTimestamp,
    lineage.copiedAt,
  );
}

export function readCopyLineage(path: string): DatabaseSnapshotLineage {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare(
        `SELECT
           source_database_digest AS sourceDatabaseDigest,
           source_event_count AS sourceEventCount,
           snapshot_last_rowid AS snapshotLastRowid,
           snapshot_last_event_id AS snapshotLastEventId,
           snapshot_last_timestamp AS snapshotLastTimestamp,
           copied_at AS copiedAt
         FROM context_copy_lineage
         WHERE singleton_id = 1`,
      )
      .get() as DatabaseSnapshotLineage | undefined;
    if (row === undefined) {
      throw new Error(`context database has no copy-lineage record: ${path}`);
    }
    return row;
  } finally {
    db.close();
  }
}

function currentLegacySnapshot(path: string): Omit<DatabaseSnapshotLineage, 'copiedAt'> {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const sourceEventCount = (
      db.prepare('SELECT count(*) AS count FROM events').get() as { count: number }
    ).count;
    const tail = db
      .prepare(
        `SELECT CAST(rowid AS TEXT) AS rowid, id, timestamp
           FROM events
          ORDER BY events.rowid DESC
          LIMIT 1`,
      )
      .get() as SnapshotTail | undefined;
    return {
      sourceDatabaseDigest: databaseIdentityDigest(path),
      sourceEventCount,
      snapshotLastRowid: tail?.rowid ?? null,
      snapshotLastEventId: tail?.id ?? null,
      snapshotLastTimestamp: tail?.timestamp ?? null,
    };
  } finally {
    db.close();
  }
}

/**
 * Prove that the quiesced legacy ledger is still the exact append-only
 * snapshot copied into the next database. This intentionally fails if even
 * one event was appended after migration; the operator must make a fresh copy.
 */
export function assertCopyContainsCurrentLegacy(
  legacyPath: string,
  nextPath: string,
): DatabaseSnapshotLineage {
  const recorded = readCopyLineage(nextPath);
  const current = currentLegacySnapshot(legacyPath);
  for (const key of [
    'sourceDatabaseDigest',
    'sourceEventCount',
    'snapshotLastRowid',
    'snapshotLastEventId',
    'snapshotLastTimestamp',
  ] as const) {
    if (recorded[key] !== current[key]) {
      throw new Error(
        `next database is stale or unrelated: legacy ${key} no longer matches its copy lineage`,
      );
    }
  }

  const next = new Database(nextPath, { readonly: true, fileMustExist: true });
  try {
    const nextCount = (
      next.prepare('SELECT count(*) AS count FROM events').get() as { count: number }
    ).count;
    if (nextCount < recorded.sourceEventCount) {
      throw new Error('next database contains fewer events than its recorded legacy snapshot');
    }
    if (recorded.snapshotLastEventId !== null) {
      const copiedTail = next
        .prepare('SELECT id FROM events WHERE id = ? LIMIT 1')
        .get(recorded.snapshotLastEventId) as { id: string } | undefined;
      if (copiedTail === undefined) {
        throw new Error('next database does not contain its recorded legacy snapshot tail');
      }
    }
  } finally {
    next.close();
  }
  return recorded;
}
