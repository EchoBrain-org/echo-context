#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_PATH = join(ROOT, 'tools', 'secret-scan-contract.json');
const SUPPORTED_KEYS = new Set(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']);

function die(message) {
  throw new Error(`secret-scan: ${message}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function platformKey(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  if (!SUPPORTED_KEYS.has(key)) die(`unsupported scanner platform ${key}`);
  return key;
}

function validateContract(contract) {
  if (contract?.schema !== 'secret-scan-contract.v1' || contract.scanner !== 'gitleaks' || contract.version !== '8.30.1') {
    die('contract identity differs from reviewed gitleaks 8.30.1 contract');
  }
  if (JSON.stringify(Object.keys(contract.binary_sha256).sort()) !== JSON.stringify([...SUPPORTED_KEYS].sort())) {
    die('contract platform digest map is incomplete or contains an unsupported platform');
  }
  if (contract.configuration?.mode !== 'gitleaks-embedded-default' || contract.configuration?.external_config !== null) {
    die('contract configuration differs');
  }
  const expectedArgv = ['detect', '--source', '.', '--log-opts=--all', '--redact=100', '--no-banner', '--no-color', '--report-format', 'json', '--report-path', '<temporary-report>'];
  if (contract.invocation?.executable !== 'gitleaks' || JSON.stringify(contract.invocation.argv) !== JSON.stringify(expectedArgv)) {
    die('contract invocation differs');
  }
  if (JSON.stringify(contract.invocation.report_fields) !== JSON.stringify(['File', 'RuleID']) || contract.invocation.scope !== 'all-reachable-refs') {
    die('contract reporting or history scope differs');
  }
}

function git(args, options = {}) {
  return execFileSync('git', ['-C', ROOT, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' },
    ...options,
  });
}

function preflightHistory() {
  if (git(['rev-parse', '--is-shallow-repository']).trim() !== 'false') die('shallow checkout cannot prove full history');
  git(['fsck', '--full']);
  const remote = git(['remote', 'get-url', 'origin']).trim();
  if (!remote) die('origin is required for complete-ref preflight');
  const listed = execFileSync('git', ['ls-remote', 'origin'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).split('\n').filter(Boolean).map((line) => {
    const match = /^([0-9a-f]{40})\t(HEAD|refs\/.+)$/.exec(line);
    if (!match) die(`malformed remote ref listing row: ${line}`);
    return { oid: match[1], ref: match[2] };
  });
  for (const { oid, ref } of listed) {
    if (ref === 'HEAD') {
      if (!listed.some((row) => row.ref.startsWith('refs/') && row.oid === oid)) die('remote HEAD does not resolve to an advertised source ref');
      git(['cat-file', '-e', `${oid}^{object}`]);
      continue;
    }
    const candidates = ref.startsWith('refs/heads/')
        ? [`refs/remotes/origin/${ref.slice('refs/heads/'.length)}`, `refs/echo-scan/${ref.slice('refs/'.length)}`]
        : ref.startsWith('refs/tags/')
          ? [ref, `refs/echo-scan/${ref.slice('refs/'.length)}`]
          : [ref, `refs/echo-scan/${ref.slice('refs/'.length)}`];
    const localOid = candidates.map((candidate) => {
      try {
        return git(['rev-parse', candidate]).trim();
      } catch {
        return null;
      }
    }).find((candidateOid) => candidateOid === oid);
    if (!localOid) die(`remote ref is absent, incomplete, or stale in checkout: ${ref}`);
    git(['cat-file', '-e', `${oid}^{object}`]);
  }
  return listed.length;
}

export function scanWith({ binary, contract, reportPath, spawn = spawnSync }) {
  validateContract(contract);
  const key = platformKey();
  let binaryPath;
  try {
    const candidate = binary.includes('/')
      ? binary
      : (process.env.PATH ?? '').split(delimiter).map((directory) => join(directory, binary)).find((path) => {
          try {
            accessSync(path, constants.X_OK);
            return true;
          } catch {
            return false;
          }
        });
    if (!candidate) throw new Error('not found on PATH');
    binaryPath = realpathSync(candidate);
  } catch {
    die('gitleaks binary is missing or unreadable');
  }
  const actualDigest = sha256(readFileSync(binaryPath));
  if (actualDigest !== contract.binary_sha256[key]) die(`gitleaks binary digest mismatch for ${key}`);
  const version = spawn(binaryPath, ['version'], { cwd: ROOT, encoding: 'utf8', shell: false });
  if (version.status !== 0 || version.stdout.trim() !== contract.version) die('gitleaks version check failed');
  const argv = contract.invocation.argv.map((value) => value === '<temporary-report>' ? reportPath : value);
  const result = spawn(binaryPath, argv, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: false,
    env: { ...process.env, NO_COLOR: '1' },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status === 0) return { findings: [] };
  let findings;
  try {
    const parsed = JSON.parse(readFileSync(reportPath, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('report is not an array');
    findings = parsed.map((row) => ({ File: String(row.File ?? ''), RuleID: String(row.RuleID ?? '') }));
    if (findings.some((row) => !row.File || !row.RuleID)) throw new Error('report lacks reviewed fields');
  } catch {
    die('scanner infrastructure failed without a valid redacted report');
  }
  if (findings.length === 0) die('scanner returned nonzero without findings');
  return { findings };
}

function main() {
  if (process.argv.length !== 2) die('no arguments are accepted');
  const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));
  validateContract(contract);
  const refCount = preflightHistory();
  const directory = mkdtempSync(join(tmpdir(), 'echo-context-secret-scan-'));
  const reportPath = join(directory, 'report.json');
  try {
    const binary = process.env.GITLEAKS_BIN ?? 'gitleaks';
    const result = scanWith({ binary, contract, reportPath });
    if (result.findings.length > 0) {
      for (const finding of result.findings.sort((a, b) => `${a.File}\0${a.RuleID}`.localeCompare(`${b.File}\0${b.RuleID}`))) {
        process.stderr.write(`File=${finding.File}\tRuleID=${finding.RuleID}\n`);
      }
      die(`${result.findings.length} secret finding(s); values suppressed`);
    }
    process.stdout.write(`secret-scan OK: ${refCount} remote source ref(s), full reachable history\n`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

export { platformKey, preflightHistory, validateContract };
