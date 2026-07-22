import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');

function git(args) {
  const result = spawnSync('/usr/bin/git', args, {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}

const worktreeStatus = git(['status', '--porcelain=v1', '--untracked-files=all']);
if (worktreeStatus.length > 0) {
  throw new Error(
    'refusing to build a promotable package from a dirty worktree; commit the reviewed source first',
  );
}
const sourceCommit = git(['rev-parse', '--verify', 'HEAD']);
if (!/^[a-f0-9]{40}$/.test(sourceCommit)) {
  throw new Error(`invalid source commit: ${sourceCommit}`);
}

rmSync(dist, { recursive: true, force: true });

const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const built = spawnSync(process.execPath, [tsc, '--project', join(root, 'tsconfig.build.json')], {
  cwd: root,
  stdio: 'inherit',
});
if (built.status !== 0) process.exit(built.status ?? 1);

const sourceMigrations = join(root, 'src', 'storage', 'migrations');
const targetMigrations = join(dist, 'storage', 'migrations');
if (!existsSync(sourceMigrations)) throw new Error('storage migrations directory is missing');
mkdirSync(targetMigrations, { recursive: true });
cpSync(sourceMigrations, targetMigrations, { recursive: true });
chmodSync(join(dist, 'cli.js'), 0o755);

const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifestPath = join(dist, 'artifact-manifest.json');
const packageFiles = [
  join(root, 'package.json'),
  join(root, 'npm-shrinkwrap.json'),
  join(root, 'context-tools.v2.json'),
  join(root, 'schemas', 'service-api.v1.json'),
  join(root, 'README.md'),
  join(root, 'LICENSE'),
];

function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (path === manifestPath) continue;
    if (entry.isDirectory()) visit(path);
    else if (entry.isFile()) packageFiles.push(path);
  }
}

visit(dist);
const files = packageFiles
  .map((path) => {
    const content = readFileSync(path);
    return {
      path: relative(root, path).split('\\').join('/'),
      bytes: statSync(path).size,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
  })
  // The runtime verifier enforces ordinal string order. localeCompare() is
  // locale-sensitive and can place uppercase package files after dist/.
  .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
const body = {
  schemaVersion: 1,
  packageVersion: packageJson.version,
  sourceCommit,
  files,
};
const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex');
writeFileSync(manifestPath, `${JSON.stringify({ ...body, digest }, null, 2)}\n`, {
  mode: 0o644,
});
