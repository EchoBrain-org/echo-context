#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { copyDatabaseForContext } from './migration/copy-database.js';
import { assertOptions } from './runtime/cli-options.js';
import { resolveContextRuntimeConfig } from './runtime/config.js';
import { runContextDaemon } from './runtime/context-runtime.js';
import {
  DEFAULT_LAUNCHD_LABEL,
  cutoverLaunchdAgent,
  installLaunchdAgent,
  recoverLaunchdAuthority,
  rollbackLaunchdCutover,
  uninstallLaunchdAgent,
} from './runtime/launchd.js';
import { ECHO_CONTEXT_VERSION } from './version.js';

function print(value: unknown): void {
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

function option(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function has(args: readonly string[], name: string): boolean {
  return args.includes(name);
}

const RUNTIME_VALUE_OPTIONS = ['--home', '--db', '--host', '--port'] as const;
const CAPTURE_VALUE_OPTIONS = [
  '--codex-sessions-dir',
  '--claude-projects-dir',
] as const;
const CAPTURE_FLAG_OPTIONS = [
  '--capture-codex',
  '--no-capture-codex',
  '--capture-claude',
  '--no-capture-claude',
] as const;

function applyToggle(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  enabledFlag: string,
  disabledFlag: string,
  envKey: string,
): void {
  const enabled = has(args, enabledFlag);
  const disabled = has(args, disabledFlag);
  if (enabled && disabled) {
    throw new Error(`${enabledFlag} and ${disabledFlag} are mutually exclusive`);
  }
  if (enabled) env[envKey] = 'true';
  if (disabled) env[envKey] = 'false';
}

function configEnvironment(args: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const home = option(args, '--home');
  const db = option(args, '--db');
  const host = option(args, '--host');
  const port = option(args, '--port');
  const codexSessionsDir = option(args, '--codex-sessions-dir');
  const claudeProjectsDir = option(args, '--claude-projects-dir');
  if (home !== undefined) env['ECHO_CONTEXT_HOME'] = home;
  if (db !== undefined) env['ECHO_CONTEXT_DB_PATH'] = db;
  if (host !== undefined) env['ECHO_CONTEXT_HOST'] = host;
  if (port !== undefined) env['ECHO_CONTEXT_PORT'] = port;
  if (codexSessionsDir !== undefined) {
    env['ECHO_CONTEXT_CODEX_SESSIONS_DIR'] = codexSessionsDir;
  }
  if (claudeProjectsDir !== undefined) {
    env['ECHO_CONTEXT_CLAUDE_PROJECTS_DIR'] = claudeProjectsDir;
  }
  applyToggle(args, env, '--capture-codex', '--no-capture-codex', 'ECHO_CONTEXT_CAPTURE_CODEX');
  applyToggle(args, env, '--capture-claude', '--no-capture-claude', 'ECHO_CONTEXT_CAPTURE_CLAUDE');
  return env;
}

function help(): string {
  return `echo-context ${ECHO_CONTEXT_VERSION}

Usage:
  echo-context daemon run [runtime and capture options]
  echo-context migrate --from SOURCE_DB --to DESTINATION_DB
  echo-context status [--host HOST] [--port PORT]
  echo-context install --expected-artifact-digest SHA256 --expected-promotion-receipt-digest SHA256 [--label LABEL] [--replace] [--no-start] [runtime options]
  echo-context cutover --legacy-label LABEL --legacy-db PATH --expected-artifact-digest SHA256 --expected-promotion-receipt-digest SHA256 [--label LABEL] [--replace] [runtime options]
  echo-context rollback --legacy-label LABEL --expected-artifact-digest SHA256 --expected-promotion-receipt-digest SHA256 [--label LABEL] [runtime options]
  echo-context recover --expected-artifact-digest SHA256 --expected-promotion-receipt-digest SHA256 [--home PATH]
  echo-context uninstall [--label LABEL]
  echo-context version

Runtime options: --home PATH --db PATH --host LOOPBACK_HOST --port PORT
Capture options: --[no-]capture-codex --[no-]capture-claude
  --codex-sessions-dir PATH --claude-projects-dir PATH
`;
}

async function status(args: readonly string[]): Promise<void> {
  const config = resolveContextRuntimeConfig(configEnvironment(args));
  const host = config.host === '::1' ? '[::1]' : config.host;
  const url = `http://${host}:${config.port}/healthz`;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
  } catch (err) {
    print({ status: 'unreachable', url, message: (err as Error).message });
    process.exitCode = 1;
    return;
  }
  const body = (await response.json()) as unknown;
  print({ url, http_status: response.status, health: body });
  if (!response.ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    print(help());
    return;
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    if (args.length !== 1) throw new Error(`unknown option: ${args[1]}`);
    print(ECHO_CONTEXT_VERSION);
    return;
  }

  if (command === 'daemon' && args[1] === 'run') {
    const daemonArgs = args.slice(2);
    assertOptions(
      daemonArgs,
      [...RUNTIME_VALUE_OPTIONS, ...CAPTURE_VALUE_OPTIONS],
      CAPTURE_FLAG_OPTIONS,
    );
    await runContextDaemon(resolveContextRuntimeConfig(configEnvironment(daemonArgs)));
    return;
  }

  if (command === 'migrate') {
    assertOptions(args.slice(1), ['--from', '--to']);
    const source = option(args, '--from');
    const destination = option(args, '--to');
    if (source === undefined || destination === undefined) {
      throw new Error('migrate requires --from SOURCE_DB and --to DESTINATION_DB');
    }
    if (!existsSync(source)) throw new Error(`source database does not exist: ${source}`);
    print(await copyDatabaseForContext(source, destination));
    return;
  }

  if (command === 'status') {
    const statusArgs = args.slice(1);
    assertOptions(statusArgs, RUNTIME_VALUE_OPTIONS);
    await status(statusArgs);
    return;
  }

  if (command === 'install') {
    const installArgs = args.slice(1);
    assertOptions(
      installArgs,
      [
        ...RUNTIME_VALUE_OPTIONS,
        ...CAPTURE_VALUE_OPTIONS,
        '--label',
        '--expected-artifact-digest',
        '--expected-promotion-receipt-digest',
      ],
      ['--replace', '--no-start', ...CAPTURE_FLAG_OPTIONS],
    );
    const config = resolveContextRuntimeConfig(configEnvironment(installArgs));
    const expectedArtifactDigest = option(installArgs, '--expected-artifact-digest');
    if (expectedArtifactDigest === undefined) {
      throw new Error('install requires --expected-artifact-digest SHA256');
    }
    const expectedPromotionReceiptDigest = option(
      installArgs,
      '--expected-promotion-receipt-digest',
    );
    if (expectedPromotionReceiptDigest === undefined) {
      throw new Error(
        'install requires --expected-promotion-receipt-digest SHA256',
      );
    }
    const result = await installLaunchdAgent({
      cliPath: fileURLToPath(import.meta.url),
      expectedArtifactDigest,
      expectedPromotionReceiptDigest,
      config,
      label: option(installArgs, '--label') ?? DEFAULT_LAUNCHD_LABEL,
      replace: has(installArgs, '--replace'),
      start: !has(installArgs, '--no-start'),
    });
    print(result);
    return;
  }

  if (command === 'cutover') {
    const cutoverArgs = args.slice(1);
    assertOptions(
      cutoverArgs,
      [
        ...RUNTIME_VALUE_OPTIONS,
        ...CAPTURE_VALUE_OPTIONS,
        '--legacy-label',
        '--legacy-db',
        '--label',
        '--expected-artifact-digest',
        '--expected-promotion-receipt-digest',
      ],
      ['--replace', ...CAPTURE_FLAG_OPTIONS],
    );
    const legacyLabel = option(cutoverArgs, '--legacy-label');
    if (legacyLabel === undefined) throw new Error('cutover requires --legacy-label LABEL');
    const legacyDbPath = option(cutoverArgs, '--legacy-db');
    if (legacyDbPath === undefined) throw new Error('cutover requires --legacy-db PATH');
    const expectedArtifactDigest = option(cutoverArgs, '--expected-artifact-digest');
    if (expectedArtifactDigest === undefined) {
      throw new Error('cutover requires --expected-artifact-digest SHA256');
    }
    const expectedPromotionReceiptDigest = option(
      cutoverArgs,
      '--expected-promotion-receipt-digest',
    );
    if (expectedPromotionReceiptDigest === undefined) {
      throw new Error(
        'cutover requires --expected-promotion-receipt-digest SHA256',
      );
    }
    const config = resolveContextRuntimeConfig(configEnvironment(cutoverArgs));
    print(
      await cutoverLaunchdAgent({
        cliPath: fileURLToPath(import.meta.url),
        expectedArtifactDigest,
        expectedPromotionReceiptDigest,
        config,
        legacyLabel,
        legacyDbPath,
        label: option(cutoverArgs, '--label') ?? DEFAULT_LAUNCHD_LABEL,
        replace: has(cutoverArgs, '--replace'),
      }),
    );
    return;
  }

  if (command === 'rollback') {
    const rollbackArgs = args.slice(1);
    assertOptions(
      rollbackArgs,
      [
        ...RUNTIME_VALUE_OPTIONS,
        ...CAPTURE_VALUE_OPTIONS,
        '--legacy-label',
        '--label',
        '--expected-artifact-digest',
        '--expected-promotion-receipt-digest',
      ],
      CAPTURE_FLAG_OPTIONS,
    );
    const legacyLabel = option(rollbackArgs, '--legacy-label');
    if (legacyLabel === undefined) throw new Error('rollback requires --legacy-label LABEL');
    const expectedArtifactDigest = option(rollbackArgs, '--expected-artifact-digest');
    if (expectedArtifactDigest === undefined) {
      throw new Error('rollback requires --expected-artifact-digest SHA256');
    }
    const expectedPromotionReceiptDigest = option(
      rollbackArgs,
      '--expected-promotion-receipt-digest',
    );
    if (expectedPromotionReceiptDigest === undefined) {
      throw new Error(
        'rollback requires --expected-promotion-receipt-digest SHA256',
      );
    }
    print(
      await rollbackLaunchdCutover({
        legacyLabel,
        nextLabel: option(rollbackArgs, '--label') ?? DEFAULT_LAUNCHD_LABEL,
        cliPath: fileURLToPath(import.meta.url),
        expectedArtifactDigest,
        expectedPromotionReceiptDigest,
        config: resolveContextRuntimeConfig(configEnvironment(rollbackArgs)),
      }),
    );
    return;
  }

  if (command === 'recover') {
    const recoverArgs = args.slice(1);
    assertOptions(recoverArgs, [
      '--home',
      '--expected-artifact-digest',
      '--expected-promotion-receipt-digest',
    ]);
    const expectedArtifactDigest = option(recoverArgs, '--expected-artifact-digest');
    if (expectedArtifactDigest === undefined) {
      throw new Error('recover requires --expected-artifact-digest SHA256');
    }
    const expectedPromotionReceiptDigest = option(
      recoverArgs,
      '--expected-promotion-receipt-digest',
    );
    if (expectedPromotionReceiptDigest === undefined) {
      throw new Error(
        'recover requires --expected-promotion-receipt-digest SHA256',
      );
    }
    print(
      await recoverLaunchdAuthority({
        cliPath: fileURLToPath(import.meta.url),
        expectedArtifactDigest,
        expectedPromotionReceiptDigest,
        config: resolveContextRuntimeConfig(configEnvironment(recoverArgs)),
      }),
    );
    return;
  }

  if (command === 'uninstall') {
    const uninstallArgs = args.slice(1);
    assertOptions(uninstallArgs, ['--label']);
    const label = option(uninstallArgs, '--label') ?? DEFAULT_LAUNCHD_LABEL;
    print({ removed: uninstallLaunchdAgent(label), label });
    return;
  }

  throw new Error(`unknown command: ${args.join(' ')}`);
}

main().catch((err: unknown) => {
  process.stderr.write(`echo-context: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
