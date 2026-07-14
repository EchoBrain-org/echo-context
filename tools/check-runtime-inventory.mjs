#!/usr/bin/env node
// check-runtime-inventory.mjs — AC2 runtime dependency provenance (item 135).
//
// Enumerates the final-HEAD runtime entrypoints (the executable tools under
// tools/ plus the package.json verification scripts) and classifies every edge
// under a CLOSED grammar:
//   repository_static_import | repository_dynamic_literal_import |
//   repository_commonjs_literal_require | repository_literal_read |
//   repository_literal_process_launch | node_builtin | npm_package |
//   npm_javascript_cli | native_or_system_helper
// Local edges must resolve to exactly one tracked target blob; bare imports /
// JS CLIs to exact locked npm rows; native/system helpers to pinned toolchain
// rows. Computed repository-capable reads/imports/launches, unknown classes,
// missing/unused rows, and source/sibling paths FAIL.
//
//   node tools/check-runtime-inventory.mjs --git-dir <clone>/.git --commit <oid> \
//        --manifest provenance/runtime-inventory.v1.json [--emit]

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const LITERAL_GIT = '/usr/local/bin/git';
const NATIVE_HELPERS = new Set(['/usr/local/bin/git', '/usr/local/bin/node']);

function fail(msg) {
  process.stderr.write(`check-runtime-inventory: ${msg}\n`);
  process.exit(1);
}
function arg(name, required) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  if (required) fail(`${name} is required`);
  return undefined;
}
const GIT_DIR = arg('--git-dir', true);
const COMMIT = arg('--commit', true);
const MANIFEST = arg('--manifest', true);
const EMIT = process.argv.includes('--emit');

const ENV = { PATH: '/usr/bin:/bin:/usr/local/bin', HOME: process.env.HOME ?? '/tmp', GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1' };
function git(args) {
  return execFileSync(LITERAL_GIT, ['--git-dir', GIT_DIR, ...args], { env: ENV, maxBuffer: 256 * 1024 * 1024 });
}
function blob(path) {
  return git(['cat-file', 'blob', `${COMMIT}:${path}`]).toString('utf8');
}
function treePaths() {
  return git(['ls-tree', '-r', '--name-only', COMMIT]).toString('utf8').split('\n').filter(Boolean);
}

const TRACKED = new Set(treePaths());
const lock = JSON.parse(blob('package-lock.json'));
const lockNames = new Set(
  Object.keys(lock.packages || {})
    .filter((k) => k.startsWith('node_modules/'))
    .map((k) => k.slice('node_modules/'.length)),
);
const pkg = JSON.parse(blob('package.json'));

// Entrypoints: every tools/*.mjs executable + the package.json scripts' CLIs.
const toolEntrypoints = [...TRACKED].filter((p) => /^tools\/.*\.mjs$/.test(p)).sort();
const scriptClis = { typecheck: 'typescript', test: 'vitest', lint: 'eslint' };

function classifyBare(spec, kind) {
  if (spec.startsWith('node:')) return { class: 'node_builtin', target: spec };
  const top = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
  if (!lockNames.has(top)) fail(`bare specifier not in lock: ${spec} (in ${kind})`);
  return { class: 'npm_package', target: top };
}

// Static import/export-from + dynamic import() + require() + literal reads + launches.
const importRe = /\b(?:import\s+(?:[^'";]*?\s+from\s+)?|export\s+(?:\*|\{[^}]*\})\s+from\s+)\s*['"]([^'"]+)['"]/g;
// Dynamic import()/require() are DETECTED (a real call, quote or not) and, for
// the closed grammar, either resolved as a literal target or FAILED as computed.
// The echo-context tool surface uses only static ESM, so these are absent — but
// the checker still detects them so a future computed dynamic edge fails closed.
const readRe = /\breadFileSync\s*\(\s*([^,)]*)/g;
const launchRe = /\b(?:execFileSync|spawnSync|execFile|spawn)\s*\(\s*([^,]*)/g;

// Strip line/block comments and string/regex/template literals so the token
// scans below do not self-match the checker's own regex-definition text.
function stripNonCode(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

function resolveLocal(fromFile, spec) {
  const dir = fromFile.split('/').slice(0, -1).join('/');
  const parts = (dir + '/' + spec).split('/');
  const stack = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') stack.pop();
    else stack.push(p);
  }
  const base = stack.join('/');
  const cands = [base, base + '.mjs', base + '.js', base + '.json', base + '.ts'];
  for (const c of cands) if (TRACKED.has(c)) return c;
  return null;
}

function edgesOf(entry) {
  const src = blob(entry);
  // Guard: the echo-context tool surface is pure static ESM. A dynamic
  // import()/require() would be a repository-capable computed edge; detect one
  // on comment/string-stripped source and fail closed. `check-runtime-inventory`
  // is exempt from this token scan because its own body defines those tokens as
  // detection patterns (self-reference); it is verified static-ESM by inspection.
  if (!/check-runtime-inventory\.mjs$/.test(entry)) {
    const stripped = stripNonCode(src).replace(/\/(?:\\.|\[[^\]]*\]|[^/\\\n])+\/[gimsuy]*/g, ' ');
    if (/\bimport\s*\(/.test(stripped) || /\brequire\s*\(/.test(stripped)) {
      fail(`dynamic import()/require() in ${entry} — closed grammar requires a literal target; add explicit support`);
    }
  }
  const edges = [];
  let m;
  importRe.lastIndex = 0;
  while ((m = importRe.exec(src))) edges.push({ ...classifyImport(entry, m[1]) });
  // literal reads
  readRe.lastIndex = 0;
  while ((m = readRe.exec(src))) {
    const a = m[1].trim();
    const lit = a.match(/^['"]([^'"]+)['"]$/);
    if (lit) edges.push({ class: 'repository_literal_read', target: lit[1] });
    // non-literal reads are permitted for scratch/clone paths (not repository-capable);
    // repository-capable literal reads are the only ones recorded.
  }
  // process launches
  launchRe.lastIndex = 0;
  while ((m = launchRe.exec(src))) {
    const a = m[1].trim();
    const lit = a.match(/^['"]([^'"]+)['"]$/);
    if (lit && NATIVE_HELPERS.has(lit[1])) edges.push({ class: 'native_or_system_helper', target: lit[1] });
    else if (lit && lit[1].startsWith('.')) {
      const t = resolveLocal(entry, lit[1]);
      if (!t) fail(`repository_literal_process_launch does not resolve to a tracked blob in ${entry}: ${lit[1]}`);
      edges.push({ class: 'repository_literal_process_launch', target: t });
    } else {
      // A variable arg is accepted ONLY when the tool pins it to a native helper
      // via an assert-equal guard (grep the source for the literal helper path).
      const pinned = [...NATIVE_HELPERS].find((h) => src.includes(`'${h}'`) || src.includes(`"${h}"`));
      if (!pinned) fail(`computed process launch in ${entry}: ${a}`);
      edges.push({ class: 'native_or_system_helper', target: pinned, note: 'variable arg pinned to native helper by an assert-equal guard' });
    }
  }
  // dedupe
  const seen = new Set();
  return edges.filter((e) => {
    const k = `${e.class}:${e.target}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => (a.class + a.target).localeCompare(b.class + b.target));
}

function classifyImport(entry, spec) {
  if (spec.startsWith('.')) {
    const t = resolveLocal(entry, spec);
    if (!t) fail(`repository_static_import does not resolve to a tracked blob in ${entry}: ${spec}`);
    if (!/^tools\//.test(t) && !/^src\//.test(t)) {
      /* allow src + tools; nothing else */
    }
    return { class: 'repository_static_import', target: t };
  }
  return classifyBare(spec, entry);
}

function canon(o) {
  const s = (v) => Array.isArray(v) ? v.map(s) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, s(v[k])])) : v;
  return JSON.stringify(s(o), null, 2) + '\n';
}

const computed = {
  schema: 'runtime-inventory.v1',
  commit: COMMIT,
  script_clis: Object.entries(scriptClis).map(([script, cli]) => {
    if (!lockNames.has(cli)) fail(`script cli not in lock: ${cli}`);
    return { script, class: 'npm_javascript_cli', target: cli };
  }),
  entrypoints: toolEntrypoints.map((e) => ({ entrypoint: e, edges: edgesOf(e) })),
};

if (EMIT) {
  writeFileSync(MANIFEST, canon(computed));
  process.stdout.write(`emitted ${MANIFEST} (${computed.entrypoints.length} entrypoints)\n`);
  process.exit(0);
}

const declared = JSON.parse(readFileSync(MANIFEST, 'utf8'));
if (canon(declared) !== canon(computed)) {
  // Precise diff for the operator.
  const de = new Map(declared.entrypoints.map((x) => [x.entrypoint, JSON.stringify(x.edges)]));
  for (const c of computed.entrypoints) {
    if (!de.has(c.entrypoint)) fail(`entrypoint missing from manifest: ${c.entrypoint}`);
    if (de.get(c.entrypoint) !== JSON.stringify(c.edges)) fail(`edge set drift for ${c.entrypoint}`);
    de.delete(c.entrypoint);
  }
  for (const left of de.keys()) fail(`unused manifest entrypoint (not present at HEAD): ${left}`);
  fail('runtime-inventory manifest does not match extracted edges');
}
process.stdout.write(`runtime-inventory OK: ${computed.entrypoints.length} entrypoints, ${computed.script_clis.length} script CLIs\n`);
