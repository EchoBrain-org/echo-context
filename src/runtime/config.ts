import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const DEFAULT_CONTEXT_PORT = 38478;
export const DEFAULT_CONTEXT_HOST = '127.0.0.1';

export interface CaptureRuntimeConfig {
  codex: boolean;
  claudeCode: boolean;
  cursor: boolean;
  codexSessionsDir: string;
  claudeProjectsDir: string;
  cursorGlobalDb: string;
  cursorWorkspaceDir: string;
}

export interface ContextRuntimeConfig {
  home: string;
  dataDir: string;
  dbPath: string;
  host: string;
  port: number;
  capture: CaptureRuntimeConfig;
  identity: {
    instanceNonce: string | null;
    artifactDigest: string | null;
    promotionReceiptDigest: string | null;
    databaseDigest: string | null;
  };
}

function readBoolean(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw.length === 0) return fallback;
  if (raw === '1' || raw.toLowerCase() === 'true') return true;
  if (raw === '0' || raw.toLowerCase() === 'false') return false;
  throw new Error(`${key} must be true, false, 1, or 0`);
}

function readPort(env: NodeJS.ProcessEnv): number {
  const raw = env['ECHO_CONTEXT_PORT'];
  if (raw === undefined || raw.length === 0) return DEFAULT_CONTEXT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('ECHO_CONTEXT_PORT must be an integer between 1 and 65535');
  }
  return port;
}

function assertLoopbackHost(host: string): void {
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error('ECHO Context only binds to a loopback host');
  }
}

/**
 * Resolve the complete daemon configuration from explicit environment values.
 * The package intentionally has no dependency on Project_echo's configuration
 * or secrets: a copied database is the only state transferred during cutover.
 */
export function resolveContextRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): ContextRuntimeConfig {
  const userHome = homedir();
  const home = resolve(env['ECHO_CONTEXT_HOME'] ?? join(userHome, '.echo-context'));
  const dataDir = resolve(env['ECHO_CONTEXT_DATA_DIR'] ?? join(home, 'data'));
  const dbPath = resolve(env['ECHO_CONTEXT_DB_PATH'] ?? join(dataDir, 'context.db'));
  const host = env['ECHO_CONTEXT_HOST'] ?? DEFAULT_CONTEXT_HOST;
  assertLoopbackHost(host);

  return {
    home,
    dataDir,
    dbPath,
    host,
    port: readPort(env),
    capture: {
      codex: readBoolean(env, 'ECHO_CONTEXT_CAPTURE_CODEX', true),
      claudeCode: readBoolean(env, 'ECHO_CONTEXT_CAPTURE_CLAUDE', true),
      cursor: readBoolean(env, 'ECHO_CONTEXT_CAPTURE_CURSOR', true),
      codexSessionsDir: resolve(
        env['ECHO_CONTEXT_CODEX_SESSIONS_DIR'] ?? join(userHome, '.codex', 'sessions'),
      ),
      claudeProjectsDir: resolve(
        env['ECHO_CONTEXT_CLAUDE_PROJECTS_DIR'] ?? join(userHome, '.claude', 'projects'),
      ),
      cursorGlobalDb: resolve(
        env['ECHO_CONTEXT_CURSOR_GLOBAL_DB'] ??
          join(
            userHome,
            'Library',
            'Application Support',
            'Cursor',
            'User',
            'globalStorage',
            'state.vscdb',
          ),
      ),
      cursorWorkspaceDir: resolve(
        env['ECHO_CONTEXT_CURSOR_WORKSPACE_DIR'] ??
          join(
            userHome,
            'Library',
            'Application Support',
            'Cursor',
            'User',
            'workspaceStorage',
          ),
      ),
    },
    identity: {
      instanceNonce: env['ECHO_CONTEXT_INSTANCE_NONCE'] ?? null,
      artifactDigest: env['ECHO_CONTEXT_ARTIFACT_DIGEST'] ?? null,
      promotionReceiptDigest:
        env['ECHO_CONTEXT_PROMOTION_RECEIPT_DIGEST'] ?? null,
      databaseDigest: env['ECHO_CONTEXT_DATABASE_DIGEST'] ?? null,
    },
  };
}
