import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import Database from 'better-sqlite3';

export interface DatabaseAuthorityLock {
  dbPath: string;
  release: () => void;
}

function processIdentity(pid: number): string | null {
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return null;
  const identity = (result.stdout ?? '').trim();
  return identity.length > 0 ? identity : null;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Acquire the database's logical writer row in an IMMEDIATE transaction.
 * Unlike a home-scoped PID file, this cannot be bypassed by using a second
 * label, home, symlink, or spelling for the same SQLite database.
 */
export function acquireDatabaseAuthority(dbPath: string): DatabaseAuthorityLock {
  const db = new Database(dbPath, { fileMustExist: true });
  const token = randomUUID();
  const identity = processIdentity(process.pid) ?? `pid:${process.pid}`;
  const dbStat = statSync(dbPath);
  const databaseIdentity = `${dbStat.dev}:${dbStat.ino}`;
  try {
    const acquire = db.transaction(() => {
      const existing = db
        .prepare(
          `SELECT owner_pid, owner_identity, database_identity
             FROM context_authority
            WHERE lock_name = 'writer'`,
        )
        .get() as
        | { owner_pid: number; owner_identity: string; database_identity: string }
        | undefined;
      if (existing !== undefined) {
        const observedIdentity = processIdentity(existing.owner_pid);
        const sameLiveProcess =
          existing.database_identity === databaseIdentity &&
          isProcessAlive(existing.owner_pid) &&
          (observedIdentity === null || observedIdentity === existing.owner_identity);
        if (sameLiveProcess) {
          throw new Error(
            `context database already has a live writer (pid ${existing.owner_pid})`,
          );
        }
      }
      db.prepare(
        `INSERT INTO context_authority(
           lock_name, owner_pid, owner_identity, database_identity,
           owner_token, acquired_at
         ) VALUES ('writer', ?, ?, ?, ?, ?)
         ON CONFLICT(lock_name) DO UPDATE SET
           owner_pid = excluded.owner_pid,
           owner_identity = excluded.owner_identity,
           database_identity = excluded.database_identity,
           owner_token = excluded.owner_token,
           acquired_at = excluded.acquired_at`,
      ).run(
        process.pid,
        identity,
        databaseIdentity,
        token,
        new Date().toISOString(),
      );
    });
    acquire.immediate();
  } catch (err) {
    db.close();
    throw err;
  }

  let released = false;
  return {
    dbPath,
    release: () => {
      if (released) return;
      released = true;
      try {
        db.prepare(
          `DELETE FROM context_authority
            WHERE lock_name = 'writer' AND owner_token = ?`,
        ).run(token);
      } finally {
        db.close();
      }
    },
  };
}
