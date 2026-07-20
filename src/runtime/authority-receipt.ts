import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import Database from 'better-sqlite3';
import { atomicWrite } from '../echo-home/adapters/atomic-write.js';
import { ECHO_CONTEXT_VERSION } from '../version.js';
import { databaseIdentityDigest } from './artifact-identity.js';

const SHA256_RE = /^[a-f0-9]{64}$/;
const SOURCE_COMMIT_RE = /^[a-f0-9]{40}$/;

export interface DatabaseWatermark {
  path: string;
  identityDigest: string;
  userVersion: number;
  pageCount: number;
  lastRowid: string | null;
  lastEventId: string | null;
  lastTimestamp: string | null;
}

export type AuthorityReceiptStatus =
  | 'preparing'
  | 'legacy_stopped'
  | 'active_next'
  | 'cutover_failed'
  | 'cutover_ambiguous'
  | 'rolled_back'
  | 'rollback_ambiguous';

export interface AuthorityArtifactBinding {
  expectedDigest: string;
  verifiedDigest: string;
  expectedPromotionReceiptDigest: string;
  verifiedPromotionReceiptDigest: string;
  promotionReceiptPath: string;
  installedTreeDigest: string;
  nodeExecutableRealpath: string;
  sourceCommit: string;
  cliRealpath: string;
  packageRootRealpath: string;
}

export interface AuthorityPlistBinding {
  path: string;
  sha256: string;
}

export interface AuthorityRuntimeBinding {
  home: string;
  dbPath: string;
  host: string;
  port: number;
}

export interface AuthorityReceipt {
  schemaVersion: 3;
  packageVersion: string;
  status: AuthorityReceiptStatus;
  legacyLabel: string;
  nextLabel: string;
  legacyInitiallyRunning: boolean;
  artifact: AuthorityArtifactBinding;
  runtime: AuthorityRuntimeBinding;
  legacyPlist: AuthorityPlistBinding;
  nextPlist?: AuthorityPlistBinding;
  legacyDb: DatabaseWatermark;
  nextDbBefore: DatabaseWatermark;
  nextDbAtRollback?: DatabaseWatermark;
  preparedAt: string;
  updatedAt: string;
  reverseMerged: false;
  lastError?: string;
}

export function authorityReceiptPath(home: string): string {
  return join(home, 'state', 'cutover.json');
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function readDatabaseWatermark(path: string): DatabaseWatermark {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const events = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'")
      .get();
    if (events === undefined) throw new Error(`database has no events table: ${path}`);
    const latest = db
      .prepare(
        `SELECT CAST(rowid AS TEXT) AS rowid, id, timestamp
           FROM events
          ORDER BY events.rowid DESC
          LIMIT 1`,
      )
      .get() as { rowid: string; id: string; timestamp: string } | undefined;
    return {
      path: realpathSync(path),
      identityDigest: databaseIdentityDigest(path),
      userVersion: db.pragma('user_version', { simple: true }) as number,
      pageCount: db.pragma('page_count', { simple: true }) as number,
      lastRowid: latest?.rowid ?? null,
      lastEventId: latest?.id ?? null,
      lastTimestamp: latest?.timestamp ?? null,
    };
  } finally {
    db.close();
  }
}

export function createAuthorityReceipt(input: {
  home: string;
  legacyLabel: string;
  nextLabel: string;
  legacyInitiallyRunning: boolean;
  artifact: AuthorityArtifactBinding;
  runtime: AuthorityRuntimeBinding;
  legacyPlist: AuthorityPlistBinding;
  legacyDbPath: string;
  nextDbPath: string;
  replaceTerminal?: boolean;
}): AuthorityReceipt {
  const existingPath = authorityReceiptPath(input.home);
  if (existsSync(existingPath)) {
    const existing = readAuthorityReceipt(input.home);
    if (
      existing.status === 'preparing' ||
      existing.status === 'legacy_stopped' ||
      existing.status === 'active_next' ||
      existing.status === 'cutover_ambiguous' ||
      existing.status === 'rollback_ambiguous'
    ) {
      throw new Error(
        `authority receipt is still non-terminal (${existing.status}); refuse overlapping cutover`,
      );
    }
    if (input.replaceTerminal !== true) {
      throw new Error(
        `terminal authority receipt already exists (${existing.status}); pass --replace to archive it`,
      );
    }
    const historyDir = join(input.home, 'state', 'history');
    mkdirSync(historyDir, { recursive: true, mode: 0o700 });
    chmodSync(historyDir, 0o700);
    atomicWrite({
      filePath: join(
        historyDir,
        `${existing.preparedAt.replaceAll(':', '-')}-${existing.status}.json`,
      ),
      content: `${JSON.stringify(existing, null, 2)}\n`,
      secretSensitive: true,
    });
  }
  const now = new Date().toISOString();
  const receipt: AuthorityReceipt = {
    schemaVersion: 3,
    packageVersion: ECHO_CONTEXT_VERSION,
    status: 'preparing',
    legacyLabel: input.legacyLabel,
    nextLabel: input.nextLabel,
    legacyInitiallyRunning: input.legacyInitiallyRunning,
    artifact: input.artifact,
    runtime: input.runtime,
    legacyPlist: input.legacyPlist,
    legacyDb: readDatabaseWatermark(input.legacyDbPath),
    nextDbBefore: readDatabaseWatermark(input.nextDbPath),
    preparedAt: now,
    updatedAt: now,
    reverseMerged: false,
  };
  writeAuthorityReceipt(input.home, receipt);
  return receipt;
}

export function writeAuthorityReceipt(home: string, receipt: AuthorityReceipt): string {
  assertAuthorityReceipt(receipt, authorityReceiptPath(home));
  const stateDir = join(home, 'state');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const path = authorityReceiptPath(home);
  atomicWrite({
    filePath: path,
    content: `${JSON.stringify(receipt, null, 2)}\n`,
    secretSensitive: true,
  });
  return path;
}

export function readAuthorityReceipt(home: string): AuthorityReceipt {
  const path = authorityReceiptPath(home);
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<AuthorityReceipt>;
  assertAuthorityReceipt(value, path);
  return value as AuthorityReceipt;
}

function validWatermark(value: unknown): value is DatabaseWatermark {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Partial<DatabaseWatermark>;
  return (
    typeof record.path === 'string' &&
    isAbsolute(record.path) &&
    typeof record.identityDigest === 'string' &&
    SHA256_RE.test(record.identityDigest) &&
    Number.isInteger(record.userVersion) &&
    (record.userVersion as number) >= 0 &&
    Number.isInteger(record.pageCount) &&
    (record.pageCount as number) >= 0 &&
    (record.lastRowid === null || typeof record.lastRowid === 'string') &&
    (record.lastEventId === null || typeof record.lastEventId === 'string') &&
    (record.lastTimestamp === null || typeof record.lastTimestamp === 'string')
  );
}

function validPlistBinding(value: unknown): value is AuthorityPlistBinding {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Partial<AuthorityPlistBinding>;
  return (
    typeof record.path === 'string' &&
    isAbsolute(record.path) &&
    typeof record.sha256 === 'string' &&
    SHA256_RE.test(record.sha256)
  );
}

function validArtifactBinding(value: unknown): value is AuthorityArtifactBinding {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Partial<AuthorityArtifactBinding>;
  return (
    typeof record.expectedDigest === 'string' &&
    SHA256_RE.test(record.expectedDigest) &&
    typeof record.verifiedDigest === 'string' &&
    SHA256_RE.test(record.verifiedDigest) &&
    record.expectedDigest === record.verifiedDigest &&
    typeof record.expectedPromotionReceiptDigest === 'string' &&
    SHA256_RE.test(record.expectedPromotionReceiptDigest) &&
    typeof record.verifiedPromotionReceiptDigest === 'string' &&
    SHA256_RE.test(record.verifiedPromotionReceiptDigest) &&
    record.expectedPromotionReceiptDigest ===
      record.verifiedPromotionReceiptDigest &&
    typeof record.promotionReceiptPath === 'string' &&
    isAbsolute(record.promotionReceiptPath) &&
    typeof record.installedTreeDigest === 'string' &&
    SHA256_RE.test(record.installedTreeDigest) &&
    typeof record.nodeExecutableRealpath === 'string' &&
    isAbsolute(record.nodeExecutableRealpath) &&
    typeof record.sourceCommit === 'string' &&
    SOURCE_COMMIT_RE.test(record.sourceCommit) &&
    typeof record.cliRealpath === 'string' &&
    isAbsolute(record.cliRealpath) &&
    typeof record.packageRootRealpath === 'string' &&
    isAbsolute(record.packageRootRealpath)
  );
}

function validRuntimeBinding(value: unknown): value is AuthorityRuntimeBinding {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Partial<AuthorityRuntimeBinding>;
  return (
    typeof record.home === 'string' &&
    isAbsolute(record.home) &&
    typeof record.dbPath === 'string' &&
    isAbsolute(record.dbPath) &&
    (record.host === '127.0.0.1' || record.host === 'localhost' || record.host === '::1') &&
    Number.isInteger(record.port) &&
    (record.port as number) >= 1 &&
    (record.port as number) <= 65_535
  );
}

function assertAuthorityReceipt(
  value: Partial<AuthorityReceipt>,
  path: string,
): asserts value is AuthorityReceipt {
  const statuses: readonly AuthorityReceiptStatus[] = [
    'preparing',
    'legacy_stopped',
    'active_next',
    'cutover_failed',
    'cutover_ambiguous',
    'rolled_back',
    'rollback_ambiguous',
  ];
  if (
    value.schemaVersion !== 3 ||
    typeof value.packageVersion !== 'string' ||
    typeof value.status !== 'string' ||
    !statuses.includes(value.status as AuthorityReceiptStatus) ||
    typeof value.legacyLabel !== 'string' ||
    typeof value.nextLabel !== 'string' ||
    value.legacyLabel === value.nextLabel ||
    typeof value.legacyInitiallyRunning !== 'boolean' ||
    !validArtifactBinding(value.artifact) ||
    !validRuntimeBinding(value.runtime) ||
    !validPlistBinding(value.legacyPlist) ||
    (value.nextPlist !== undefined && !validPlistBinding(value.nextPlist)) ||
    !validWatermark(value.nextDbBefore) ||
    !validWatermark(value.legacyDb) ||
    (value.nextDbAtRollback !== undefined && !validWatermark(value.nextDbAtRollback)) ||
    value.reverseMerged !== false ||
    typeof value.preparedAt !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    ((value.status === 'active_next' ||
      value.status === 'rollback_ambiguous' ||
      value.status === 'rolled_back') &&
      value.nextPlist === undefined) ||
    (value.status === 'preparing' && value.nextPlist !== undefined)
  ) {
    throw new Error(`invalid authority receipt: ${path}`);
  }
}
