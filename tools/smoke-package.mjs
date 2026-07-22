import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PACKAGE_SMOKE_CAPTURE } from './package-smoke-fixture.mjs';

const artifactArg = process.argv[2];
if (artifactArg === undefined || artifactArg.startsWith('--')) {
  throw new Error('usage: node tools/smoke-package.mjs ARTIFACT.tgz [--prefix INSTALL_PREFIX]');
}
const prefixAt = process.argv.indexOf('--prefix');
const requestedPrefix = prefixAt >= 0 ? process.argv[prefixAt + 1] : undefined;
if (prefixAt >= 0 && requestedPrefix === undefined) throw new Error('--prefix requires a path');
const artifact = resolve(artifactArg);
if (!existsSync(artifact)) throw new Error(`artifact does not exist: ${artifact}`);

const scratch = mkdtempSync(join(tmpdir(), 'echo-context-package-smoke-'));
const prefix = resolve(requestedPrefix ?? join(scratch, 'prefix'));
const preservePrefix = requestedPrefix !== undefined;
if (existsSync(prefix)) {
  throw new Error(`install prefix must not already exist: ${prefix}`);
}
let daemon;
let promotionReceiptPath;
let stderr = '';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('no ephemeral port');
  await new Promise((resolveClose) => server.close(resolveClose));
  return address.port;
}

async function waitForHealth(url, expected) {
  const deadline = Date.now() + 30_000;
  let last = 'unreachable';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/healthz`, {
        signal: AbortSignal.timeout(1_000),
      });
      const body = await response.json();
      const details = body.components?.runtime?.details;
      if (
        response.ok &&
        body.status === 'healthy' &&
        details?.version === expected.version &&
        details?.instance_nonce === expected.nonce &&
        details?.artifact_digest === expected.artifactDigest &&
        details?.promotion_receipt_digest === expected.promotionReceiptDigest &&
        details?.database_digest === expected.databaseDigest
      ) {
        return body;
      }
      last = JSON.stringify(body).slice(0, 1000);
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`daemon health timeout: ${last}`);
}

async function rpc(url, method, params) {
  const response = await fetch(`${url}/mcp`, {
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
    throw new Error(`MCP ${method} failed: HTTP ${response.status} ${JSON.stringify(body)}`);
  }
  return body.result;
}

async function stopDaemon() {
  if (daemon === undefined || daemon.exitCode !== null) return;
  daemon.kill('SIGTERM');
  const result = await Promise.race([
    new Promise((resolveExit) =>
      daemon.once('exit', (code, signal) => resolveExit({ code, signal })),
    ),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('daemon did not stop within 10 seconds')), 10_000),
    ),
  ]);
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(`daemon shutdown failed: ${JSON.stringify(result)}`);
  }
}

try {
  const listing = run('/usr/bin/tar', ['-tzf', artifact]);
  for (const required of [
    'package/npm-shrinkwrap.json',
    'package/context-tools.v2.json',
    'package/schemas/service-api.v1.json',
    'package/dist/artifact-manifest.json',
    'package/dist/storage/migrations/0005_source_match_key.sql',
  ]) {
    if (!listing.split('\n').includes(required)) throw new Error(`artifact omits ${required}`);
  }
  if (/fs-watcher|git-watcher|granola-poller/.test(listing)) {
    throw new Error('artifact contains a dormant product capture surface');
  }

  run('npm', ['install', '--global', '--prefix', prefix, artifact]);
  run('npm', ['ls', '--global', '--prefix', prefix, '--omit=dev', '--all']);

  const packageRoot = join(prefix, 'lib', 'node_modules', 'echo-context');
  const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const seal = JSON.parse(readFileSync(join(packageRoot, 'context-tools.v2.json'), 'utf8'));
  if (seal.schema !== 'context-tools.v2' || seal.count !== seal.tools.length) {
    throw new Error(`invalid MCP roster seal: ${JSON.stringify(seal)}`);
  }
  const imported = await import(pathToFileURL(join(packageRoot, 'dist', 'index.js')).href);
  if (imported.ECHO_CONTEXT_VERSION !== packageJson.version) {
    throw new Error('installed package import/version mismatch');
  }
  if (imported.ECHO_CONTEXT_NODE_VERSION !== process.versions.node) {
    throw new Error(
      `installed package requires Node ${imported.ECHO_CONTEXT_NODE_VERSION}; ` +
        `smoke is running ${process.versions.node}`,
    );
  }
  const verified = imported.verifyRuntimeArtifact(join(packageRoot, 'dist', 'cli.js'));
  const receiptDirectory = join(prefix, 'share', 'echo-context');
  mkdirSync(receiptDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(receiptDirectory, 0o700);

  const runtimeHome = join(scratch, 'runtime-home');
  const dbPath = join(runtimeHome, 'data', 'context.db');
  const legacyPath = join(scratch, 'legacy.db');
  const packageRequire = createRequire(join(packageRoot, 'package.json'));
  const Database = packageRequire('better-sqlite3');
  const legacy = new Database(legacyPath);
  legacy.exec(
    readFileSync(
      join(packageRoot, 'dist', 'storage', 'migrations', '0001_initial.sql'),
      'utf8',
    ),
  );
  legacy.pragma('user_version = 1');
  legacy
    .prepare(
      'INSERT INTO events (id, source, timestamp, content, metadata) VALUES (?, ?, ?, ?, ?)',
    )
    .run(
      'legacy-smoke-event',
      'fs:\\smoke\\session.jsonl',
      '2026-07-19T17:00:00-07:00',
      'package migration smoke seed',
      '{}',
    );
  legacy.close();
  const migration = await imported.copyDatabaseForContext(legacyPath, dbPath);
  if (
    migration.events !== 1 ||
    migration.integrity !== 'ok' ||
    JSON.stringify(migration.transformations) !==
      JSON.stringify(['canonicalize_legacy_timestamps', 'backfill_source_key'])
  ) {
    throw new Error(`installed migration report mismatch: ${JSON.stringify(migration)}`);
  }
  const copyLineage = imported.readCopyLineage(dbPath);
  if (
    copyLineage.sourceEventCount !== 1 ||
    copyLineage.snapshotLastEventId !== 'legacy-smoke-event'
  ) {
    throw new Error(`installed migration lineage mismatch: ${JSON.stringify(copyLineage)}`);
  }
  const migrated = new Database(dbPath, { readonly: true, fileMustExist: true });
  const migratedVersion = migrated.pragma('user_version', { simple: true });
  const expectedMigrationVersion = readdirSync(
    join(packageRoot, 'dist', 'storage', 'migrations'),
  ).filter((name) => /^\d{4}_.+\.sql$/.test(name)).length;
  const migratedRow = migrated
    .prepare('SELECT timestamp, source_key FROM events WHERE id = ?')
    .get('legacy-smoke-event');
  const checkpointTable = migrated
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'capture_checkpoints'")
    .get();
  migrated.close();
  if (
    migratedVersion !== expectedMigrationVersion ||
    migratedRow?.timestamp !== '2026-07-20T00:00:00.000Z' ||
    migratedRow?.source_key !== 'fs:/smoke/session.jsonl' ||
    checkpointTable?.name !== 'capture_checkpoints'
  ) {
    throw new Error(
      `installed migration state mismatch: ${JSON.stringify({ migratedVersion, migratedRow, checkpointTable })}`,
    );
  }
  const port = await freePort();
  const smokeEnvironment = { ...process.env };
  delete smokeEnvironment.ECHO_CONTEXT_INSTANCE_NONCE;
  delete smokeEnvironment.ECHO_CONTEXT_ARTIFACT_DIGEST;
  delete smokeEnvironment.ECHO_CONTEXT_PROMOTION_RECEIPT_DIGEST;
  delete smokeEnvironment.ECHO_CONTEXT_DATABASE_DIGEST;
  daemon = spawn(
    join(prefix, 'bin', 'echo-context'),
    [
      'daemon',
      'run',
      '--home',
      runtimeHome,
      '--db',
      dbPath,
      '--port',
      String(port),
      '--no-capture-codex',
      '--no-capture-claude',
    ],
    {
      // This is a pre-promotion smoke. Exact identity is enabled only after
      // the passed receipt exists and can be verified at process startup.
      env: smokeEnvironment,
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  daemon.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
    if (Buffer.byteLength(stderr) > 64 * 1024) daemon.kill('SIGKILL');
  });
  daemon.once('exit', (code, signal) => {
    if (code !== null || signal !== null) stderr += `\nexit=${code} signal=${signal}`;
  });
  const url = `http://127.0.0.1:${port}`;
  await waitForHealth(url, {
    version: packageJson.version,
    nonce: null,
    artifactDigest: null,
    promotionReceiptDigest: null,
    databaseDigest: null,
  });

  const pingResponse = await fetch(`${url}/v1/ping`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!pingResponse.ok || (await pingResponse.json()).pong !== true) {
    throw new Error('installed service API ping failed');
  }
  const captureResponse = await fetch(`${url}/v1/capture`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(PACKAGE_SMOKE_CAPTURE),
    signal: AbortSignal.timeout(5_000),
  });
  const captured = await captureResponse.json();
  if (!captureResponse.ok || typeof captured.id !== 'string') {
    throw new Error(`installed service capture failed: ${JSON.stringify(captured)}`);
  }
  const searchResponse = await fetch(`${url}/v1/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: PACKAGE_SMOKE_CAPTURE.content, limit: 10 }),
    signal: AbortSignal.timeout(5_000),
  });
  const serviceSearch = await searchResponse.json();
  if (
    !searchResponse.ok ||
    !serviceSearch.matches?.some((match) => match.id === captured.id)
  ) {
    throw new Error(`installed service search failed: ${JSON.stringify(serviceSearch)}`);
  }
  const clustersResponse = await fetch(`${url}/v1/clusters`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      since: '2026-07-19T00:00:00.000Z',
      until: '2026-07-21T00:00:00.000Z',
      format: 'skeleton',
    }),
    signal: AbortSignal.timeout(5_000),
  });
  const serviceClusters = await clustersResponse.json();
  if (
    !clustersResponse.ok ||
    serviceClusters.tool !== 'get_recent_work_context' ||
    !JSON.stringify(serviceClusters).includes(captured.id)
  ) {
    throw new Error(`installed service clusters failed: ${JSON.stringify(serviceClusters)}`);
  }
  const initialize = await rpc(url, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'package-smoke', version: '1' },
  });
  if (initialize.serverInfo?.version !== packageJson.version) {
    throw new Error('MCP serverInfo version mismatch');
  }
  const tools = await rpc(url, 'tools/list', {});
  const actualNames = tools.tools.map((tool) => tool.name).sort();
  const expectedNames = [...seal.tools].sort();
  if (
    JSON.stringify(actualNames) !== JSON.stringify(expectedNames) ||
    actualNames.length !== seal.count
  ) {
    throw new Error(`MCP roster mismatch: ${JSON.stringify(actualNames)}`);
  }
  const ping = await rpc(url, 'tools/call', {
    name: 'echo_ping',
    arguments: { message: 'exact-artifact-smoke' },
  });
  if (!JSON.stringify(ping).includes('exact-artifact-smoke')) {
    throw new Error('echo_ping tool call failed');
  }
  const mcpSearch = await rpc(url, 'tools/call', {
    name: 'search_memories',
    arguments: { query: PACKAGE_SMOKE_CAPTURE.content, limit: 10 },
  });
  if (!JSON.stringify(mcpSearch).includes(captured.id)) {
    throw new Error('service-captured record was not retrievable through MCP');
  }

  await stopDaemon();
  if (existsSync(join(runtimeHome, 'daemon.pid'))) {
    throw new Error('daemon PID lock survived clean shutdown');
  }
  const installedTree = imported.digestPromotionInstalledTree(prefix);
  const artifactPath = realpathSync(artifact);
  const artifactSha256 = imported.digestRegularFileBounded(artifactPath).digest;
  const promotionReceipt = {
    schemaVersion: 1,
    artifact: artifactPath,
    artifactSha256,
    artifactDigest: verified.digest,
    sourceCommit: verified.sourceCommit,
    version: packageJson.version,
    nodeVersion: process.versions.node,
    nodeExecutable: realpathSync(process.execPath),
    installedPrefix: realpathSync(prefix),
    cliPath: realpathSync(join(prefix, 'bin', 'echo-context')),
    packageRoot: realpathSync(packageRoot),
    installedTreeDigest: installedTree.digest,
    installedTreeEntries: installedTree.entries,
    installedTreeFiles: installedTree.files,
    installedTreeBytes: installedTree.bytes,
    smoke: 'passed',
  };
  const receiptPath = join(receiptDirectory, 'promotion-receipt.json');
  promotionReceiptPath = receiptPath;
  const receiptBytes = imported.encodePromotionReceipt(promotionReceipt);
  const promotionReceiptDigest = imported.promotionReceiptDigest(receiptBytes);
  writeFileSync(receiptPath, receiptBytes, {
    mode: 0o600,
  });
  imported.verifyPromotionReceipt({
    startPath: join(packageRoot, 'dist', 'cli.js'),
    cliPath: join(prefix, 'bin', 'echo-context'),
    expectedArtifactDigest: verified.digest,
    expectedPromotionReceiptDigest: promotionReceiptDigest,
  });

  // Restart once under the exact launch identity. This proves that the daemon
  // performs the same receipt/tree/tarball/Node verification before health.
  const exactNonce = randomUUID();
  const databaseDigest = imported.databaseIdentityDigest(dbPath);
  stderr = '';
  daemon = spawn(
    join(prefix, 'bin', 'echo-context'),
    [
      'daemon',
      'run',
      '--home',
      runtimeHome,
      '--db',
      dbPath,
      '--port',
      String(port),
      '--no-capture-codex',
      '--no-capture-claude',
    ],
    {
      env: {
        ...smokeEnvironment,
        ECHO_CONTEXT_INSTANCE_NONCE: exactNonce,
        ECHO_CONTEXT_ARTIFACT_DIGEST: verified.digest,
        ECHO_CONTEXT_PROMOTION_RECEIPT_DIGEST: promotionReceiptDigest,
        ECHO_CONTEXT_DATABASE_DIGEST: databaseDigest,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  daemon.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
    if (Buffer.byteLength(stderr) > 64 * 1024) daemon.kill('SIGKILL');
  });
  daemon.once('exit', (code, signal) => {
    if (code !== null || signal !== null) stderr += `\nexit=${code} signal=${signal}`;
  });
  await waitForHealth(url, {
    version: packageJson.version,
    nonce: exactNonce,
    artifactDigest: verified.digest,
    promotionReceiptDigest,
    databaseDigest,
  });
  await stopDaemon();
  process.stdout.write(
    `${JSON.stringify({
      ...promotionReceipt,
      promotionReceipt: receiptPath,
      promotionReceiptDigest,
    })}\n`,
  );
} catch (error) {
  try {
    await stopDaemon();
  } catch (stopError) {
    error = new AggregateError([error, stopError], 'package smoke and teardown failed');
  }
  if (daemon !== undefined && daemon.exitCode === null) daemon.kill('SIGKILL');
  if (promotionReceiptPath !== undefined) {
    rmSync(promotionReceiptPath, { force: true });
  }
  throw new Error(`${error.message}${stderr ? `; daemon stderr=${stderr.slice(-4096)}` : ''}`);
} finally {
  if (preservePrefix) {
    rmSync(join(scratch, 'runtime-home'), { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  } else {
    rmSync(scratch, { recursive: true, force: true });
  }
}
