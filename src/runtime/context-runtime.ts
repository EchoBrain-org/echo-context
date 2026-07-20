import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startClaudeCodeExtractor } from '../capture/extractors/claude-code.js';
import { startCodexExtractor } from '../capture/extractors/codex.js';
import {
  startCursorExtractor,
  type CursorExtractorHandle,
} from '../capture/extractors/cursor.js';
import type {
  ExtractorHandle,
  ExtractorHealth,
} from '../capture/extractors/_shared.js';
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

const log = createLogger('runtime.context');

export interface ContextRuntimeHandle {
  config: ContextRuntimeConfig;
  health: () => HealthSnapshot;
  mcp: McpServerHandle;
  stop: () => Promise<void>;
}

function withTrailingSlash(path: string): string {
  return path.endsWith('/') ? path : `${path}/`;
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
  let storage: SqliteStorage | undefined;
  let databaseAuthority: DatabaseAuthorityLock | undefined;
  let mcp: McpServerHandle | undefined;
  let codex: ExtractorHandle | undefined;
  let claude: ExtractorHandle | undefined;
  let cursor: CursorExtractorHandle | undefined;
  let stopped = false;
  let startupUnhealthy = false;

  function observedHealth(): HealthSnapshot {
    const snapshot = health.snapshot();
    const observed: Array<[string, { getHealth?: () => ExtractorHealth } | undefined]> = [
      ['codex', codex],
      ['claude_code', claude],
      ['cursor', cursor],
    ];
    let observedStatus = snapshot.status;
    for (const [name, handle] of observed) {
      const adapter = handle?.getHealth?.();
      if (adapter === undefined) continue;
      const componentStatus =
        adapter.state === 'stopped'
          ? snapshot.status === 'stopping'
            ? 'stopping'
            : 'unhealthy'
          : adapter.state;
      snapshot.components[name] = {
        status: componentStatus,
        updated_at: new Date().toISOString(),
        ...(adapter.lastError !== null ? { message: adapter.lastError } : {}),
        details: {
          queueDepth: adapter.queueDepth,
          overflowCount: adapter.overflowCount,
          reconciliationPending: adapter.reconciliationPending,
          errorCount: adapter.errorCount,
          ...(adapter.sourceStatus !== undefined
            ? { sourceStatus: adapter.sourceStatus }
            : {}),
        },
      };
      if (snapshot.status === 'healthy') {
        if (componentStatus === 'unhealthy') observedStatus = 'unhealthy';
        else if (
          observedStatus !== 'unhealthy' &&
          (componentStatus === 'starting' || componentStatus === 'catching_up')
        ) {
          observedStatus = 'catching_up';
        }
      }
    }
    snapshot.status = observedStatus;
    return snapshot;
  }

  async function startJsonlAdapter(
    name: 'codex' | 'claude_code',
    start: () => Promise<ExtractorHandle>,
  ): Promise<ExtractorHandle> {
    health.transition('catching_up');
    health.setComponent(name, 'starting');
    const handle = await start();
    health.setComponent(name, 'catching_up');
    await handle.initialCatchUp;
    const adapterHealth = handle.getHealth();
    const componentStatus =
      adapterHealth.state === 'stopped' ? 'unhealthy' : adapterHealth.state;
    if (componentStatus === 'unhealthy') startupUnhealthy = true;
    health.setComponent(
      name,
      componentStatus,
      adapterHealth.lastError ??
        `queued=${adapterHealth.queueDepth}; overflow=${adapterHealth.overflowCount}`,
    );
    return handle;
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

    if (config.capture.codex) {
      codex = await startJsonlAdapter('codex', () =>
        startCodexExtractor(startupStorage, {
          sessionsPrefix: withTrailingSlash(config.capture.codexSessionsDir),
        }),
      );
    } else {
      health.setComponent('codex', 'healthy', 'disabled');
    }

    if (config.capture.claudeCode) {
      claude = await startJsonlAdapter('claude_code', () =>
        startClaudeCodeExtractor(startupStorage, {
          projectsPrefix: withTrailingSlash(config.capture.claudeProjectsDir),
        }),
      );
    } else {
      health.setComponent('claude_code', 'healthy', 'disabled');
    }

    if (config.capture.cursor) {
      health.transition('catching_up');
      health.setComponent('cursor', 'starting');
      cursor = await startCursorExtractor(startupStorage, {
        globalDbPath: config.capture.cursorGlobalDb,
        workspacePrefix: withTrailingSlash(config.capture.cursorWorkspaceDir),
      });
      health.setComponent('cursor', 'catching_up');
      await cursor.initialCatchUp;
      const cursorHealth = cursor.getHealth();
      const cursorStatus =
        cursorHealth.state === 'stopped' ? 'unhealthy' : cursorHealth.state;
      if (cursorStatus === 'unhealthy') startupUnhealthy = true;
      health.setComponent(
        'cursor',
        cursorStatus,
        cursorHealth.lastError ??
          `queued=${cursorHealth.queueDepth}; overflow=${cursorHealth.overflowCount}`,
      );
    } else {
      health.setComponent('cursor', 'healthy', 'disabled');
    }

    health.setComponent('runtime', startupUnhealthy ? 'unhealthy' : 'healthy', {
      details: runtimeDetails,
    });
    health.transition(startupUnhealthy ? 'unhealthy' : 'healthy');
  } catch (err) {
    health.transition('unhealthy');
    health.setComponent('startup', 'unhealthy', (err as Error).message);
    await Promise.all([
      ...(cursor !== undefined ? [settleStop('cursor', cursor.stop)] : []),
      ...(claude !== undefined ? [settleStop('claude_code', claude.stop)] : []),
      ...(codex !== undefined ? [settleStop('codex', codex.stop)] : []),
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
    mcp: runningMcp,
    health: observedHealth,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      health.transition('stopping');
      if (cursor !== undefined) await settleStop('cursor', cursor.stop);
      if (claude !== undefined) await settleStop('claude_code', claude.stop);
      if (codex !== undefined) await settleStop('codex', codex.stop);
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
    capture: {
      codex: config.capture.codex,
      claude_code: config.capture.claudeCode,
      cursor: config.capture.cursor,
    },
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
