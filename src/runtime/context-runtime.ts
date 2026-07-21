import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  captureAdapterStatus,
  createCaptureAdapterRegistrations,
} from '../context-adapters/registry.js';
import { createLogger } from '../logging/index.js';
import { startMcpServer, type McpServerHandle } from '../mcp/server.js';
import { SqliteStorage } from '../storage/sqlite.js';
import type { ContextRuntimeConfig } from './config.js';
import { HealthTracker, type HealthSnapshot } from './health.js';
import { acquirePidLock, type PidLock } from './pid-lock.js';
import {
  ECHO_CONTEXT_NODE_VERSION,
  ECHO_CONTEXT_VERSION,
} from '../version.js';
import { fileURLToPath } from 'node:url';
import {
  acquireDatabaseAuthority,
  type DatabaseAuthorityLock,
} from './database-authority.js';
import {
  databaseIdentityDigest,
} from './artifact-identity.js';
import { verifyPromotionReceipt } from './promotion-receipt.js';
import { createCaptureAdapterRunner } from './capture-adapter-runner.js';

const log = createLogger('runtime.context');

export interface ContextRuntimeHandle {
  config: ContextRuntimeConfig;
  captureStatus: Readonly<Record<string, boolean>>;
  health: () => HealthSnapshot;
  mcp: McpServerHandle;
  stop: () => Promise<void>;
}

async function settleStop(name: string, stop: () => Promise<void>): Promise<void> {
  try {
    await stop();
  } catch (err) {
    log.error('component_stop_failed', { name, message: (err as Error).message });
  }
}

/**
 * Start the lean context-only process. The MCP socket is opened while health
 * is still `starting`; each capture adapter is then started and caught up in
 * sequence so cold-start work cannot multiply memory pressure across agents.
 */
export async function startContextRuntime(
  config: ContextRuntimeConfig,
): Promise<ContextRuntimeHandle> {
  if (process.versions.node !== ECHO_CONTEXT_NODE_VERSION) {
    throw new Error(
      `echo-context requires Node ${ECHO_CONTEXT_NODE_VERSION}; running ${process.versions.node}`,
    );
  }
  const identityValues = [
    config.identity.instanceNonce,
    config.identity.artifactDigest,
    config.identity.promotionReceiptDigest,
    config.identity.databaseDigest,
  ];
  const exactLaunch = identityValues.some((value) => value !== null);
  if (exactLaunch && identityValues.some((value) => value === null)) {
    throw new Error(
      'exact launch requires instance, artifact, promotion receipt, and database identity',
    );
  }
  let artifactDigest = config.identity.artifactDigest;
  let promotionReceiptDigest = config.identity.promotionReceiptDigest;
  if (exactLaunch) {
    const verified = verifyPromotionReceipt({
      startPath: fileURLToPath(import.meta.url),
      expectedArtifactDigest: artifactDigest as string,
      expectedPromotionReceiptDigest: promotionReceiptDigest as string,
    });
    if (verified.receipt.version !== ECHO_CONTEXT_VERSION) {
      throw new Error('verified package version does not match runtime version');
    }
    artifactDigest = verified.receipt.artifactDigest;
    promotionReceiptDigest = verified.receiptDigest;
  }
  let databaseDigest = config.identity.databaseDigest;
  if (databaseDigest !== null) {
    const observed = databaseIdentityDigest(config.dbPath);
    if (observed !== databaseDigest) {
      throw new Error('configured database digest does not match runtime database identity');
    }
    databaseDigest = observed;
  }
  // Compose provider bindings before acquiring process-owned resources. A
  // future adapter configuration error must not strand the PID lock.
  const captureRegistrations = createCaptureAdapterRegistrations(
    config.capture,
  );
  const captureStatus = captureAdapterStatus(captureRegistrations);
  mkdirSync(config.home, { recursive: true, mode: 0o700 });
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  chmodSync(config.home, 0o700);
  chmodSync(config.dataDir, 0o700);
  const pidLock: PidLock = acquirePidLock(join(config.home, 'daemon.pid'));
  const health = new HealthTracker({ initialStatus: 'starting' });
  const runtimeDetails = {
    version: ECHO_CONTEXT_VERSION,
    instance_nonce: config.identity.instanceNonce,
    artifact_digest: artifactDigest,
    promotion_receipt_digest: promotionReceiptDigest,
    database_digest: databaseDigest,
  };
  health.setComponent('runtime', 'starting', {
    details: runtimeDetails,
  });
  const captureRunner = createCaptureAdapterRunner(
    captureRegistrations,
    {
      onStopError: (name, err) => {
        log.error('component_stop_failed', {
          name,
          message: (err as Error).message,
        });
      },
    },
  );
  let storage: SqliteStorage | undefined;
  let databaseAuthority: DatabaseAuthorityLock | undefined;
  let mcp: McpServerHandle | undefined;
  let stopped = false;

  function observedHealth(): HealthSnapshot {
    return captureRunner.observe(health.snapshot());
  }

  try {
    storage = new SqliteStorage(config.dbPath);
    const startupStorage = storage;
    databaseAuthority = acquireDatabaseAuthority(config.dbPath);
    health.setComponent('storage', 'healthy');
    mcp = await startMcpServer(startupStorage, {
      host: config.host,
      port: config.port,
      healthSnapshotProvider: observedHealth,
    });
    health.setComponent('mcp', 'healthy');

    const startupUnhealthy = await captureRunner.start(startupStorage, health);

    health.setComponent('runtime', startupUnhealthy ? 'unhealthy' : 'healthy', {
      details: runtimeDetails,
    });
    health.transition(startupUnhealthy ? 'unhealthy' : 'healthy');
  } catch (err) {
    health.transition('unhealthy');
    health.setComponent('startup', 'unhealthy', (err as Error).message);
    await Promise.all([
      captureRunner.stop(),
      ...(mcp !== undefined ? [settleStop('mcp', mcp.stop)] : []),
    ]);
    storage?.close();
    databaseAuthority?.release();
    pidLock.release();
    throw err;
  }

  if (mcp === undefined || storage === undefined) {
    await Promise.all([
      ...(mcp !== undefined ? [settleStop('mcp', mcp.stop)] : []),
    ]);
    storage?.close();
    databaseAuthority?.release();
    pidLock.release();
    throw new Error('context runtime startup completed without required resources');
  }
  const runningMcp = mcp;
  const runningStorage = storage;

  return {
    config,
    captureStatus,
    mcp: runningMcp,
    health: observedHealth,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      health.transition('stopping');
      await captureRunner.stop();
      await settleStop('mcp', runningMcp.stop);
      runningStorage.close();
      databaseAuthority?.release();
      pidLock.release();
      log.info('stopped', {});
    },
  };
}

export async function runContextDaemon(config: ContextRuntimeConfig): Promise<void> {
  const runtime = await startContextRuntime(config);
  log.info('ready', {
    url: runtime.mcp.url,
    db_path: config.dbPath,
    capture: runtime.captureStatus,
  });

  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      void runtime.stop().finally(resolve);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}
