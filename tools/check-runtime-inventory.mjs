#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

function die(message) {
  throw new Error(`check-runtime-inventory: ${message}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonical(value) {
  const sort = (item) => Array.isArray(item)
    ? item.map(sort)
    : item && typeof item === 'object'
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key])]))
      : item;
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

function parseArgs(argv) {
  const flags = new Set(['--emit']);
  const keys = new Set(['--git-dir', '--commit', '--manifest']);
  const values = new Map();
  let emit = false;
  for (let i = 0; i < argv.length;) {
    if (flags.has(argv[i])) {
      if (emit) die('duplicate --emit');
      emit = true;
      i += 1;
      continue;
    }
    if (!keys.has(argv[i]) || !argv[i + 1] || values.has(argv[i])) die('usage: --git-dir <path> --commit <sha> --manifest <path> [--emit]');
    values.set(argv[i], argv[i + 1]);
    i += 2;
  }
  if (values.size !== 3) die('usage: --git-dir <path> --commit <sha> --manifest <path> [--emit]');
  return { gitDir: values.get('--git-dir'), commit: values.get('--commit'), manifest: values.get('--manifest'), emit };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const git = (argv, encoding = null) => execFileSync('git', ['--git-dir', args.gitDir, ...argv], {
    encoding,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' },
  });
  const commit = git(['rev-parse', `${args.commit}^{commit}`], 'utf8').trim();
  const treeRows = git(['ls-tree', '-r', '-z', commit]).toString('utf8').split('\0').filter(Boolean).map((line) => {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/.exec(line);
    if (!match) die(`unsupported tree row: ${line}`);
    return { mode: match[1], oid: match[2], path: match[3] };
  });
  const tracked = new Map(treeRows.map((row) => [row.path, row]));
  const blob = (path) => {
    if (!tracked.has(path)) die(`untracked inventory input: ${path}`);
    return git(['cat-file', 'blob', `${commit}:${path}`]);
  };
  const pkgBytes = blob('package.json');
  const lockBytes = blob('package-lock.json');
  const pkg = JSON.parse(pkgBytes.toString('utf8'));
  const lock = JSON.parse(lockBytes.toString('utf8'));
  const lockRows = lock.packages ?? {};
  const packageRoots = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
  const resolveLockPath = (issuer, name) => {
    let cursor = issuer;
    for (;;) {
      const candidate = cursor ? `${cursor}/node_modules/${name}` : `node_modules/${name}`;
      if (Object.hasOwn(lockRows, candidate)) return candidate;
      const marker = cursor.lastIndexOf('/node_modules/');
      if (marker < 0) break;
      cursor = cursor.slice(0, marker);
    }
    return Object.hasOwn(lockRows, `node_modules/${name}`) ? `node_modules/${name}` : null;
  };
  const closure = [];
  const queue = [...packageRoots].sort().map((name) => `node_modules/${name}`);
  const visited = new Set();
  while (queue.length) {
    const lockPath = queue.shift();
    if (visited.has(lockPath)) continue;
    const row = lockRows[lockPath];
    if (!row || typeof row.version !== 'string' || typeof row.integrity !== 'string') die(`incomplete lock row: ${lockPath}`);
    visited.add(lockPath);
    const dependencies = [];
    for (const [kind, values] of [['dependency', row.dependencies ?? {}], ['optional_dependency', row.optionalDependencies ?? {}], ['peer_dependency', row.peerDependencies ?? {}]]) {
      for (const name of Object.keys(values).sort()) {
        const child = resolveLockPath(lockPath, name);
        const optional = kind !== 'dependency' || row.peerDependenciesMeta?.[name]?.optional === true;
        if (!child) {
          if (optional) continue;
          die(`unresolved ${kind} ${name} from ${lockPath}`);
        }
        dependencies.push({ kind, name, lock_path: child });
        queue.push(child);
      }
    }
    queue.sort();
    closure.push({
      lock_path: lockPath,
      version: row.version,
      integrity: row.integrity,
      os: row.os ?? [],
      cpu: row.cpu ?? [],
      optional: row.optional === true,
      dependencies: dependencies.sort((a, b) => `${a.kind}\0${a.name}`.localeCompare(`${b.kind}\0${b.name}`)),
    });
  }
  closure.sort((a, b) => a.lock_path.localeCompare(b.lock_path));

  const executableSources = treeRows.filter((row) =>
    /^tools\/.+\.(?:mjs|sh)$/.test(row.path) ||
    ['tsconfig.json', 'eslint.config.mjs', 'vitest.ci.config.ts', 'vitest.operator.config.ts'].includes(row.path),
  ).sort((a, b) => a.path.localeCompare(b.path)).map((row) => {
    const bytes = blob(row.path);
    if (row.path.endsWith('.sh') && row.mode !== '100755') die(`${row.path} must be executable`);
    return { path: row.path, mode: row.mode, blob_oid: row.oid, content_sha256: sha256(bytes) };
  });
  const scripts = Object.entries(pkg.scripts ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, command]) => {
    if (typeof command !== 'string' || /[|;&`$()]/.test(command)) die(`script ${name} is outside the closed command grammar`);
    const tokens = command.trim().split(/\s+/);
    const first = tokens[0];
    const allowed = first === 'node' || first === 'npm' || first === 'tsc' || first === 'eslint' || first === 'vitest' || /^tools\/.+\.sh$/.test(first);
    if (!allowed) die(`script ${name} uses unlisted executable ${first}`);
    if (first.startsWith('tools/') && !tracked.has(first)) die(`script ${name} references untracked executable ${first}`);
    return { name, command, executable: first, argv: tokens.slice(1) };
  });
  const computed = {
    schema: 'runtime-inventory.v2',
    package_json_sha256: sha256(pkgBytes),
    lock_sha256: sha256(lockBytes),
    scripts,
    executable_sources: executableSources,
    npm_closure: closure,
    system_helpers: ['git', 'gitleaks', 'node', 'npm'],
  };
  if (args.emit) {
    writeFileSync(args.manifest, canonical(computed));
    process.stdout.write(`runtime-inventory.v2 emitted: ${closure.length} packages, ${executableSources.length} sources\n`);
  } else {
    const declared = JSON.parse(readFileSync(args.manifest, 'utf8'));
    if (canonical(declared) !== canonical(computed)) die('runtime-inventory.v2 differs from the committed successor closure');
    process.stdout.write(`runtime-inventory.v2 OK: ${closure.length} packages, ${executableSources.length} sources\n`);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
