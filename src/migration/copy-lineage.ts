import Database from 'better-sqlite3';
import { databaseIdentityDigest } from '../runtime/artifact-identity.js';

export interface DatabaseSnapshotLineage {
  sourceDatabaseDigest: string;
  sourceEventCount: number;
  snapshotLastRowid: string | null;
  snapshotLastEventId: string | null;
  snapshotLastTimestamp: string | null;
  copiedAt: string;
  /** Source digest of the lineage this copy replaced; null for a first-generation copy. */
  previousSourceDatabaseDigest: string | null;
}

interface CopyLineageRow {
  source_database_digest: string;
  source_event_count: number;
  snapshot_last_rowid: string | null;
  snapshot_last_event_id: string | null;
  snapshot_last_timestamp: string | null;
  copied_at: string;
  previous_source_database_digest?: string | null;
}

interface SnapshotTail {
  rowid: string;
  id: string;
  timestamp: string;
}

/**
 * Record this copy's origin. The copy is a full backup of its source, so a
 * source that migrate itself produced already carries a lineage table. That
 * record describes the source's origin rather than this copy's; it is
 * replaced, with its digest carried forward so the chain stays recoverable.
 */
export function writeCopyLineage(
  db: Database.Database,
  lineage: Omit<DatabaseSnapshotLineage, 'previousSourceDatabaseDigest'>,
): void {
  db.transaction(() => {
    let previousSourceDatabaseDigest: string | null = null;
    const inherited = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='context_copy_lineage'")
      .get();
    if (inherited !== undefined) {
      const row = db
        .prepare('SELECT source_database_digest AS digest FROM context_copy_lineage WHERE singleton_id = 1')
        .get() as { digest: string } | undefined;
      if (row === undefined) {
        // A lineage table with no record is corruption evidence, not a
        // first-generation copy; never launder it into a clean origin.
        throw new Error(
          'inherited context_copy_lineage table is missing its singleton record',
        );
      }
      previousSourceDatabaseDigest = row.digest;
      db.exec('DROP TABLE context_copy_lineage');
    }
    db.exec(`
      CREATE TABLE context_copy_lineage (
        singleton_id           INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        source_database_digest TEXT NOT NULL CHECK (length(source_database_digest) = 64),
        source_event_count     INTEGER NOT NULL CHECK (source_event_count >= 0),
        snapshot_last_rowid    TEXT,
        snapshot_last_event_id TEXT,
        snapshot_last_timestamp TEXT,
        copied_at              TEXT NOT NULL,
        previous_source_database_digest TEXT
          CHECK (previous_source_database_digest IS NULL OR length(previous_source_database_digest) = 64)
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
         copied_at,
         previous_source_database_digest
       ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      lineage.sourceDatabaseDigest,
      lineage.sourceEventCount,
      lineage.snapshotLastRowid,
      lineage.snapshotLastEventId,
      lineage.snapshotLastTimestamp,
      lineage.copiedAt,
      previousSourceDatabaseDigest,
    );
  })();
}

export function readCopyLineage(path: string): DatabaseSnapshotLineage {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare('SELECT * FROM context_copy_lineage WHERE singleton_id = 1')
      .get() as CopyLineageRow | undefined;
    if (row === undefined) {
      throw new Error(`context database has no copy-lineage record: ${path}`);
    }
    return {
      sourceDatabaseDigest: row.source_database_digest,
      sourceEventCount: row.source_event_count,
      snapshotLastRowid: row.snapshot_last_rowid,
      snapshotLastEventId: row.snapshot_last_event_id,
      snapshotLastTimestamp: row.snapshot_last_timestamp,
      copiedAt: row.copied_at,
      // Lineage written before this column existed is a first-generation copy.
      previousSourceDatabaseDigest: row.previous_source_database_digest ?? null,
    };
  } finally {
    db.close();
  }
}

function currentLegacySnapshot(
  path: string,
): Omit<DatabaseSnapshotLineage, 'copiedAt' | 'previousSourceDatabaseDigest'> {
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
