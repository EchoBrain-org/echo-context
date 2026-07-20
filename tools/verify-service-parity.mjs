#!/usr/bin/env node
// Isolated test wrapper for the production context runtime. Run with:
// node --import tsx <this-file> --home ABSOLUTE_PATH --ready-fd 3

import { readFileSync, writeSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

const API = JSON.parse(
  readFileSync(new URL('../schemas/service-api.v1.json', import.meta.url), 'utf8'),
);

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length
    ? process.argv[index + 1]
    : fallback;
}

function bootFail(message) {
  process.stderr.write(`verify-service-parity: ${message}\n`);
  process.exit(2);
}

const scratchHome = argument('--home');
const host = argument('--host', '127.0.0.1');
const port = Number(argument('--port', '0'));
const readyFd = Number(argument('--ready-fd', '3'));

if (!scratchHome || !isAbsolute(scratchHome)) {
  bootFail('--home must be an absolute scratch path');
}
if (host !== '127.0.0.1') bootFail('refusing non-loopback host');
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  bootFail('--port must be 0..65535');
}
if (!Number.isInteger(readyFd) || readyFd < 3) bootFail('--ready-fd must be >=3');

const poisoned = Object.keys(process.env).filter(
  (key) =>
    key === 'ECHO_HOME' ||
    key === 'ECHO_CONTEXT_HOME' ||
    key.startsWith('ECHO_REPO') ||
    /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key),
);
if (poisoned.length > 0) {
  bootFail(`unsafe inherited environment keys: ${poisoned.sort().join(',')}`);
}

const allowedEnvironment = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'LANG',
  'LC_ALL',
  'TZ',
]);
for (const key of Object.keys(process.env)) {
  if (!allowedEnvironment.has(key)) delete process.env[key];
}

const insideScratchHome = (value) =>
  resolve(value) === resolve(scratchHome) ||
  resolve(value).startsWith(`${resolve(scratchHome)}${sep}`);
if (process.env.HOME !== scratchHome) bootFail('sanitized HOME must equal --home');
for (const key of [
  'TMPDIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
]) {
  const value = process.env[key];
  if (!value || !insideScratchHome(value)) {
    bootFail(`${key} must be inside --home`);
  }
}

const { startContextRuntime } = await import('../src/runtime/context-runtime.js');
let runtime;
try {
  runtime = await startContextRuntime({
    home: scratchHome,
    dataDir: join(scratchHome, 'data'),
    dbPath: join(scratchHome, 'data', 'context.db'),
    host,
    port,
    capture: {
      codex: false,
      claudeCode: false,
      cursor: false,
      codexSessionsDir: join(scratchHome, 'sources', 'codex'),
      claudeProjectsDir: join(scratchHome, 'sources', 'claude'),
      cursorGlobalDb: join(scratchHome, 'sources', 'cursor-global.db'),
      cursorWorkspaceDir: join(scratchHome, 'sources', 'cursor-workspaces'),
    },
    identity: {
      instanceNonce: null,
      artifactDigest: null,
      promotionReceiptDigest: null,
      databaseDigest: null,
    },
  });
} catch (error) {
  process.stderr.write(
    `verify-service-parity: startup failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}

writeSync(
  readyFd,
  `${JSON.stringify({ host, port: runtime.mcp.port, pid: process.pid })}\n`,
);

let shutdownStarted = false;
function shutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  const failureTimer = setTimeout(() => {
    process.stderr.write(
      `verify-service-parity: graceful shutdown deadline exceeded after ${signal}\n`,
    );
    process.exit(1);
  }, API.limits.graceful_shutdown_ms);
  failureTimer.unref();
  void runtime.stop().then(
    () => {
      clearTimeout(failureTimer);
      process.exit(0);
    },
    (error) => {
      clearTimeout(failureTimer);
      process.stderr.write(
        `verify-service-parity: shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    },
  );
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
