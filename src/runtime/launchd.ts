import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { createConnection } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { atomicWrite } from '../echo-home/adapters/atomic-write.js';
import type { ContextRuntimeConfig } from './config.js';
import { ECHO_CONTEXT_VERSION } from '../version.js';
import { inspectSchemaCompatibility } from '../storage/migrate.js';
import {
  authorityReceiptPath,
  createAuthorityReceipt,
  readAuthorityReceipt,
  readDatabaseWatermark,
  sha256File,
  writeAuthorityReceipt,
  type AuthorityArtifactBinding,
  type AuthorityPlistBinding,
  type AuthorityReceipt,
} from './authority-receipt.js';
import {
  databaseIdentityDigest,
} from './artifact-identity.js';
import { verifyPromotionReceipt } from './promotion-receipt.js';
import { acquirePidLock } from './pid-lock.js';
import { assertCopyContainsCurrentLegacy } from '../migration/copy-lineage.js';

export const DEFAULT_LAUNCHD_LABEL = 'com.echo.context';
export const REQUIRED_AUTHORITY_SAMPLES = 3;

export function advanceAuthorityAcceptanceWindow(
  previousConsecutive: number,
  accepted: boolean,
): number {
  return accepted ? Math.min(previousConsecutive + 1, REQUIRED_AUTHORITY_SAMPLES) : 0;
}

export interface PreparingRecoveryAuthoritySample {
  nextLoaded: boolean;
  nextRunning: boolean;
  nextPid: number | null;
  legacyRunning: boolean;
  legacyPid: number | null;
  listenerOwnerPids: ReadonlySet<number>;
  endpointHealthy: boolean;
  endpointReachable: boolean;
}

/** A `preparing` receipt predates candidate startup. Its next-stop proof may
 * coexist with the preserved legacy process on the shared port. Accept only
 * an absent next label plus either a genuinely unowned endpoint or the
 * positively identified, healthy legacy PID as the sole listener. */
export function preparingRecoveryAuthorityAccepted(
  sample: PreparingRecoveryAuthoritySample,
): boolean {
  const nextAbsent =
    !sample.nextLoaded && !sample.nextRunning && sample.nextPid === null;
  const endpointUnowned =
    sample.listenerOwnerPids.size === 0 && !sample.endpointReachable;
  const legacyIsSoleHealthyOwner =
    sample.legacyRunning &&
    sample.legacyPid !== null &&
    sample.listenerOwnerPids.size === 1 &&
    sample.listenerOwnerPids.has(sample.legacyPid) &&
    sample.endpointHealthy &&
    sample.endpointReachable;
  return nextAbsent && (endpointUnowned || legacyIsSoleHealthyOwner);
}

/** One per-user lock serializes every launchd authority mutation, even when
 * competing commands point at different candidate homes. */
export function acquireAuthorityOperationLock(
  root = join(homedir(), '.echo-context-authority'),
): ReturnType<typeof acquirePidLock> {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(root, 0o700);
  return acquirePidLock(join(root, 'authority-operation.pid'));
}

export interface LaunchdInstallOptions {
  label?: string;
  replace?: boolean;
  start?: boolean;
  cliPath: string;
  /** Reviewed package-manifest digest emitted by the exact-artifact smoke. */
  expectedArtifactDigest: string;
  /** SHA-256 of the exact reviewed promotion receipt bytes. */
  expectedPromotionReceiptDigest: string;
  config: ContextRuntimeConfig;
  healthTimeoutMs?: number;
  /** Internal transaction seam: cutover owns legacy restoration itself. */
  restorePreviousOnFailure?: boolean;
}

export interface LaunchdInstallResult {
  label: string;
  plistPath: string;
  started: boolean;
  instanceNonce: string;
  artifactDigest: string;
  promotionReceiptDigest: string;
  databaseDigest: string;
}

export interface LaunchdCutoverOptions extends LaunchdInstallOptions {
  legacyLabel: string;
  legacyDbPath: string;
}

export interface LaunchdCutoverResult extends LaunchdInstallResult {
  legacyLabel: string;
  rollbackPlistPath: string;
  authorityReceiptPath: string;
}

export interface LaunchdRollbackOptions {
  legacyLabel: string;
  nextLabel?: string;
  cliPath: string;
  expectedArtifactDigest: string;
  expectedPromotionReceiptDigest: string;
  config: ContextRuntimeConfig;
  healthTimeoutMs?: number;
}

export interface LaunchdRecoverOptions {
  cliPath: string;
  expectedArtifactDigest: string;
  expectedPromotionReceiptDigest: string;
  config: ContextRuntimeConfig;
  healthTimeoutMs?: number;
}

export interface AuthorityTransferOps {
  stopLegacy: () => void | Promise<void>;
  startNext: () => void | Promise<void>;
  stopNext: () => void | Promise<void>;
  restoreLegacy: () => void | Promise<void>;
  verifyLegacy: () => void | Promise<void>;
}

export interface AuthorityRollbackOps {
  stopNext: () => void | Promise<void>;
  startLegacy: () => void | Promise<void>;
  verifyLegacy: () => void | Promise<void>;
  stopLegacy: () => void | Promise<void>;
  startNext: () => void | Promise<void>;
  verifyNext: () => void | Promise<void>;
}

export interface AuthorityRecoveryOps {
  stopNext: () => void | Promise<void>;
  restoreLegacy: () => void | Promise<void>;
  verifyLegacy: () => void | Promise<void>;
  stopLegacy: () => void | Promise<void>;
}

export interface ConfirmedStopOps<T> {
  requestStop: () => void | Promise<void>;
  verifyStopped: () => void | Promise<void>;
  afterStopped: () => T | Promise<T>;
}

/** Serialize stop request, bounded stop proof, then the parity/watermark read. */
export async function executeConfirmedStop<T>(ops: ConfirmedStopOps<T>): Promise<T> {
  await ops.requestStop();
  await ops.verifyStopped();
  return ops.afterStopped();
}

export type AcceptedAuthority = 'legacy' | 'next' | 'ambiguous';

/** Machine-readable transaction failure. Callers must persist a terminal
 * receipt only for a positively accepted authority. */
export class AuthorityTransactionError extends Error {
  readonly operation: 'cutover' | 'rollback' | 'recover';
  readonly acceptedAuthority: AcceptedAuthority;
  readonly failedPhase: string;

  constructor(input: {
    operation: 'cutover' | 'rollback' | 'recover';
    acceptedAuthority: AcceptedAuthority;
    failedPhase: string;
    message: string;
  }) {
    super(input.message);
    this.name = 'AuthorityTransactionError';
    this.operation = input.operation;
    this.acceptedAuthority = input.acceptedAuthority;
    this.failedPhase = input.failedPhase;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function transactionError(
  operation: AuthorityTransactionError['operation'],
  acceptedAuthority: AcceptedAuthority,
  failedPhase: string,
  message: string,
): AuthorityTransactionError {
  return new AuthorityTransactionError({
    operation,
    acceptedAuthority,
    failedPhase,
    message,
  });
}

/**
 * One owner controls authority transfer. A failed candidate is confirmed
 * stopped before the recorded legacy state is restored, preventing two port
 * owners while preserving an initially stopped legacy service.
 */
export async function executeAuthorityTransfer(
  ops: AuthorityTransferOps,
): Promise<void> {
  try {
    await ops.stopLegacy();
  } catch (primary) {
    try {
      await ops.restoreLegacy();
      await ops.verifyLegacy();
    } catch (restoreErr) {
      throw transactionError(
        'cutover',
        'ambiguous',
        'stop_legacy',
        `${errorMessage(primary)}; legacy stop was ambiguous and restoration failed: ` +
          errorMessage(restoreErr),
      );
    }
    throw transactionError(
      'cutover',
      'legacy',
      'stop_legacy',
      `${errorMessage(primary)}; legacy stop failed and legacy was re-verified`,
    );
  }
  try {
    await ops.startNext();
  } catch (primary) {
    try {
      await ops.stopNext();
    } catch (stopErr) {
      throw transactionError(
        'cutover',
        'ambiguous',
        'stop_rejected_next',
        `${errorMessage(primary)}; candidate stop failed, so legacy state was not restored: ` +
          errorMessage(stopErr),
      );
    }
    try {
      await ops.restoreLegacy();
      await ops.verifyLegacy();
    } catch (restoreErr) {
      throw transactionError(
        'cutover',
        'ambiguous',
        'restore_legacy',
        `${errorMessage(primary)}; legacy restoration failed: ${errorMessage(restoreErr)}`,
      );
    }
    throw transactionError(
      'cutover',
      'legacy',
      'start_next',
      errorMessage(primary),
    );
  }
}

/**
 * Reverting is also transactional: if legacy acceptance fails, stop it and
 * restore the exact next service. A successful return always means legacy is
 * the sole accepted authority.
 */
export async function executeAuthorityRollback(
  ops: AuthorityRollbackOps,
): Promise<void> {
  try {
    await ops.stopNext();
  } catch (primary) {
    try {
      await ops.startNext();
      await ops.verifyNext();
    } catch (restoreErr) {
      throw transactionError(
        'rollback',
        'ambiguous',
        'stop_next',
        `${errorMessage(primary)}; next stop was ambiguous and exact-next restoration failed: ` +
          errorMessage(restoreErr),
      );
    }
    throw transactionError(
      'rollback',
      'next',
      'stop_next',
      `${errorMessage(primary)}; rollback was not attempted and next authority was re-verified`,
    );
  }
  try {
    await ops.startLegacy();
    await ops.verifyLegacy();
  } catch (primary) {
    try {
      await ops.stopLegacy();
    } catch (stopErr) {
      throw transactionError(
        'rollback',
        'ambiguous',
        'stop_rejected_legacy',
        `${errorMessage(primary)}; failed to stop rejected legacy service, so next was not ` +
          `started: ${errorMessage(stopErr)}`,
      );
    }
    try {
      await ops.startNext();
      await ops.verifyNext();
    } catch (restoreErr) {
      throw transactionError(
        'rollback',
        'ambiguous',
        'restore_next',
        `${errorMessage(primary)}; restoring the exact next service also failed: ` +
          errorMessage(restoreErr),
      );
    }
    throw transactionError(
      'rollback',
      'next',
      'accept_legacy',
      `${errorMessage(primary)}; rollback aborted and next authority was restored`,
    );
  }
}

/** Converge an interrupted transaction on the preserved legacy authority. */
export async function executeAuthorityRecovery(
  ops: AuthorityRecoveryOps,
): Promise<void> {
  try {
    await ops.stopNext();
  } catch (err) {
    throw transactionError(
      'recover',
      'ambiguous',
      'stop_next',
      `candidate stop could not be confirmed; legacy state was not restored: ${errorMessage(err)}`,
    );
  }
  try {
    await ops.restoreLegacy();
    await ops.verifyLegacy();
  } catch (primary) {
    try {
      await ops.stopLegacy();
    } catch (stopErr) {
      throw transactionError(
        'recover',
        'ambiguous',
        'stop_rejected_legacy',
        `${errorMessage(primary)}; rejected legacy stop was also ambiguous: ` +
          errorMessage(stopErr),
      );
    }
    throw transactionError(
      'recover',
      'ambiguous',
      'accept_legacy',
      `${errorMessage(primary)}; legacy could not be accepted and was stopped`,
    );
  }
}

function assertLabel(label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(label)) {
    throw new Error(`invalid launchd label: ${label}`);
  }
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

interface LaunchIdentity {
  instanceNonce: string;
  artifactDigest: string;
  promotionReceiptDigest: string;
  databaseDigest: string;
}

function verifyExpectedArtifact(
  cliPath: string,
  expectedArtifactDigest: string,
  expectedPromotionReceiptDigest: string,
): AuthorityArtifactBinding {
  const cliRealpath = realpathSync(cliPath);
  const verified = verifyPromotionReceipt({
    startPath: cliRealpath,
    cliPath: cliRealpath,
    expectedArtifactDigest,
    expectedPromotionReceiptDigest,
  });
  return {
    expectedDigest: expectedArtifactDigest,
    verifiedDigest: verified.receipt.artifactDigest,
    expectedPromotionReceiptDigest,
    verifiedPromotionReceiptDigest: verified.receiptDigest,
    promotionReceiptPath: realpathSync(verified.receiptPath),
    installedTreeDigest: verified.installedTree.digest,
    nodeExecutableRealpath: verified.receipt.nodeExecutable,
    sourceCommit: verified.receipt.sourceCommit,
    cliRealpath,
    packageRootRealpath: verified.receipt.packageRoot,
  };
}

function createLaunchIdentity(
  cliPath: string,
  dbPath: string,
  expectedArtifactDigest: string,
  expectedPromotionReceiptDigest: string,
): LaunchIdentity {
  const verified = verifyExpectedArtifact(
    cliPath,
    expectedArtifactDigest,
    expectedPromotionReceiptDigest,
  );
  return {
    instanceNonce: randomUUID(),
    artifactDigest: verified.verifiedDigest,
    promotionReceiptDigest: verified.verifiedPromotionReceiptDigest,
    databaseDigest: databaseIdentityDigest(dbPath),
  };
}

function plistBinding(path: string): AuthorityPlistBinding {
  return { path: realpathSync(path), sha256: sha256File(path) };
}

function assertInstalledPlistMatches(
  binding: AuthorityPlistBinding,
  label: string,
  cliPath: string,
  config: ContextRuntimeConfig,
  identity: LaunchIdentity,
): void {
  const expected = renderLaunchdPlist(label, cliPath, withLaunchIdentity(config, identity));
  const expectedSha256 = createHash('sha256').update(expected).digest('hex');
  if (binding.sha256 !== expectedSha256) {
    throw new Error('installed next plist does not match the accepted launch configuration');
  }
}

function assertPlistBinding(binding: AuthorityPlistBinding, description: string): void {
  if (!existsSync(binding.path) || realpathSync(binding.path) !== binding.path) {
    throw new Error(`${description} plist path no longer resolves to the recorded file`);
  }
  if (sha256File(binding.path) !== binding.sha256) {
    throw new Error(`${description} plist changed after authority preparation`);
  }
}

function assertArtifactBinding(
  binding: AuthorityArtifactBinding,
  cliPath: string,
  expectedArtifactDigest: string,
  expectedPromotionReceiptDigest: string,
): void {
  const current = verifyExpectedArtifact(
    cliPath,
    expectedArtifactDigest,
    expectedPromotionReceiptDigest,
  );
  if (
    binding.expectedDigest !== current.expectedDigest ||
    binding.verifiedDigest !== current.verifiedDigest ||
    binding.expectedPromotionReceiptDigest !==
      current.expectedPromotionReceiptDigest ||
    binding.verifiedPromotionReceiptDigest !==
      current.verifiedPromotionReceiptDigest ||
    binding.promotionReceiptPath !== current.promotionReceiptPath ||
    binding.installedTreeDigest !== current.installedTreeDigest ||
    binding.nodeExecutableRealpath !== current.nodeExecutableRealpath ||
    binding.sourceCommit !== current.sourceCommit ||
    binding.cliRealpath !== current.cliRealpath ||
    binding.packageRootRealpath !== current.packageRootRealpath
  ) {
    throw new Error('current CLI artifact does not match the recorded authority artifact');
  }
}

function assertDatabaseBinding(path: string, expectedDigest: string, description: string): void {
  if (databaseIdentityDigest(path) !== expectedDigest) {
    throw new Error(`${description} database identity no longer matches the authority receipt`);
  }
}

function withLaunchIdentity(
  config: ContextRuntimeConfig,
  identity: LaunchIdentity,
): ContextRuntimeConfig {
  return {
    ...config,
    identity: { ...identity },
  };
}

function readLaunchIdentity(plistPath: string): LaunchIdentity {
  const raw = readFileSync(plistPath, 'utf8');
  const valueAfter = (key: string): string => {
    const pattern = new RegExp(
      `<key>${key}</key>\\s*<string>([A-Za-z0-9-]+)</string>`,
    );
    const value = pattern.exec(raw)?.[1];
    if (value === undefined) {
      throw new Error(`launchd plist is missing exact identity key ${key}: ${plistPath}`);
    }
    return value;
  };
  return {
    instanceNonce: valueAfter('ECHO_CONTEXT_INSTANCE_NONCE'),
    artifactDigest: valueAfter('ECHO_CONTEXT_ARTIFACT_DIGEST'),
    promotionReceiptDigest: valueAfter(
      'ECHO_CONTEXT_PROMOTION_RECEIPT_DIGEST',
    ),
    databaseDigest: valueAfter('ECHO_CONTEXT_DATABASE_DIGEST'),
  };
}

function launchDomain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('launchd installation requires macOS');
  return `gui/${uid}`;
}

function plistPathForLabel(label: string): string {
  assertLabel(label);
  return join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
}

function runLaunchctl(args: string[], allowMissing = false): void {
  const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
  if (result.status === 0) return;
  const detail = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
  if (allowMissing && /could not find service|no such process|not found/i.test(detail)) return;
  throw new Error(`launchctl ${args[0] ?? ''} failed${detail.length > 0 ? `: ${detail}` : ''}`);
}

/** Load a launchd definition and explicitly request its first run. RunAtLoad
 * is retained as declarative policy, but `bootstrap` alone is not an
 * immediate-start contract on every supported macOS launchd. */
export function bootstrapAndKickstartLaunchdAgent(
  label: string,
  plistPath: string,
  execute: (args: string[]) => void = runLaunchctl,
): void {
  assertLabel(label);
  const domain = launchDomain();
  execute(['bootstrap', domain, plistPath]);
  // Bare kickstart starts a dormant job without killing one that raced to
  // start from RunAtLoad while bootstrap returned.
  execute(['kickstart', `${domain}/${label}`]);
}

async function ensureLaunchdAgentStarted(
  label: string,
  plistPath: string,
  config: ContextRuntimeConfig,
  timeoutMs: number,
): Promise<void> {
  if (serviceIsRunning(label)) return;
  await stopLaunchdAgentAndWait(label, config, timeoutMs);
  bootstrapAndKickstartLaunchdAgent(label, plistPath);
}

function assertPlistValid(content: string): void {
  const result = spawnSync('/usr/bin/plutil', ['-lint', '-'], {
    input: content,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`generated launchd plist is invalid: ${result.stderr || result.stdout}`);
  }
}

function assertContextDatabase(path: string): void {
  if (!existsSync(path)) {
    throw new Error(`context database does not exist: ${path} (run echo-context migrate first)`);
  }
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const migrationsDir = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'storage',
      'migrations',
    );
    const compatibility = inspectSchemaCompatibility(db, migrationsDir);
    if (!compatibility.compatible) {
      throw new Error(
        `context database schema ${compatibility.current_version} is newer than supported ` +
          `${compatibility.latest_supported_version}`,
      );
    }
    if (compatibility.current_version !== compatibility.latest_supported_version) {
      throw new Error(
        `context database schema ${compatibility.current_version} is not fully migrated to ` +
          `${compatibility.latest_supported_version} (run echo-context migrate)`,
      );
    }
    const events = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'")
      .get();
    if (events === undefined) throw new Error('context database has no events table');
    const checkpoints = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='capture_checkpoints'")
      .get();
    if (checkpoints === undefined) {
      throw new Error('context database has not completed the capture-checkpoint migration');
    }
    const lineage = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='context_copy_lineage'")
      .get();
    if (lineage === undefined) {
      throw new Error('context database was not created by echo-context migrate');
    }
    const result = db.pragma('quick_check') as Array<{ quick_check: string }>;
    if (result.length !== 1 || result[0]?.quick_check !== 'ok') {
      throw new Error('context database failed SQLite quick_check');
    }
  } finally {
    db.close();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function launchdProcess(
  label: string,
): { loaded: boolean; running: boolean; pid: number | null } {
  const result = spawnSync(
    '/bin/launchctl',
    ['print', `${launchDomain()}/${label}`],
    { encoding: 'utf8' },
  );
  if (result.error !== undefined) {
    throw new Error(`could not inspect launchd service ${label}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
    if (/could not find service|no such process|not found/i.test(detail)) {
      return { loaded: false, running: false, pid: null };
    }
    throw new Error(
      `could not establish launchd service state for ${label}` +
        (detail.length > 0 ? `: ${detail}` : ''),
    );
  }
  const output = result.stdout ?? '';
  const pidRaw = /\bpid\s*=\s*(\d+)\b/.exec(output)?.[1];
  return {
    loaded: true,
    running: /\bstate\s*=\s*running\b/.test(output),
    pid: pidRaw === undefined ? null : Number(pidRaw),
  };
}

function serviceIsRunning(label: string): boolean {
  return launchdProcess(label).running;
}

function listeningSocketOwnerPids(port: number): ReadonlySet<number> {
  const result = spawnSync(
    '/usr/sbin/lsof',
    ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'],
    { encoding: 'utf8' },
  );
  if (result.error !== undefined) {
    throw new Error(`could not inspect TCP listener ownership: ${result.error.message}`);
  }
  const pids = new Set(
    (result.stdout ?? '')
      .split('\n')
      .filter((line) => /^p\d+$/.test(line))
      .map((line) => Number(line.slice(1))),
  );
  if (result.status === 0) return pids;
  if (result.status === 1 && pids.size === 0 && (result.stderr ?? '').trim() === '') {
    return pids;
  }
  throw new Error('could not establish TCP listener ownership');
}

function pidOwnsListeningSocket(pid: number, port: number): boolean {
  return listeningSocketOwnerPids(port).has(pid);
}

function canConnect(host: string, port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const settle = (connected: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe(connected);
    };
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    socket.setTimeout(timeoutMs, () => settle(false));
  });
}

async function endpointReportsHealthy(config: ContextRuntimeConfig): Promise<boolean> {
  try {
    const host = config.host === '::1' ? '[::1]' : config.host;
    const response = await fetch(`http://${host}:${config.port}/healthz`, {
      signal: AbortSignal.timeout(2_000),
    });
    const body = (await response.json()) as { status?: unknown };
    return response.ok && (body.status === 'healthy' || body.status === 'ok');
  } catch {
    return false;
  }
}

async function waitForLegacyAuthority(
  label: string,
  expectedPlist: AuthorityPlistBinding,
  config: ContextRuntimeConfig,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let consecutive = 0;
  while (Date.now() < deadline) {
    assertPlistBinding(expectedPlist, 'legacy');
    const endpointHealthy = await endpointReportsHealthy(config);
    const process = launchdProcess(label);
    const accepted =
      process.running &&
      process.pid !== null &&
      pidOwnsListeningSocket(process.pid, config.port) &&
      endpointHealthy &&
      (await canConnect(config.host, config.port));
    consecutive = advanceAuthorityAcceptanceWindow(consecutive, accepted);
    if (consecutive >= REQUIRED_AUTHORITY_SAMPLES) return;
    await delay(500);
  }
  throw new Error(
    `legacy launch agent ${label} did not remain running and reachable on ` +
      `${config.host}:${config.port}`,
  );
}

async function waitForPreparingNextStopped(
  nextLabel: string,
  legacyLabel: string,
  expectedLegacyPlist: AuthorityPlistBinding,
  config: ContextRuntimeConfig,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let consecutive = 0;
  while (Date.now() < deadline) {
    assertPlistBinding(expectedLegacyPlist, 'legacy');
    const next = launchdProcess(nextLabel);
    const legacy = launchdProcess(legacyLabel);
    const listenerOwnerPids = listeningSocketOwnerPids(config.port);
    const endpointHealthy = await endpointReportsHealthy(config);
    const endpointReachable = await canConnect(config.host, config.port);
    const accepted = preparingRecoveryAuthorityAccepted({
      nextLoaded: next.loaded,
      nextRunning: next.running,
      nextPid: next.pid,
      legacyRunning: legacy.running,
      legacyPid: legacy.pid,
      listenerOwnerPids,
      endpointHealthy,
      endpointReachable,
    });
    consecutive = advanceAuthorityAcceptanceWindow(consecutive, accepted);
    if (consecutive >= REQUIRED_AUTHORITY_SAMPLES) return;
    await delay(500);
  }
  throw new Error(
    `launch agent ${nextLabel} was not proven absent while either the endpoint was unowned ` +
      `or recorded legacy ${legacyLabel} was its sole healthy owner at ` +
      `${config.host}:${config.port}`,
  );
}

async function waitForStoppedEndpoint(
  label: string,
  expectedPlist: AuthorityPlistBinding | undefined,
  config: ContextRuntimeConfig,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let consecutive = 0;
  while (Date.now() < deadline) {
    if (expectedPlist !== undefined) assertPlistBinding(expectedPlist, label);
    const process = launchdProcess(label);
    const stoppedAndUnowned =
      !process.running &&
      process.pid === null &&
      listeningSocketOwnerPids(config.port).size === 0 &&
      !(await canConnect(config.host, config.port));
    consecutive = advanceAuthorityAcceptanceWindow(consecutive, stoppedAndUnowned);
    if (consecutive >= REQUIRED_AUTHORITY_SAMPLES) return;
    await delay(500);
  }
  throw new Error(
    `launch agent ${label} did not remain stopped with an unowned endpoint at ` +
      `${config.host}:${config.port}`,
  );
}

function waitForLegacyStoppedState(
  label: string,
  expectedPlist: AuthorityPlistBinding,
  config: ContextRuntimeConfig,
  timeoutMs: number,
): Promise<void> {
  return waitForStoppedEndpoint(label, expectedPlist, config, timeoutMs);
}

async function waitForExactHealth(
  label: string,
  config: ContextRuntimeConfig,
  timeoutMs: number,
): Promise<void> {
  const expected = config.identity;
  if (
    expected.instanceNonce === null ||
    expected.artifactDigest === null ||
    expected.promotionReceiptDigest === null ||
    expected.databaseDigest === null
  ) {
    throw new Error('exact-health acceptance requires launch identity fields');
  }
  const host = config.host === '::1' ? '[::1]' : config.host;
  const url = `http://${host}:${config.port}/healthz`;
  const deadline = Date.now() + timeoutMs;
  let last = 'not reachable';
  let consecutive = 0;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      const body = (await response.json()) as {
        status?: unknown;
        components?: {
          runtime?: {
            details?: {
              version?: unknown;
              instance_nonce?: unknown;
              artifact_digest?: unknown;
              promotion_receipt_digest?: unknown;
              database_digest?: unknown;
            };
          };
        };
      };
      const details = body.components?.runtime?.details;
      const exact =
        details?.version === ECHO_CONTEXT_VERSION &&
        details.instance_nonce === expected.instanceNonce &&
        details.artifact_digest === expected.artifactDigest &&
        details.promotion_receipt_digest ===
          expected.promotionReceiptDigest &&
        details.database_digest === expected.databaseDigest;
      const process = launchdProcess(label);
      const launchdAccepted =
        process.running &&
        process.pid !== null &&
        pidOwnsListeningSocket(process.pid, config.port);
      const accepted = response.ok && body.status === 'healthy' && exact && launchdAccepted;
      consecutive = advanceAuthorityAcceptanceWindow(consecutive, accepted);
      if (consecutive >= REQUIRED_AUTHORITY_SAMPLES) return;
      last =
        `HTTP ${response.status}, status=${String(body.status)}, ` +
        `version=${String(details?.version)}, exact_identity=${String(exact)}, ` +
        `launchd_socket_owner=${String(launchdAccepted)}`;
    } catch (err) {
      consecutive = 0;
      last = (err as Error).message;
    }
    await delay(250);
  }
  throw new Error(`echo-context did not become exact-artifact healthy at ${url}: ${last}`);
}

function environmentEntries(config: ContextRuntimeConfig): Array<[string, string]> {
  const entries: Array<[string, string]> = [
    ['ECHO_CONTEXT_HOME', config.home],
    ['ECHO_CONTEXT_DATA_DIR', config.dataDir],
    ['ECHO_CONTEXT_DB_PATH', config.dbPath],
    ['ECHO_CONTEXT_HOST', config.host],
    ['ECHO_CONTEXT_PORT', String(config.port)],
    ['ECHO_CONTEXT_CAPTURE_CODEX', String(config.capture.codex)],
    ['ECHO_CONTEXT_CAPTURE_CLAUDE', String(config.capture.claudeCode)],
    ['ECHO_CONTEXT_CAPTURE_CURSOR', String(config.capture.cursor)],
    ['ECHO_CONTEXT_CODEX_SESSIONS_DIR', config.capture.codexSessionsDir],
    ['ECHO_CONTEXT_CLAUDE_PROJECTS_DIR', config.capture.claudeProjectsDir],
    ['ECHO_CONTEXT_CURSOR_GLOBAL_DB', config.capture.cursorGlobalDb],
    ['ECHO_CONTEXT_CURSOR_WORKSPACE_DIR', config.capture.cursorWorkspaceDir],
  ];
  if (config.identity.instanceNonce !== null) {
    entries.push(['ECHO_CONTEXT_INSTANCE_NONCE', config.identity.instanceNonce]);
  }
  if (config.identity.artifactDigest !== null) {
    entries.push(['ECHO_CONTEXT_ARTIFACT_DIGEST', config.identity.artifactDigest]);
  }
  if (config.identity.promotionReceiptDigest !== null) {
    entries.push([
      'ECHO_CONTEXT_PROMOTION_RECEIPT_DIGEST',
      config.identity.promotionReceiptDigest,
    ]);
  }
  if (config.identity.databaseDigest !== null) {
    entries.push(['ECHO_CONTEXT_DATABASE_DIGEST', config.identity.databaseDigest]);
  }
  return entries;
}

export function renderLaunchdPlist(
  label: string,
  cliPath: string,
  config: ContextRuntimeConfig,
): string {
  assertLabel(label);
  const envXml = environmentEntries(config)
    .map(([key, value]) => `      <key>${xml(key)}</key>\n      <string>${xml(value)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xml(label)}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xml(realpathSync(process.execPath))}</string>
      <string>${xml(realpathSync(cliPath))}</string>
      <string>daemon</string>
      <string>run</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(config.home)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <!-- launchd file descriptors are never rotated safely in-process. Runtime
         state is exposed through /healthz, so prevent unbounded local logs. -->
    <key>StandardOutPath</key>
    <string>/dev/null</string>
    <key>StandardErrorPath</key>
    <string>/dev/null</string>
  </dict>
</plist>
`;
}

async function installLaunchdAgentUnlocked(
  options: LaunchdInstallOptions,
): Promise<LaunchdInstallResult> {
  const label = options.label ?? DEFAULT_LAUNCHD_LABEL;
  assertLabel(label);
  const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  if (existsSync(plistPath) && options.replace !== true) {
    throw new Error(`launch agent already exists: ${plistPath} (pass --replace to replace it)`);
  }
  if (!existsSync(options.cliPath)) throw new Error(`installed CLI entry does not exist: ${options.cliPath}`);
  assertContextDatabase(options.config.dbPath);
  const identity = createLaunchIdentity(
    options.cliPath,
    options.config.dbPath,
    options.expectedArtifactDigest,
    options.expectedPromotionReceiptDigest,
  );
  const launchConfig = withLaunchIdentity(options.config, identity);

  mkdirSync(dirname(plistPath), { recursive: true });
  mkdirSync(options.config.home, { recursive: true });
  const previousPlist = existsSync(plistPath) ? readFileSync(plistPath, 'utf8') : null;
  const nextPlist = renderLaunchdPlist(label, options.cliPath, launchConfig);
  assertPlistValid(nextPlist);

  const start = options.start ?? true;
  const authorityStopTimeoutMs = Math.min(options.healthTimeoutMs ?? 30_000, 30_000);
  try {
    if (previousPlist !== null && options.replace === true) {
      await stopLaunchdAgentAndWait(label, options.config, authorityStopTimeoutMs);
    }
    atomicWrite({ filePath: plistPath, content: nextPlist, secretSensitive: true });
    if (start) {
      bootstrapAndKickstartLaunchdAgent(label, plistPath);
      await waitForExactHealth(label, launchConfig, options.healthTimeoutMs ?? 300_000);
    }
    return { label, plistPath, started: start, ...identity };
  } catch (err) {
    const recoveryErrors: string[] = [];
    let candidateStopped = false;
    try {
      await stopLaunchdAgentAndWait(label, options.config, authorityStopTimeoutMs);
      candidateStopped = true;
    } catch (recoveryErr) {
      recoveryErrors.push(`candidate bootout: ${errorMessage(recoveryErr)}`);
    }
    if (candidateStopped) {
      try {
        if (previousPlist !== null) {
          atomicWrite({ filePath: plistPath, content: previousPlist, secretSensitive: true });
          if (start && options.restorePreviousOnFailure !== false) {
            await ensureLaunchdAgentStarted(
              label,
              plistPath,
              options.config,
              authorityStopTimeoutMs,
            );
          }
        } else if (existsSync(plistPath)) {
          unlinkSync(plistPath);
        }
      } catch (recoveryErr) {
        recoveryErrors.push(`plist restoration: ${errorMessage(recoveryErr)}`);
      }
    }
    if (recoveryErrors.length > 0) {
      throw new Error(
        `${errorMessage(err)}; install rollback failed: ${recoveryErrors.join('; ')}`,
      );
    }
    throw err;
  }
}

export async function installLaunchdAgent(
  options: LaunchdInstallOptions,
): Promise<LaunchdInstallResult> {
  const operationLock = acquireAuthorityOperationLock();
  try {
    return await installLaunchdAgentUnlocked(options);
  } finally {
    operationLock.release();
  }
}

function readLaunchdEndpoint(plistPath: string): { host: string; port: number } {
  const raw = readFileSync(plistPath, 'utf8');
  const stringValue = (key: string): string | undefined =>
    new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`).exec(raw)?.[1];
  const host = stringValue('ECHO_CONTEXT_HOST');
  const port = Number(stringValue('ECHO_CONTEXT_PORT'));
  if (
    (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error(`launchd plist has no valid loopback endpoint: ${plistPath}`);
  }
  return { host, port };
}

function waitForStoppedEndpointSync(
  label: string,
  endpoint: { host: string; port: number },
  timeoutMs: number,
): void {
  const deadline = Date.now() + timeoutMs;
  let consecutive = 0;
  while (Date.now() < deadline) {
    const process = launchdProcess(label);
    const stoppedAndUnowned =
      !process.running &&
      process.pid === null &&
      listeningSocketOwnerPids(endpoint.port).size === 0;
    consecutive = advanceAuthorityAcceptanceWindow(consecutive, stoppedAndUnowned);
    if (consecutive >= REQUIRED_AUTHORITY_SAMPLES) return;
    const wait = spawnSync('/bin/sleep', ['0.5'], { encoding: 'utf8' });
    if (wait.status !== 0) throw new Error('could not wait for launchd stop confirmation');
  }
  throw new Error(
    `launch agent ${label} did not remain stopped with an unowned endpoint at ` +
      `${endpoint.host}:${endpoint.port}`,
  );
}

function uninstallLaunchdAgentUnlocked(label = DEFAULT_LAUNCHD_LABEL): string {
  assertLabel(label);
  const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  if (existsSync(plistPath)) {
    const endpoint = readLaunchdEndpoint(plistPath);
    requestLaunchdStop(label);
    waitForStoppedEndpointSync(label, endpoint, 30_000);
    unlinkSync(plistPath);
  }
  return plistPath;
}

export function uninstallLaunchdAgent(label = DEFAULT_LAUNCHD_LABEL): string {
  const operationLock = acquireAuthorityOperationLock();
  try {
    return uninstallLaunchdAgentUnlocked(label);
  } finally {
    operationLock.release();
  }
}

function receiptRuntime(config: ContextRuntimeConfig): AuthorityReceipt['runtime'] {
  return {
    home: resolve(config.home),
    dbPath: realpathSync(config.dbPath),
    host: config.host,
    port: config.port,
  };
}

function assertReceiptRuntime(
  receipt: AuthorityReceipt,
  config: ContextRuntimeConfig,
): void {
  if (
    receipt.runtime.home !== resolve(config.home) ||
    receipt.runtime.dbPath !== realpathSync(config.dbPath) ||
    receipt.runtime.host !== config.host ||
    receipt.runtime.port !== config.port
  ) {
    throw new Error(
      'runtime home, database, host, and port must match the recorded accepted endpoint',
    );
  }
}

function configForReceipt(
  config: ContextRuntimeConfig,
  receipt: AuthorityReceipt,
): ContextRuntimeConfig {
  return {
    ...config,
    home: receipt.runtime.home,
    dbPath: receipt.runtime.dbPath,
    host: receipt.runtime.host,
    port: receipt.runtime.port,
  };
}

function assertReceiptBindings(input: {
  receipt: AuthorityReceipt;
  cliPath: string;
  expectedArtifactDigest: string;
  expectedPromotionReceiptDigest: string;
  legacyPlistPath: string;
  nextPlistPath?: string;
}): void {
  const { receipt } = input;
  assertArtifactBinding(
    receipt.artifact,
    input.cliPath,
    input.expectedArtifactDigest,
    input.expectedPromotionReceiptDigest,
  );
  assertPlistBinding(receipt.legacyPlist, 'legacy');
  if (receipt.legacyPlist.path !== realpathSync(input.legacyPlistPath)) {
    throw new Error('legacy plist path does not match the authority receipt');
  }
  assertDatabaseBinding(receipt.legacyDb.path, receipt.legacyDb.identityDigest, 'legacy');
  assertDatabaseBinding(
    receipt.nextDbBefore.path,
    receipt.nextDbBefore.identityDigest,
    'next',
  );
  if (receipt.runtime.dbPath !== receipt.nextDbBefore.path) {
    throw new Error('recorded runtime database does not match the prepared next database');
  }
  if (receipt.nextPlist !== undefined) {
    assertPlistBinding(receipt.nextPlist, 'next');
    if (
      input.nextPlistPath !== undefined &&
      receipt.nextPlist.path !== realpathSync(input.nextPlistPath)
    ) {
      throw new Error('next plist path does not match the authority receipt');
    }
    const identity = readLaunchIdentity(receipt.nextPlist.path);
    if (
      identity.artifactDigest !== receipt.artifact.verifiedDigest ||
      identity.promotionReceiptDigest !==
        receipt.artifact.verifiedPromotionReceiptDigest ||
      identity.databaseDigest !== receipt.nextDbBefore.identityDigest
    ) {
      throw new Error('next launch identity does not match the authority receipt');
    }
  }
}

function requestLaunchdStop(label: string): void {
  // Target the loaded service identifier, not mutable plist contents.
  runLaunchctl(['bootout', `${launchDomain()}/${label}`], true);
}

function stopLaunchdAgentAndThen<T>(
  label: string,
  config: ContextRuntimeConfig,
  timeoutMs: number,
  afterStopped: () => T | Promise<T>,
): Promise<T> {
  return executeConfirmedStop({
    requestStop: () => requestLaunchdStop(label),
    verifyStopped: () => waitForStoppedEndpoint(label, undefined, config, timeoutMs),
    afterStopped,
  });
}

function stopLaunchdAgentAndWait(
  label: string,
  config: ContextRuntimeConfig,
  timeoutMs: number,
): Promise<void> {
  return stopLaunchdAgentAndThen(label, config, timeoutMs, () => undefined);
}

function stopPreparingNextAndThen<T>(
  nextLabel: string,
  legacyLabel: string,
  legacyPlist: AuthorityPlistBinding,
  config: ContextRuntimeConfig,
  timeoutMs: number,
  afterStopped: () => T | Promise<T>,
): Promise<T> {
  return executeConfirmedStop({
    requestStop: () => requestLaunchdStop(nextLabel),
    verifyStopped: () =>
      waitForPreparingNextStopped(
        nextLabel,
        legacyLabel,
        legacyPlist,
        config,
        timeoutMs,
      ),
    afterStopped,
  });
}

async function restoreRecordedLegacyState(
  initiallyRunning: boolean,
  label: string,
  plistPath: string,
  config: ContextRuntimeConfig,
  timeoutMs: number,
): Promise<void> {
  if (initiallyRunning) {
    await ensureLaunchdAgentStarted(label, plistPath, config, timeoutMs);
  } else {
    await stopLaunchdAgentAndWait(label, config, timeoutMs);
  }
}

function verifyRecordedLegacyState(
  initiallyRunning: boolean,
  label: string,
  plist: AuthorityPlistBinding,
  config: ContextRuntimeConfig,
  timeoutMs: number,
): Promise<void> {
  return initiallyRunning
    ? waitForLegacyAuthority(label, plist, config, timeoutMs)
    : waitForLegacyStoppedState(label, plist, config, timeoutMs);
}

/**
 * Transfer port/runtime authority from a preserved legacy launch agent to the
 * exact echo-context artifact. The legacy plist is never deleted and is
 * restored to its recorded running or stopped state if installation or health
 * acceptance fails.
 */
async function cutoverLaunchdAgentUnlocked(
  options: LaunchdCutoverOptions,
): Promise<LaunchdCutoverResult> {
  const nextLabel = options.label ?? DEFAULT_LAUNCHD_LABEL;
  assertLabel(nextLabel);
  assertLabel(options.legacyLabel);
  if (nextLabel === options.legacyLabel) {
    throw new Error('new and legacy launchd labels must differ');
  }
  const legacyPlistPath = plistPathForLabel(options.legacyLabel);
  if (!existsSync(legacyPlistPath)) {
    throw new Error(`legacy rollback plist does not exist: ${legacyPlistPath}`);
  }
  if (resolve(options.legacyDbPath) === resolve(options.config.dbPath)) {
    throw new Error('legacy and next database paths must differ');
  }
  assertContextDatabase(options.config.dbPath);
  const artifact = verifyExpectedArtifact(
    options.cliPath,
    options.expectedArtifactDigest,
    options.expectedPromotionReceiptDigest,
  );
  const legacyPlist = plistBinding(legacyPlistPath);
  const authorityStopTimeoutMs = Math.min(options.healthTimeoutMs ?? 30_000, 30_000);
  const legacyInitiallyRunning = serviceIsRunning(options.legacyLabel);
  await verifyRecordedLegacyState(
    legacyInitiallyRunning,
    options.legacyLabel,
    legacyPlist,
    options.config,
    authorityStopTimeoutMs,
  );
  let receipt: AuthorityReceipt = createAuthorityReceipt({
    home: options.config.home,
    legacyLabel: options.legacyLabel,
    nextLabel,
    legacyInitiallyRunning,
    artifact,
    runtime: receiptRuntime(options.config),
    legacyPlist,
    legacyDbPath: options.legacyDbPath,
    nextDbPath: options.config.dbPath,
    replaceTerminal: options.replace,
  });

  let installed: LaunchdInstallResult | undefined;
  let receiptPath: string | undefined;
  try {
    await executeAuthorityTransfer({
      stopLegacy: async () => {
        assertReceiptBindings({
          receipt,
          cliPath: options.cliPath,
          expectedArtifactDigest: options.expectedArtifactDigest,
          expectedPromotionReceiptDigest:
            options.expectedPromotionReceiptDigest,
          legacyPlistPath,
        });
        await stopLaunchdAgentAndThen(
          options.legacyLabel,
          options.config,
          authorityStopTimeoutMs,
          () => {
            assertCopyContainsCurrentLegacy(options.legacyDbPath, options.config.dbPath);
            receipt = {
              ...receipt,
              status: 'legacy_stopped',
              legacyDb: readDatabaseWatermark(options.legacyDbPath),
              updatedAt: new Date().toISOString(),
            };
            writeAuthorityReceipt(options.config.home, receipt);
          },
        );
      },
      startNext: async () => {
        assertReceiptBindings({
          receipt,
          cliPath: options.cliPath,
          expectedArtifactDigest: options.expectedArtifactDigest,
          expectedPromotionReceiptDigest:
            options.expectedPromotionReceiptDigest,
          legacyPlistPath,
        });
        installed = await installLaunchdAgentUnlocked({
          ...options,
          label: nextLabel,
          start: true,
          restorePreviousOnFailure: false,
        });
        const nextPlist = plistBinding(installed.plistPath);
        assertInstalledPlistMatches(
          nextPlist,
          nextLabel,
          options.cliPath,
          options.config,
          installed,
        );
        receipt = {
          ...receipt,
          status: 'active_next',
          nextPlist,
          updatedAt: new Date().toISOString(),
          lastError: undefined,
        };
        receiptPath = writeAuthorityReceipt(options.config.home, receipt);
      },
      stopNext: () =>
        stopLaunchdAgentAndWait(nextLabel, options.config, authorityStopTimeoutMs),
      restoreLegacy: () =>
        restoreRecordedLegacyState(
          receipt.legacyInitiallyRunning,
          options.legacyLabel,
          legacyPlistPath,
          options.config,
          authorityStopTimeoutMs,
        ),
      verifyLegacy: () =>
        verifyRecordedLegacyState(
          receipt.legacyInitiallyRunning,
          options.legacyLabel,
          legacyPlist,
          options.config,
          authorityStopTimeoutMs,
        ),
    });
  } catch (err) {
    const acceptance =
      err instanceof AuthorityTransactionError ? err.acceptedAuthority : 'ambiguous';
    receipt = {
      ...receipt,
      status: acceptance === 'legacy' ? 'cutover_failed' : 'cutover_ambiguous',
      updatedAt: new Date().toISOString(),
      lastError: errorMessage(err),
    };
    try {
      writeAuthorityReceipt(options.config.home, receipt);
    } catch (receiptErr) {
      throw transactionError(
        'cutover',
        acceptance,
        'persist_failure_state',
        `${errorMessage(err)}; ${acceptance === 'legacy' ? 'legacy was accepted' : 'authority is ambiguous'} ` +
          `but its receipt could not be written: ${errorMessage(receiptErr)}`,
      );
    }
    throw err;
  }
  if (installed === undefined) {
    throw new Error('authority transfer completed without an installed next agent');
  }
  if (receiptPath === undefined) {
    throw new Error('authority transfer completed without an active receipt');
  }
  return {
    ...installed,
    legacyLabel: options.legacyLabel,
    rollbackPlistPath: legacyPlistPath,
    authorityReceiptPath: receiptPath,
  };
}

export async function cutoverLaunchdAgent(
  options: LaunchdCutoverOptions,
): Promise<LaunchdCutoverResult> {
  const operationLock = acquireAuthorityOperationLock();
  try {
    return await cutoverLaunchdAgentUnlocked(options);
  } finally {
    operationLock.release();
  }
}

/** Revert authority to the preserved legacy plist without deleting either definition. */
async function rollbackLaunchdCutoverUnlocked(
  options: LaunchdRollbackOptions,
): Promise<{
  legacyLabel: string;
  nextLabel: string;
  reverseMerged: false;
  preservedNextDbPath: string;
  stateDiverged: boolean;
}> {
  const nextLabel = options.nextLabel ?? DEFAULT_LAUNCHD_LABEL;
  assertLabel(nextLabel);
  assertLabel(options.legacyLabel);
  const legacyPlistPath = plistPathForLabel(options.legacyLabel);
  const nextPlistPath = plistPathForLabel(nextLabel);
  if (!existsSync(legacyPlistPath)) {
    throw new Error(`legacy rollback plist does not exist: ${legacyPlistPath}`);
  }
  if (!existsSync(nextPlistPath)) {
    throw new Error(`next launchd plist does not exist: ${nextPlistPath}`);
  }
  let receipt = readAuthorityReceipt(options.config.home);
  if (receipt.status !== 'active_next') {
    throw new Error(
      `rollback requires an active_next authority receipt, found ${receipt.status}`,
    );
  }
  if (receipt.legacyLabel !== options.legacyLabel || receipt.nextLabel !== nextLabel) {
    throw new Error('rollback labels do not match the recorded authority receipt');
  }
  assertReceiptRuntime(receipt, options.config);
  assertReceiptBindings({
    receipt,
    cliPath: options.cliPath,
    expectedArtifactDigest: options.expectedArtifactDigest,
    expectedPromotionReceiptDigest: options.expectedPromotionReceiptDigest,
    legacyPlistPath,
    nextPlistPath,
  });
  if (receipt.nextPlist === undefined) {
    throw new Error('active_next receipt has no accepted next plist binding');
  }
  const nextConfig = withLaunchIdentity(options.config, readLaunchIdentity(nextPlistPath));
  const authorityStopTimeoutMs = Math.min(options.healthTimeoutMs ?? 30_000, 30_000);
  let nextAtRollback: ReturnType<typeof readDatabaseWatermark> | undefined;
  receipt = {
    ...receipt,
    status: 'rollback_ambiguous',
    nextDbAtRollback: undefined,
    updatedAt: new Date().toISOString(),
    lastError: undefined,
  };
  writeAuthorityReceipt(options.config.home, receipt);
  try {
    await executeAuthorityRollback({
      stopNext: async () => {
        nextAtRollback = await stopLaunchdAgentAndThen(
          nextLabel,
          options.config,
          authorityStopTimeoutMs,
          () => readDatabaseWatermark(options.config.dbPath),
        );
      },
      startLegacy: () =>
        ensureLaunchdAgentStarted(
          options.legacyLabel,
          legacyPlistPath,
          options.config,
          authorityStopTimeoutMs,
        ),
      verifyLegacy: () =>
        waitForLegacyAuthority(
          options.legacyLabel,
          receipt.legacyPlist,
          options.config,
          authorityStopTimeoutMs,
        ),
      stopLegacy: () =>
        stopLaunchdAgentAndWait(
          options.legacyLabel,
          options.config,
          authorityStopTimeoutMs,
        ),
      startNext: () =>
        ensureLaunchdAgentStarted(
          nextLabel,
          nextPlistPath,
          options.config,
          authorityStopTimeoutMs,
        ),
      verifyNext: () =>
        waitForExactHealth(nextLabel, nextConfig, options.healthTimeoutMs ?? 300_000),
    });
  } catch (err) {
    const acceptance =
      err instanceof AuthorityTransactionError ? err.acceptedAuthority : 'ambiguous';
    receipt = {
      ...receipt,
      status: acceptance === 'next' ? 'active_next' : 'rollback_ambiguous',
      nextDbAtRollback: nextAtRollback,
      updatedAt: new Date().toISOString(),
      lastError: errorMessage(err),
    };
    try {
      writeAuthorityReceipt(options.config.home, receipt);
    } catch (receiptErr) {
      throw transactionError(
        'rollback',
        acceptance,
        'persist_failure_state',
        `${errorMessage(err)}; ${acceptance === 'next' ? 'next was accepted' : 'authority is ambiguous'} ` +
          `but its receipt could not be written: ${errorMessage(receiptErr)}`,
      );
    }
    throw err;
  }
  if (nextAtRollback === undefined) {
    throw transactionError(
      'rollback',
      'legacy',
      'snapshot_stopped_next',
      'legacy was accepted, but the stopped next database watermark was not captured; run recover',
    );
  }
  receipt = {
    ...receipt,
    status: 'rolled_back',
    nextDbAtRollback: nextAtRollback,
    updatedAt: new Date().toISOString(),
  };
  try {
    writeAuthorityReceipt(options.config.home, receipt);
  } catch (err) {
    throw transactionError(
      'rollback',
      'legacy',
      'persist_rolled_back',
      `legacy was accepted, but rolled_back receipt persistence failed; run recover: ` +
        errorMessage(err),
    );
  }
  return {
    legacyLabel: options.legacyLabel,
    nextLabel,
    reverseMerged: false,
    preservedNextDbPath: nextAtRollback.path,
    stateDiverged: nextAtRollback.lastRowid !== receipt.nextDbBefore.lastRowid,
  };
}

export interface LaunchdRecoverResult {
  status: AuthorityReceipt['status'];
  acceptedAuthority: 'legacy' | 'next';
  legacyLabel: string;
  nextLabel: string;
  authorityReceiptPath: string;
}

async function recoverLaunchdAuthorityUnlocked(
  options: LaunchdRecoverOptions,
): Promise<LaunchdRecoverResult> {
  let receipt = readAuthorityReceipt(options.config.home);
  if (receipt.runtime.home !== resolve(options.config.home)) {
    throw new Error('recovery home does not match the recorded authority home');
  }
  const legacyPlistPath = plistPathForLabel(receipt.legacyLabel);
  const nextPlistPath = plistPathForLabel(receipt.nextLabel);
  if (!existsSync(legacyPlistPath)) {
    throw new Error(`legacy rollback plist does not exist: ${legacyPlistPath}`);
  }
  assertReceiptBindings({
    receipt,
    cliPath: options.cliPath,
    expectedArtifactDigest: options.expectedArtifactDigest,
    expectedPromotionReceiptDigest: options.expectedPromotionReceiptDigest,
    legacyPlistPath,
    nextPlistPath,
  });
  const runtimeConfig = configForReceipt(options.config, receipt);
  const receiptPath = authorityReceiptPath(options.config.home);

  if (receipt.status === 'active_next') {
    if (receipt.nextPlist === undefined) {
      throw new Error('active_next receipt has no accepted next plist binding');
    }
    const nextConfig = withLaunchIdentity(
      runtimeConfig,
      readLaunchIdentity(receipt.nextPlist.path),
    );
    await waitForExactHealth(
      receipt.nextLabel,
      nextConfig,
      options.healthTimeoutMs ?? 300_000,
    );
    return {
      status: receipt.status,
      acceptedAuthority: 'next',
      legacyLabel: receipt.legacyLabel,
      nextLabel: receipt.nextLabel,
      authorityReceiptPath: receiptPath,
    };
  }

  if (receipt.status === 'cutover_failed' || receipt.status === 'rolled_back') {
    const timeoutMs = Math.min(options.healthTimeoutMs ?? 30_000, 30_000);
    if (receipt.status === 'rolled_back') {
      await waitForLegacyAuthority(
        receipt.legacyLabel,
        receipt.legacyPlist,
        runtimeConfig,
        timeoutMs,
      );
    } else {
      await verifyRecordedLegacyState(
        receipt.legacyInitiallyRunning,
        receipt.legacyLabel,
        receipt.legacyPlist,
        runtimeConfig,
        timeoutMs,
      );
    }
    return {
      status: receipt.status,
      acceptedAuthority: 'legacy',
      legacyLabel: receipt.legacyLabel,
      nextLabel: receipt.nextLabel,
      authorityReceiptPath: receiptPath,
    };
  }

  const recoveringPreparing = receipt.status === 'preparing';
  const recoveringRollback = receipt.status === 'rollback_ambiguous';
  const recoverLegacyRunning = recoveringRollback || receipt.legacyInitiallyRunning;
  const authorityStopTimeoutMs = Math.min(options.healthTimeoutMs ?? 30_000, 30_000);
  let recoveredNextAtRollback: ReturnType<typeof readDatabaseWatermark> | undefined;
  receipt = {
    ...receipt,
    // Preserve the pre-stop phase until authority is terminally accepted. A
    // retry must retain the rule that healthy legacy can own the shared port.
    status: recoveringPreparing
      ? 'preparing'
      : recoveringRollback
        ? 'rollback_ambiguous'
        : 'cutover_ambiguous',
    nextDbAtRollback: recoveringRollback ? undefined : receipt.nextDbAtRollback,
    updatedAt: new Date().toISOString(),
  };
  writeAuthorityReceipt(options.config.home, receipt);

  try {
    await executeAuthorityRecovery({
      stopNext: async () => {
        const afterStopped = (): ReturnType<typeof readDatabaseWatermark> | undefined =>
          recoveringRollback
            ? readDatabaseWatermark(runtimeConfig.dbPath)
            : undefined;
        recoveredNextAtRollback = recoveringPreparing
          ? await stopPreparingNextAndThen(
              receipt.nextLabel,
              receipt.legacyLabel,
              receipt.legacyPlist,
              runtimeConfig,
              authorityStopTimeoutMs,
              afterStopped,
            )
          : await stopLaunchdAgentAndThen(
              receipt.nextLabel,
              runtimeConfig,
              authorityStopTimeoutMs,
              afterStopped,
            );
      },
      restoreLegacy: () =>
        restoreRecordedLegacyState(
          recoverLegacyRunning,
          receipt.legacyLabel,
          legacyPlistPath,
          runtimeConfig,
          authorityStopTimeoutMs,
        ),
      verifyLegacy: () =>
        verifyRecordedLegacyState(
          recoverLegacyRunning,
          receipt.legacyLabel,
          receipt.legacyPlist,
          runtimeConfig,
          authorityStopTimeoutMs,
        ),
      stopLegacy: () =>
        stopLaunchdAgentAndWait(
          receipt.legacyLabel,
          runtimeConfig,
          authorityStopTimeoutMs,
        ),
    });
  } catch (err) {
    receipt = {
      ...receipt,
      nextDbAtRollback: recoveringRollback
        ? recoveredNextAtRollback
        : receipt.nextDbAtRollback,
      updatedAt: new Date().toISOString(),
      lastError: errorMessage(err),
    };
    try {
      writeAuthorityReceipt(options.config.home, receipt);
    } catch (receiptErr) {
      throw transactionError(
        'recover',
        'ambiguous',
        'persist_ambiguity',
        `${errorMessage(err)}; recovery receipt also failed: ${errorMessage(receiptErr)}`,
      );
    }
    throw err;
  }

  if (recoveringRollback && recoveredNextAtRollback === undefined) {
    throw transactionError(
      'recover',
      'legacy',
      'snapshot_stopped_next',
      'legacy was recovered, but the stopped next database watermark was not captured; retry recover',
    );
  }

  receipt = {
    ...receipt,
    status: recoveringRollback ? 'rolled_back' : 'cutover_failed',
    nextDbAtRollback: recoveringRollback
      ? recoveredNextAtRollback
      : receipt.nextDbAtRollback,
    updatedAt: new Date().toISOString(),
    lastError: undefined,
  };
  try {
    writeAuthorityReceipt(options.config.home, receipt);
  } catch (err) {
    throw transactionError(
      'recover',
      'legacy',
      'persist_recovery',
      `legacy was accepted, but recovery receipt persistence failed; retry recover: ` +
        errorMessage(err),
    );
  }
  return {
    status: receipt.status,
    acceptedAuthority: 'legacy',
    legacyLabel: receipt.legacyLabel,
    nextLabel: receipt.nextLabel,
    authorityReceiptPath: receiptPath,
  };
}

export async function recoverLaunchdAuthority(
  options: LaunchdRecoverOptions,
): Promise<LaunchdRecoverResult> {
  const operationLock = acquireAuthorityOperationLock();
  try {
    return await recoverLaunchdAuthorityUnlocked(options);
  } finally {
    operationLock.release();
  }
}

export async function rollbackLaunchdCutover(
  options: LaunchdRollbackOptions,
): ReturnType<typeof rollbackLaunchdCutoverUnlocked> {
  const operationLock = acquireAuthorityOperationLock();
  try {
    return await rollbackLaunchdCutoverUnlocked(options);
  } finally {
    operationLock.release();
  }
}

export function readInstalledLaunchdProgram(label = DEFAULT_LAUNCHD_LABEL): string | null {
  assertLabel(label);
  const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  if (!existsSync(plistPath)) return null;
  const raw = readFileSync(plistPath, 'utf8');
  const match = /<string>([^<]*\/dist\/cli\.js)<\/string>/.exec(raw);
  return match?.[1] ?? basename(plistPath);
}
