import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteStorage } from '../../src/storage/sqlite.js';
import { acquireDatabaseAuthority } from '../../src/runtime/database-authority.js';

describe('database writer authority', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('enforces one writer across homes and path aliases', () => {
    const root = mkdtempSync(join(tmpdir(), 'echo-context-db-authority-'));
    roots.push(root);
    const dbPath = join(root, 'context.db');
    new SqliteStorage(dbPath).close();
    const alias = join(root, 'alias.db');
    symlinkSync(dbPath, alias);

    const first = acquireDatabaseAuthority(dbPath);
    expect(() => acquireDatabaseAuthority(alias)).toThrow(/live writer/);
    first.release();

    const replacement = acquireDatabaseAuthority(alias);
    replacement.release();
  });
});
