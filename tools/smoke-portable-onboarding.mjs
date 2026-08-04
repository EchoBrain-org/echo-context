#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGE_JSON = JSON.parse(
  readFileSync(join(ROOT, 'package.json'), 'utf8'),
);
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_DAEMON_STDERR_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 10 * 60_000;
const HEALTH_TIMEOUT_MS = 30_000;
const CAPTURE_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

export const PORTABLE_ONBOARDING_REQUIRED_FILES = Object.freeze([
  'package.json',
  'npm-shrinkwrap.json',
  'context-tools.v2.json',
  'schemas/service-api.v1.json',
  'skills/using-echo-mcp/SKILL.md',
  'skills/using-echo-mcp/agents/openai.yaml',
  'dist/cli.js',
  'dist/index.js',
  'dist/artifact-manifest.json',
  'dist/storage/migrations/0005_source_match_key.sql',
]);

export const PORTABLE_ONBOARDING_PLAN = Object.freeze({
  pack_invocations: 1,
  local_tarball_installs: 1,
  runtime_entrypoint: 'installed-package/dist/cli.js',
  runtime_command: 'daemon run',
  live_capture: 'codex-and-claude-post-start-jsonl',
  promotable: false,
});

function boundedOutput(value) {
  const text = value ?? '';
  return Buffer.byteLength(text, 'utf8') <= 8_192
    ? text
    : `${text.slice(0, 8_192)}\n[output clipped]`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    ...options,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error !== undefined) {
    if (result.error.code === 'ETIMEDOUT') {
      throw new Error(
        `${command} ${args.join(' ')} exceeded ${COMMAND_TIMEOUT_MS}ms`,
      );
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${String(result.status)}):\n${boundedOutput(
        result.stderr || result.stdout,
      )}`,
    );
  }
  return (result.stdout ?? '').trim();
}

function npm(args, options = {}) {
  const npmExecPath = process.env['npm_execpath'];
  if (npmExecPath === undefined || !existsSync(npmExecPath)) {
    throw new Error(
      'npm_execpath must identify the exact npm CLI used to start this smoke',
    );
  }
  return run(process.execPath, [npmExecPath, ...args], options);
}

function git(args) {
  return run(process.platform === 'win32' ? 'git.exe' : 'git', args, {
    env: {
      ...process.env,
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_OPTIONAL_LOCKS: '0',
    },
  });
}

export function validatePackMetadata(value) {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error('portable onboarding requires exactly one npm pack result');
  }
  const result = value[0];
  if (
    result === null ||
    typeof result !== 'object' ||
    typeof result.filename !== 'string' ||
    !Array.isArray(result.files)
  ) {
    throw new Error('npm pack returned invalid metadata');
  }
  const paths = new Set(
    result.files.map((entry) =>
      entry !== null && typeof entry === 'object' ? entry.path : undefined,
    ),
  );
  for (const required of PORTABLE_ONBOARDING_REQUIRED_FILES) {
    if (!paths.has(required))
      throw new Error(`portable package omits ${required}`);
  }
  return result;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('failed to allocate a loopback port');
  }
  await new Promise((resolveClose) => server.close(resolveClose));
  return address.port;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(5_000),
    ...options,
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} from ${url}: ${boundedOutput(JSON.stringify(body))}`,
    );
  }
  return body;
}

async function waitForHealth(baseUrl, version, child, daemonError) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let last = 'unreachable';
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`daemon exited before health: ${daemonError()}`);
    }
    try {
      const body = await fetchJson(`${baseUrl}/healthz`);
      const runtime = body.components?.runtime?.details;
      if (
        body.status === 'healthy' &&
        runtime?.version === version &&
        runtime?.instance_nonce === null &&
        runtime?.artifact_digest === null &&
        runtime?.promotion_receipt_digest === null &&
        runtime?.database_digest === null &&
        body.components?.codex?.status === 'healthy' &&
        body.components?.codex?.details?.sourceStatus === 'active' &&
        body.components?.claude_code?.status === 'healthy' &&
        body.components?.claude_code?.details?.sourceStatus === 'active'
      ) {
        return body;
      }
      last = JSON.stringify(body).slice(0, 1_000);
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`daemon health timeout: ${last}; stderr=${daemonError()}`);
}

async function rpc(baseUrl, method, params) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
    signal: AbortSignal.timeout(5_000),
  });
  const body = await response.json();
  if (!response.ok || body.error !== undefined) {
    throw new Error(
      `MCP ${method} failed: HTTP ${response.status} ${boundedOutput(JSON.stringify(body))}`,
    );
  }
  return body.result;
}

async function waitForCapturedTurn(baseUrl, marker, sourceApp) {
  const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
  let last = 'not observed';
  while (Date.now() < deadline) {
    try {
      const body = await fetchJson(`${baseUrl}/v1/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: marker,
          source_app: sourceApp,
          limit: 10,
        }),
      });
      const match = body.matches?.find((candidate) =>
        candidate.content?.includes(marker),
      );
      if (match !== undefined && typeof match.id === 'string') return match;
      last = JSON.stringify(body).slice(0, 1_000);
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(
    `post-start Codex turn was not captured within ${CAPTURE_TIMEOUT_MS}ms: ${last}`,
  );
}

function exitResult(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`daemon did not exit within ${timeoutMs}ms`)),
      timeoutMs,
    );
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}

async function stopDaemon(child, { tolerateExited = false } = {}) {
  if (child === undefined) {
    return process.platform === 'win32'
      ? 'forced-process-termination'
      : 'graceful-sigterm';
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    if (!tolerateExited) {
      throw new Error(
        `daemon exited before shutdown was requested: ${JSON.stringify({
          code: child.exitCode,
          signal: child.signalCode,
        })}`,
      );
    }
    return process.platform === 'win32'
      ? 'forced-process-termination'
      : 'graceful-sigterm';
  }
  const windows = process.platform === 'win32';
  if (!child.kill('SIGTERM')) {
    const result = await exitResult(child, SHUTDOWN_TIMEOUT_MS);
    throw new Error(
      `daemon exited before shutdown signal was delivered: ${JSON.stringify(
        result,
      )}`,
    );
  }
  let result;
  try {
    result = await exitResult(child, SHUTDOWN_TIMEOUT_MS);
  } catch (error) {
    child.kill('SIGKILL');
    await exitResult(child, 5_000);
    throw error;
  }
  if (!windows && (result.code !== 0 || result.signal !== null)) {
    throw new Error(
      `daemon did not shut down cleanly: ${JSON.stringify(result)}`,
    );
  }
  return windows ? 'forced-process-termination' : 'graceful-sigterm';
}

function codexFixture(marker, cwd) {
  return [
    {
      timestamp: '2026-08-03T20:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: '019f5f43-20f0-7000-8000-000000000001',
        session_id: '019f5f43-20f0-7000-8000-000000000001',
        cwd,
        source: 'cli',
        cli_version: 'portable-onboarding-smoke',
        model_provider: 'openai',
      },
    },
    {
      timestamp: '2026-08-03T20:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `capture ${marker}` }],
      },
    },
    {
      timestamp: '2026-08-03T20:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: `retrieved ${marker}` }],
      },
    },
    {
      timestamp: '2026-08-03T20:00:03.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: '019f5f43-20f0-7000-8000-000000000001',
      },
    },
  ];
}

function claudeFixture(marker, cwd) {
  const sessionId = '019f5f43-20f0-7000-8000-000000000002';
  return [
    {
      type: 'user',
      sessionId,
      uuid: '019f5f43-20f0-7000-8000-000000000003',
      cwd,
      isSidechain: false,
      permissionMode: 'default',
      version: 'portable-onboarding-smoke',
      timestamp: '2026-08-03T20:00:04.000Z',
      message: { role: 'user', content: `capture ${marker}` },
    },
    {
      type: 'assistant',
      sessionId,
      uuid: '019f5f43-20f0-7000-8000-000000000004',
      cwd,
      isSidechain: false,
      version: 'portable-onboarding-smoke',
      timestamp: '2026-08-03T20:00:05.000Z',
      message: {
        role: 'assistant',
        model: 'claude-portable-smoke',
        content: [{ type: 'text', text: `retrieved ${marker}` }],
        stop_reason: 'end_turn',
      },
    },
  ];
}

export async function runPortableOnboarding() {
  if (process.argv.length > 2) {
    throw new Error('smoke:onboarding accepts no arguments');
  }
  if (process.versions.node !== PACKAGE_JSON.engines.node) {
    throw new Error(
      `echo-context requires Node ${PACKAGE_JSON.engines.node}; running ${process.versions.node}`,
    );
  }
  const npmVersion = npm(['--version']);
  if (npmVersion !== PACKAGE_JSON.engines.npm) {
    throw new Error(
      `echo-context requires npm ${PACKAGE_JSON.engines.npm}; running ${npmVersion}`,
    );
  }
  const status = git(['status', '--porcelain=v1', '--untracked-files=all']);
  if (status.length > 0)
    throw new Error('portable onboarding requires a clean committed worktree');
  const sourceCommit = git(['rev-parse', '--verify', 'HEAD']);
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) {
    throw new Error(`invalid source commit: ${sourceCommit}`);
  }

  const scratch = mkdtempSync(
    join(tmpdir(), 'echo-context-portable-onboarding-'),
  );
  let daemon;
  let daemonStderr = '';
  let daemonOutputExceeded = false;
  let teardown =
    process.platform === 'win32'
      ? 'forced-process-termination'
      : 'graceful-sigterm';
  let completed = false;
  try {
    const rawPack = npm([
      'pack',
      '--json',
      '--pack-destination',
      scratch,
      '--ignore-scripts=false',
      '--loglevel=error',
    ]);
    let parsedPack;
    try {
      parsedPack = JSON.parse(rawPack);
    } catch {
      throw new Error(
        `npm pack did not return JSON: ${boundedOutput(rawPack)}`,
      );
    }
    const pack = validatePackMetadata(parsedPack);
    const artifact = resolve(scratch, pack.filename);
    if (!existsSync(artifact))
      throw new Error(`npm pack artifact is missing: ${artifact}`);
    const artifactSha256 = createHash('sha256')
      .update(readFileSync(artifact))
      .digest('hex');

    const consumer = join(scratch, 'consumer');
    mkdirSync(consumer, { recursive: true });
    writeFileSync(
      join(consumer, 'package.json'),
      `${JSON.stringify({ name: 'echo-context-portable-smoke', private: true }, null, 2)}\n`,
    );
    npm([
      'install',
      '--prefix',
      consumer,
      '--no-audit',
      '--no-fund',
      '--save-exact',
      '--loglevel=error',
      artifact,
    ]);

    const packageRoot = join(consumer, 'node_modules', 'echo-context');
    const installedPackage = JSON.parse(
      readFileSync(join(packageRoot, 'package.json'), 'utf8'),
    );
    const seal = JSON.parse(
      readFileSync(join(packageRoot, 'context-tools.v2.json'), 'utf8'),
    );
    if (
      seal.schema !== 'context-tools.v2' ||
      seal.count !== seal.tools.length
    ) {
      throw new Error(`invalid installed MCP roster: ${JSON.stringify(seal)}`);
    }
    const installedCliDeclaration = installedPackage.bin?.['echo-context'];
    if (installedCliDeclaration !== './dist/cli.js') {
      throw new Error(
        `installed CLI declaration mismatch: ${String(installedCliDeclaration)}`,
      );
    }
    const installedCli = resolve(packageRoot, installedCliDeclaration);
    if (!existsSync(installedCli)) {
      throw new Error(`installed CLI is missing: ${installedCli}`);
    }
    const versionOutput = run(process.execPath, [installedCli, 'version'], {
      cwd: consumer,
    });
    if (versionOutput !== installedPackage.version) {
      throw new Error(`installed CLI version mismatch: ${versionOutput}`);
    }

    const installed = await import(
      `${pathToFileURL(join(packageRoot, 'dist', 'index.js')).href}?smoke=${randomUUID()}`
    );
    if (
      installed.ECHO_CONTEXT_VERSION !== installedPackage.version ||
      installed.ECHO_CONTEXT_NODE_VERSION !== process.versions.node
    ) {
      throw new Error('installed package import/version mismatch');
    }
    const artifactIdentity = installed.verifyRuntimeArtifact(
      join(packageRoot, 'dist', 'cli.js'),
    );
    if (
      artifactIdentity.sourceCommit !== sourceCommit ||
      artifactIdentity.packageVersion !== installedPackage.version
    ) {
      throw new Error(
        `installed artifact identity mismatch: ${JSON.stringify(artifactIdentity)}`,
      );
    }

    const profile = join(scratch, 'profile');
    const workspace = join(profile, 'workspace');
    const runtimeHome = join(scratch, 'runtime-home');
    const database = join(runtimeHome, 'data', 'context.db');
    const codexRoot = join(profile, '.codex', 'sessions');
    const codexDay = join(codexRoot, '2026', '08', '03');
    const claudeRoot = join(profile, '.claude', 'projects');
    const claudeProject = join(claudeRoot, 'portable-project');
    mkdirSync(codexDay, { recursive: true });
    mkdirSync(claudeProject, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const port = await freePort();
    const runtimeEnvironment = { ...process.env };
    for (const key of Object.keys(runtimeEnvironment)) {
      if (key.startsWith('ECHO_CONTEXT_')) delete runtimeEnvironment[key];
    }
    runtimeEnvironment['HOME'] = profile;
    runtimeEnvironment['USERPROFILE'] = profile;
    runtimeEnvironment['CI'] = '1';
    runtimeEnvironment['TZ'] = 'UTC';
    daemon = spawn(
      process.execPath,
      [
        join(packageRoot, 'dist', 'cli.js'),
        'daemon',
        'run',
        '--home',
        runtimeHome,
        '--db',
        database,
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--capture-codex',
        '--codex-sessions-dir',
        codexRoot,
        '--capture-claude',
        '--claude-projects-dir',
        claudeRoot,
      ],
      {
        env: runtimeEnvironment,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      },
    );
    daemon.stderr.on('data', (chunk) => {
      if (daemonOutputExceeded) return;
      daemonStderr += chunk.toString('utf8');
      if (Buffer.byteLength(daemonStderr, 'utf8') > MAX_DAEMON_STDERR_BYTES) {
        daemonOutputExceeded = true;
        daemon.kill('SIGTERM');
      }
    });
    const daemonError = () =>
      daemonOutputExceeded
        ? 'daemon stderr exceeded 64 KiB'
        : boundedOutput(daemonStderr || 'no daemon stderr');

    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl, installedPackage.version, daemon, daemonError);
    const servicePing = await fetchJson(`${baseUrl}/v1/ping`);
    if (servicePing.pong !== true)
      throw new Error('service API ping did not return pong');

    const codexMarker = `portable-codex-live-${randomUUID()}`;
    const claudeMarker = `portable-claude-live-${randomUUID()}`;
    const codexPath = join(
      codexDay,
      'rollout-2026-08-03T20-00-00-019f5f43-20f0-7000-8000-000000000001.jsonl',
    );
    const claudePath = join(claudeProject, 'portable-session.jsonl');
    writeFileSync(
      codexPath,
      `${codexFixture(codexMarker, workspace)
        .map((line) => JSON.stringify(line))
        .join('\n')}\n`,
    );
    writeFileSync(
      claudePath,
      `${claudeFixture(claudeMarker, workspace)
        .map((line) => JSON.stringify(line))
        .join('\n')}\n`,
    );
    const [capturedCodex, capturedClaude] = await Promise.all([
      waitForCapturedTurn(baseUrl, codexMarker, 'codex'),
      waitForCapturedTurn(baseUrl, claudeMarker, 'claude_code'),
    ]);

    const initialize = await rpc(baseUrl, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'portable-onboarding-smoke', version: '1' },
    });
    if (initialize.serverInfo?.version !== installedPackage.version) {
      throw new Error('MCP server version mismatch');
    }
    const tools = await rpc(baseUrl, 'tools/list', {});
    const actualTools = tools.tools.map((tool) => tool.name).sort();
    const expectedTools = [...seal.tools].sort();
    if (
      actualTools.length !== seal.count ||
      JSON.stringify(actualTools) !== JSON.stringify(expectedTools)
    ) {
      throw new Error(`MCP roster mismatch: ${JSON.stringify(actualTools)}`);
    }
    const ping = await rpc(baseUrl, 'tools/call', {
      name: 'echo_ping',
      arguments: { message: codexMarker },
    });
    if (!JSON.stringify(ping).includes(codexMarker))
      throw new Error('MCP echo_ping failed');
    for (const capture of [
      { app: 'codex', id: capturedCodex.id, marker: codexMarker },
      { app: 'claude_code', id: capturedClaude.id, marker: claudeMarker },
    ]) {
      const search = await rpc(baseUrl, 'tools/call', {
        name: 'search_memories',
        arguments: {
          query: capture.marker,
          source_app: capture.app,
          limit: 10,
        },
      });
      if (!JSON.stringify(search).includes(capture.id)) {
        throw new Error(
          `live-captured ${capture.app} turn was not retrievable through MCP`,
        );
      }
    }
    const clusters = await rpc(baseUrl, 'tools/call', {
      name: 'find_clusters',
      arguments: {
        since: '2026-08-03T19:59:00.000Z',
        until: '2026-08-03T20:01:00.000Z',
        view: 'compact',
      },
    });
    const clustered = JSON.stringify(clusters);
    if (
      !clustered.includes(capturedCodex.id) ||
      !clustered.includes(capturedClaude.id) ||
      !clustered.includes('codex') ||
      !clustered.includes('claude_code')
    ) {
      throw new Error(
        'normalized coding turns were not both discoverable through find_clusters',
      );
    }

    teardown = await stopDaemon(daemon);
    if (
      process.platform !== 'win32' &&
      existsSync(join(runtimeHome, 'daemon.pid'))
    ) {
      throw new Error('daemon PID lock survived graceful shutdown');
    }
    completed = true;
    return {
      schema: 'portable-onboarding-smoke.v1',
      status: 'passed',
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      npm: npmVersion,
      package_version: installedPackage.version,
      source_commit: sourceCommit,
      artifact_sha256: artifactSha256,
      artifact_digest: artifactIdentity.digest,
      teardown,
      checks: [
        'single-pack',
        'local-tarball-install',
        'installed-cli',
        'artifact-identity',
        'sqlite-runtime',
        'health',
        'service-api',
        'post-start-codex-capture',
        'post-start-claude-capture',
        'mcp-roster',
        'mcp-live-retrieval',
        'mcp-normalized-discovery',
      ],
    };
  } finally {
    try {
      if (!completed && daemon !== undefined) {
        await stopDaemon(daemon, { tolerateExited: true });
      }
    } finally {
      rmSync(scratch, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runPortableOnboarding()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.stack : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
