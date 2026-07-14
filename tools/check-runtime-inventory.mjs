#!/usr/bin/env node
// AC2: derive the complete runtime closure from final-HEAD entrypoints.
// The checker reads source bytes from Git objects, never from the checkout.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { posix as path } from 'node:path';
import ts from 'typescript';

const GIT = '/usr/local/bin/git';
const NODE = '/usr/local/bin/node';
const NPM_CLI = '/usr/local/lib/node_modules/npm/bin/npm-cli.js';
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const CLASSES = new Set([
  'repository_static_import',
  'repository_dynamic_literal_import',
  'repository_commonjs_literal_require',
  'repository_literal_read',
  'repository_literal_process_launch',
  'node_builtin',
  'npm_package',
  'npm_javascript_cli',
  'native_or_system_helper',
]);
const SYSTEM_HELPERS = new Map([
  ['/usr/local/bin/git', GIT],
  ['git', GIT],
  ['/usr/local/bin/node', NODE],
  ['node', NODE],
  [SANDBOX_EXEC, SANDBOX_EXEC],
  [NPM_CLI, NPM_CLI],
]);

function die(message) {
  throw new Error(`check-runtime-inventory: ${message}`);
}
function arg(name, required = false) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
  if (required) die(`${name} is required`);
  return undefined;
}
const GIT_DIR = arg('--git-dir', true);
const COMMIT = arg('--commit', true);
const MANIFEST = arg('--manifest', true);
const EMIT = process.argv.includes('--emit');
const ENV = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/nonexistent',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_OPTIONAL_LOCKS: '0',
};
function git(args, encoding = null) {
  return execFileSync(GIT, ['--git-dir', GIT_DIR, ...args], {
    env: ENV,
    encoding,
    maxBuffer: 256 * 1024 * 1024,
  });
}
function blob(file) {
  return git(['cat-file', 'blob', `${COMMIT}:${file}`], 'utf8');
}
const TRACKED = new Set(
  git(['ls-tree', '-r', '--name-only', COMMIT], 'utf8').split('\n').filter(Boolean),
);
const PACKAGE = JSON.parse(blob('package.json'));
const LOCK = JSON.parse(blob('package-lock.json'));
const LOCK_ROWS = new Map(
  Object.entries(LOCK.packages ?? {}).filter(([key]) => key.startsWith('node_modules/')),
);
const LOCK_PACKAGES = new Map(
  [...LOCK_ROWS].filter(([key]) => !key.slice('node_modules/'.length).includes('/node_modules/'))
    .map(([key, value]) => [key.slice('node_modules/'.length), value]),
);
const PLATFORM = { os: process.platform, cpu: process.arch };

function canonical(value) {
  const sort = (item) =>
    Array.isArray(item)
      ? item.map(sort)
      : item && typeof item === 'object'
        ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key])]))
        : item;
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}
function topPackage(specifier) {
  return specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];
}
function packageNameFromLockPath(lockPath) {
  const tail = lockPath.slice(lockPath.lastIndexOf('node_modules/') + 'node_modules/'.length);
  return tail.startsWith('@') ? tail.split('/').slice(0, 2).join('/') : tail.split('/')[0];
}
function platformAllows(row) {
  const allows = (rules, value) => {
    if (!Array.isArray(rules) || rules.length === 0) return true;
    if (rules.includes(`!${value}`)) return false;
    const positive = rules.filter((rule) => !String(rule).startsWith('!'));
    return positive.length === 0 || positive.includes(value);
  };
  return allows(row.os, PLATFORM.os) && allows(row.cpu, PLATFORM.cpu);
}
function lockedPackage(specifier) {
  const name = topPackage(specifier);
  const row = LOCK_PACKAGES.get(name);
  if (!row || typeof row.version !== 'string') die(`npm package is not exactly represented in lock: ${specifier}`);
  if (typeof row.integrity !== 'string') die(`npm package lacks integrity: ${name}`);
  return { name, lock_path: `node_modules/${name}`, version: row.version, integrity: row.integrity };
}
function packageForCli(cli) {
  const matches = [];
  for (const [name, row] of LOCK_PACKAGES) {
    const bins = typeof row.bin === 'string' ? { [name]: row.bin } : row.bin ?? {};
    if (Object.hasOwn(bins, cli)) matches.push(name);
  }
  if (matches.length !== 1) die(`npm CLI ${cli} resolves to ${matches.length} locked packages (${matches.join(', ')})`);
  return matches[0];
}
function resolveLockedDependency(issuerPath, name) {
  let cursor = issuerPath;
  for (;;) {
    const candidate = cursor ? `${cursor}/node_modules/${name}` : `node_modules/${name}`;
    if (LOCK_ROWS.has(candidate)) return candidate;
    const marker = cursor.lastIndexOf('/node_modules/');
    if (marker < 0) break;
    cursor = cursor.slice(0, marker);
  }
  const root = `node_modules/${name}`;
  return LOCK_ROWS.has(root) ? root : null;
}
function npmClosure(rootPaths) {
  const visited = new Set();
  const rows = [];
  const queue = [...new Set(rootPaths)].sort();
  while (queue.length > 0) {
    const lockPath = queue.shift();
    if (visited.has(lockPath)) continue;
    const row = LOCK_ROWS.get(lockPath);
    if (!row) die(`npm closure references missing lock row: ${lockPath}`);
    if (!platformAllows(row)) die(`runtime npm root is unavailable on ${PLATFORM.os}/${PLATFORM.cpu}: ${lockPath}`);
    if (typeof row.version !== 'string' || typeof row.integrity !== 'string') die(`npm closure row lacks version/integrity: ${lockPath}`);
    visited.add(lockPath);
    const dependencies = [];
    const kinds = [
      ['dependency', row.dependencies ?? {}],
      ['optional_dependency', row.optionalDependencies ?? {}],
      ['peer_dependency', row.peerDependencies ?? {}],
    ];
    const seenNames = new Set();
    for (const [kind, declared] of kinds) {
      for (const name of Object.keys(declared).sort()) {
        if (seenNames.has(name)) continue;
        seenNames.add(name);
        const optional = kind === 'optional_dependency' || row.peerDependenciesMeta?.[name]?.optional === true;
        const dependencyPath = resolveLockedDependency(lockPath, name);
        if (!dependencyPath) {
          if (optional) continue;
          die(`unresolved ${kind} ${name} from ${lockPath}`);
        }
        const dependencyRow = LOCK_ROWS.get(dependencyPath);
        if (!platformAllows(dependencyRow)) {
          if (optional) continue;
          die(`required ${kind} ${dependencyPath} rejects ${PLATFORM.os}/${PLATFORM.cpu}`);
        }
        dependencies.push({ name, kind, lock_path: dependencyPath });
        queue.push(dependencyPath);
      }
    }
    const bins = typeof row.bin === 'string'
      ? { [packageNameFromLockPath(lockPath)]: row.bin }
      : Object.fromEntries(Object.entries(row.bin ?? {}).sort(([a], [b]) => a.localeCompare(b)));
    const runtimeFiles = Object.values(bins).map((file) => `${lockPath}/${String(file).replace(/^\.\//, '')}`);
    if (packageNameFromLockPath(lockPath).startsWith('@esbuild/')) runtimeFiles.push(`${lockPath}/bin/esbuild`);
    rows.push({
      lock_path: lockPath,
      name: packageNameFromLockPath(lockPath),
      version: row.version,
      integrity: row.integrity,
      dependencies: dependencies.sort((a, b) => `${a.kind}\0${a.name}`.localeCompare(`${b.kind}\0${b.name}`)),
      runtime_files: [...new Set(runtimeFiles)].sort(),
    });
    queue.sort();
  }
  return rows.sort((a, b) => a.lock_path.localeCompare(b.lock_path));
}
function resolveLocal(from, specifier) {
  const base = path.normalize(path.join(path.dirname(from), specifier));
  const candidates = [base, `${base}.mjs`, `${base}.js`, `${base}.ts`, `${base}.json`, path.join(base, 'index.ts'), path.join(base, 'index.js')];
  if (base.endsWith('.js')) candidates.push(base.slice(0, -3) + '.ts');
  const matches = [...new Set(candidates)].filter((candidate) => TRACKED.has(candidate));
  if (matches.length !== 1) die(`local edge from ${from} (${specifier}) resolves to ${matches.length} tracked blobs: ${matches.join(', ')}`);
  return matches[0];
}
function scriptKind(file) {
  return file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
}
function parse(file) {
  return ts.createSourceFile(file, blob(file), ts.ScriptTarget.Latest, true, scriptKind(file));
}
function nodeText(node, sourceFile) {
  return node.getText(sourceFile);
}
function isImportMetaUrl(node) {
  return ts.isPropertyAccessExpression(node) && node.name.text === 'url' &&
    ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword;
}
function literalValue(node) {
  return ts.isStringLiteralLike(node) ? node.text : null;
}
function buildConstants(sourceFile, file) {
  const values = new Map();
  const evaluate = (node) => {
    const literal = literalValue(node);
    if (literal !== null) return { kind: 'string', value: literal };
    if (ts.isIdentifier(node)) return values.get(node.text) ?? null;
    if (isImportMetaUrl(node)) return { kind: 'repo-file', value: file };
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const fn = node.expression.text;
      if ((fn === 'dirname' || fn === 'fileURLToPath') && node.arguments.length === 1) {
        const value = evaluate(node.arguments[0]);
        if (!value) return null;
        if (fn === 'fileURLToPath') return value;
        if (value.kind === 'repo-file' || value.kind === 'repo-path') return { kind: 'repo-path', value: path.dirname(value.value) };
      }
      if ((fn === 'join' || fn === 'resolve') && node.arguments.length > 0) {
        const parts = node.arguments.map(evaluate);
        if (parts.some((part) => part === null)) return null;
        const first = parts[0];
        if (first.kind === 'repo-file' || first.kind === 'repo-path') {
          if (parts.slice(1).some((part) => part.kind !== 'string')) return null;
          return { kind: 'repo-path', value: path.normalize(path.join(first.value, ...parts.slice(1).map((part) => part.value))) };
        }
        if (parts.every((part) => part.kind === 'string')) return { kind: 'string', value: path.join(...parts.map((part) => part.value)) };
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL' && node.arguments?.length === 2) {
      const relative = literalValue(node.arguments[0]);
      if (relative !== null && isImportMetaUrl(node.arguments[1])) {
        return { kind: 'repo-path', value: path.normalize(path.join(path.dirname(file), relative)) };
      }
    }
    return null;
  };
  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node) => {
      const declarationList = ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent) ? node.parent : null;
      if (
        ts.isVariableDeclaration(node) &&
        declarationList &&
        (declarationList.flags & ts.NodeFlags.Const) !== 0 &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        !values.has(node.name.text)
      ) {
        const value = evaluate(node.initializer);
        if (value) {
          values.set(node.name.text, value);
          changed = true;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return { values, evaluate };
}

function analyzeEntrypoint(entrypoint) {
  const modules = new Set();
  const packageRoots = new Set();
  const edges = [];
  const seenEdges = new Set();
  const add = (from, klass, target, extra = {}) => {
    if (!CLASSES.has(klass)) die(`internal unknown edge class ${klass}`);
    const key = `${from}\0${klass}\0${target}\0${extra.lock_path ?? ''}\0${extra.package_subpath ?? ''}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push({ from, class: klass, target, ...extra });
  };
  const addBare = (from, specifier) => {
    if (specifier.startsWith('node:')) return add(from, 'node_builtin', specifier);
    const locked = lockedPackage(specifier);
    packageRoots.add(locked.lock_path);
    add(from, 'npm_package', locked.name, {
      lock_path: locked.lock_path,
      version: locked.version,
      integrity: locked.integrity,
      ...(specifier !== locked.name ? { package_subpath: specifier.slice(locked.name.length + 1) } : {}),
    });
    if (locked.name === 'better-sqlite3') {
      const toolchain = JSON.parse(blob('provenance/native-toolchain.v1.json'));
      const native = toolchain.native_artifact;
      if (!native || native.path !== 'node_modules/better-sqlite3/build/Release/better_sqlite3.node' || !/^[0-9a-f]{64}$/.test(native.sha256 ?? '')) {
        die('better-sqlite3 native binding is not pinned by native-toolchain.v1.json');
      }
      add(from, 'native_or_system_helper', native.path, { sha256: native.sha256 });
    }
  };
  const visitModule = (file) => {
    if (modules.has(file)) return;
    if (!TRACKED.has(file)) die(`runtime module is not tracked: ${file}`);
    modules.add(file);
    const sourceFile = parse(file);
    const { values, evaluate } = buildConstants(sourceFile, file);
    const fsCalls = new Map();
    const childCalls = new Map();
    const fsNamespaces = new Set();
    const childNamespaces = new Set();
    const createRequireCalls = new Set();
    const requireCalls = new Set(file.endsWith('.cjs') ? ['require'] : []);
    const FS_READ_APIS = new Set([
      'readFileSync', 'readFile', 'readdirSync', 'readdir', 'openSync', 'open',
      'createReadStream', 'statSync', 'stat', 'lstatSync', 'lstat', 'realpathSync',
      'realpath', 'existsSync', 'accessSync', 'access',
    ]);
    const CHILD_APIS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']);
    const collectImports = (node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const moduleName = node.moduleSpecifier.text;
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
          if (moduleName === 'node:fs' || moduleName === 'node:fs/promises') fsNamespaces.add(bindings.name.text);
          if (moduleName === 'node:child_process') childNamespaces.add(bindings.name.text);
        } else if (bindings && ts.isNamedImports(bindings)) {
          for (const binding of bindings.elements) {
            const original = binding.propertyName?.text ?? binding.name.text;
            if ((moduleName === 'node:fs' || moduleName === 'node:fs/promises') && FS_READ_APIS.has(original)) fsCalls.set(binding.name.text, original);
            if (moduleName === 'node:child_process' && CHILD_APIS.has(original)) childCalls.set(binding.name.text, original);
            if (moduleName === 'node:module' && original === 'createRequire') createRequireCalls.add(binding.name.text);
          }
        }
      }
      ts.forEachChild(node, collectImports);
    };
    collectImports(sourceFile);
    const collectRequireFactories = (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isVariableDeclarationList(node.parent) &&
        (node.parent.flags & ts.NodeFlags.Const) !== 0 &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        createRequireCalls.has(node.initializer.expression.text)
      ) requireCalls.add(node.name.text);
      ts.forEachChild(node, collectRequireFactories);
    };
    collectRequireFactories(sourceFile);
    const repoConstantNames = new Set(
      [...values].filter(([, value]) => value.kind === 'repo-file' || value.kind === 'repo-path').map(([name]) => name),
    );
    const addImport = (specifier, klass) => {
      if (specifier.startsWith('.')) {
        const target = resolveLocal(file, specifier);
        add(file, klass, target);
        if (klass === 'repository_dynamic_literal_import' && file.endsWith('.mjs') && target.endsWith('.ts')) {
          addBare(file, 'tsx');
        }
        if (/\.(?:[cm]?js|ts)$/.test(target)) visitModule(target);
      } else addBare(file, specifier);
    };
    const inspectPackagePath = (value) => {
      const match = value.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\/(.+)$/);
      if (!match) return;
      const packagePath = `node_modules/${match[1]}/${match[2]}`;
      if (NPM_CLI.endsWith(`/${packagePath}`)) {
        add(file, 'native_or_system_helper', NPM_CLI);
        return;
      }
      const locked = lockedPackage(match[1]);
      const lockedRow = LOCK_PACKAGES.get(locked.name);
      const bins = typeof lockedRow?.bin === 'string' ? [lockedRow.bin] : Object.values(lockedRow?.bin ?? {});
      if (!bins.some((bin) => String(bin).replace(/^\.\//, '') === match[2])) return;
      packageRoots.add(locked.lock_path);
      add(file, 'npm_javascript_cli', locked.name, {
        lock_path: locked.lock_path,
        package_subpath: match[2],
        version: locked.version,
        integrity: locked.integrity,
      });
    };
    const inspectRootImports = (embeddedSourceFile) => {
      const inspect = (node) => {
        if (ts.isStringLiteralLike(node)) inspectPackagePath(node.text);
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'rootImport') {
          const specifier = node.arguments.length === 1 ? literalValue(node.arguments[0]) : null;
          if (specifier === null) die(`computed rootImport in ${file}: ${nodeText(node, embeddedSourceFile)}`);
          if (specifier.startsWith('node_modules/')) addBare(file, specifier.slice('node_modules/'.length));
          else if (TRACKED.has(specifier)) {
            add(file, 'repository_dynamic_literal_import', specifier);
            if (/\.(?:[cm]?js|ts)$/.test(specifier)) visitModule(specifier);
          }
        }
        ts.forEachChild(node, inspect);
      };
      inspect(embeddedSourceFile);
    };
    const inspectEmbeddedLaunchers = (node) => {
      if (
        ts.isTaggedTemplateExpression(node) &&
        ts.isPropertyAccessExpression(node.tag) &&
        ts.isIdentifier(node.tag.expression) &&
        node.tag.expression.text === 'String' &&
        node.tag.name.text === 'raw' &&
        ts.isNoSubstitutionTemplateLiteral(node.template)
      ) {
        const embedded = ts.createSourceFile(`${file}#embedded`, node.template.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
        inspectRootImports(embedded);
      }
      ts.forEachChild(node, inspectEmbeddedLaunchers);
    };
    inspectEmbeddedLaunchers(sourceFile);
    const importedApi = (expression, direct, namespaces) => {
      if (ts.isIdentifier(expression)) return direct.get(expression.text) ?? null;
      if (
        ts.isPropertyAccessExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        namespaces.has(expression.expression.text)
      ) return expression.name.text;
      return null;
    };
    const containsRepositoryAnchor = (node) => {
      let found = false;
      const inspect = (candidate) => {
        if (isImportMetaUrl(candidate) || (ts.isIdentifier(candidate) && candidate.text === '__dirname')) found = true;
        if (!found) ts.forEachChild(candidate, inspect);
      };
      inspect(node);
      return found;
    };
    const visit = (node) => {
      if (ts.isStringLiteralLike(node)) inspectPackagePath(node.text);
      if (ts.isArrayLiteralExpression(node)) {
        for (let index = 0; index < node.elements.length - 1; index++) {
          if (literalValue(node.elements[index]) === '--import') {
            const loader = literalValue(node.elements[index + 1]);
            if (loader === null) die(`computed --import loader in ${file}: ${nodeText(node, sourceFile)}`);
            addBare(file, loader);
          }
        }
      }
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (ts.isImportDeclaration(node)) {
          const clause = node.importClause;
          const named = clause?.namedBindings;
          const namedAllTypeOnly =
            named && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every((element) => element.isTypeOnly);
          if (clause?.isTypeOnly || (!clause?.name && namedAllTypeOnly)) {
            ts.forEachChild(node, visit);
            return;
          }
        } else if (node.isTypeOnly) {
          ts.forEachChild(node, visit);
          return;
        }
        const specifier = node.moduleSpecifier && literalValue(node.moduleSpecifier);
        if (typeof specifier === 'string') addImport(specifier, 'repository_static_import');
      }
      if (ts.isCallExpression(node)) {
        const fsApi = importedApi(node.expression, fsCalls, fsNamespaces);
        const childApi = importedApi(node.expression, childCalls, childNamespaces);
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const specifier = node.arguments.length === 1 ? literalValue(node.arguments[0]) : null;
          if (specifier === null) die(`computed dynamic import in ${file}: ${nodeText(node, sourceFile)}`);
          addImport(specifier, 'repository_dynamic_literal_import');
        } else if (ts.isIdentifier(node.expression) && requireCalls.has(node.expression.text)) {
          const specifier = node.arguments.length === 1 ? literalValue(node.arguments[0]) : null;
          if (specifier === null) die(`computed require in ${file}: ${nodeText(node, sourceFile)}`);
          addImport(specifier, 'repository_commonjs_literal_require');
        } else if (ts.isIdentifier(node.expression) && node.expression.text === 'rootImport') {
          const specifier = node.arguments.length === 1 ? literalValue(node.arguments[0]) : null;
          if (specifier === null) die(`computed rootImport in ${file}: ${nodeText(node, sourceFile)}`);
          if (specifier.startsWith('node_modules/')) addBare(file, specifier.slice('node_modules/'.length));
          else if (TRACKED.has(specifier)) {
            add(file, 'repository_dynamic_literal_import', specifier);
            if (/\.(?:[cm]?js|ts)$/.test(specifier)) visitModule(specifier);
          }
        }
        const callee = ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : '';
        for (const argument of node.arguments) {
          if (ts.isIdentifier(argument) && (childCalls.has(argument.text) || fsCalls.has(argument.text))) {
            die(`indirect sensitive API use in ${file}: ${nodeText(node, sourceFile)}`);
          }
        }
        if (fsApi && node.arguments.length > 0) {
          const resolved = evaluate(node.arguments[0]);
          if (resolved && (resolved.kind === 'repo-file' || resolved.kind === 'repo-path')) {
            const target = resolved.value;
            if (TRACKED.has(target)) add(file, 'repository_literal_read', target);
            else {
              const children = [...TRACKED].filter((candidate) => candidate.startsWith(`${target}/`)).sort();
              if (children.length === 0) die(`repository read in ${file} resolves outside tracked tree: ${target}`);
              for (const child of children) add(file, 'repository_literal_read', child);
            }
          } else {
            const expression = nodeText(node.arguments[0], sourceFile);
            if (
              containsRepositoryAnchor(node.arguments[0]) ||
              [...repoConstantNames].some((name) => new RegExp(`\\b${name}\\b`).test(expression))
            ) {
              die(`computed repository-capable read in ${file}: ${nodeText(node, sourceFile)}`);
            }
          }
        }
        // A statically resolved repository directory passed into a helper is a
        // bounded asset set. Enumerate it here; a computed suffix inside that
        // helper cannot escape the sealed directory without changing this call.
        if (!['join', 'resolve', 'dirname', 'fileURLToPath'].includes(callee)) {
          for (const argument of node.arguments) {
            const resolved = evaluate(argument);
            if (resolved?.kind === 'repo-path' && !TRACKED.has(resolved.value)) {
              const children = [...TRACKED].filter((candidate) => candidate.startsWith(`${resolved.value}/`)).sort();
              for (const child of children) add(file, 'repository_literal_read', child);
            }
          }
        }
        if (childApi && node.arguments.length > 0) {
          if (childApi === 'exec' || childApi === 'execSync' || childApi === 'fork') {
            die(`unsupported process API ${childApi} in ${file}: ${nodeText(node, sourceFile)}`);
          }
          const command = evaluate(node.arguments[0]);
          const helper = command?.kind === 'string' ? SYSTEM_HELPERS.get(command.value) : null;
          if (!helper) die(`computed or unpinned process launch in ${file}: ${nodeText(node, sourceFile)}`);
          add(file, 'native_or_system_helper', helper);
          const collectNestedHelpers = (candidate) => {
            const value = evaluate(candidate);
            if (value?.kind === 'string') {
              const nested = SYSTEM_HELPERS.get(value.value);
              if (nested) add(file, 'native_or_system_helper', nested);
            } else if (
              helper === NODE &&
              (value?.kind === 'repo-file' || value?.kind === 'repo-path') &&
              TRACKED.has(value.value) &&
              /\.(?:[cm]?js|ts)$/.test(value.value)
            ) {
              add(file, 'repository_literal_process_launch', value.value);
              visitModule(value.value);
            }
            ts.forEachChild(candidate, collectNestedHelpers);
          };
          for (const processArgument of node.arguments.slice(1)) collectNestedHelpers(processArgument);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  };
  visitModule(entrypoint);
  return {
    entrypoint,
    modules: [...modules].sort(),
    edges: edges.sort((a, b) => `${a.from}\0${a.class}\0${a.target}`.localeCompare(`${b.from}\0${b.class}\0${b.target}`)),
    package_roots: [...packageRoots].sort(),
  };
}

function collectEntrypointsAndScripts() {
  const reasons = new Map();
  const mark = (file, reason) => {
    if (!TRACKED.has(file)) die(`declared entrypoint is not tracked: ${file} (${reason})`);
    const list = reasons.get(file) ?? [];
    list.push(reason);
    reasons.set(file, list);
  };
  for (const file of [...TRACKED].sort()) {
    if (/^tools\/.*\.mjs$/.test(file) && blob(file).startsWith('#!')) mark(file, 'tracked executable tool');
  }
  const visitExport = (value, label) => {
    if (typeof value === 'string' && value.startsWith('.')) mark(value.replace(/^\.\//, ''), label);
    else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) visitExport(child, `${label}:${key}`);
  };
  visitExport(PACKAGE.exports, 'package exports');
  if (typeof PACKAGE.bin === 'string') mark(PACKAGE.bin.replace(/^\.\//, ''), 'package bin');
  else for (const [name, file] of Object.entries(PACKAGE.bin ?? {})) mark(String(file).replace(/^\.\//, ''), `package bin:${name}`);

  const scriptClis = [];
  const scriptPackageRoots = new Set();
  for (const [name, command] of Object.entries(PACKAGE.scripts ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (typeof command !== 'string' || /[|;&`$()]/.test(command)) die(`computed/shell-composed package script is outside closed grammar: ${name}`);
    const tokens = command.trim().split(/\s+/);
    if (tokens[0] === 'node') {
      scriptClis.push({ script: name, class: 'native_or_system_helper', target: NODE });
      for (let i = 1; i < tokens.length; i++) {
        if (tokens[i] === '--import') {
          const loader = tokens[++i];
          if (!loader) die(`script ${name} has --import without package`);
          const locked = lockedPackage(loader);
          scriptPackageRoots.add(locked.lock_path);
          scriptClis.push({ script: name, class: 'npm_package', target: locked.name, lock_path: locked.lock_path, version: locked.version, integrity: locked.integrity });
        } else if (/^(?:tools|src)\/.+\.(?:mjs|js|ts)$/.test(tokens[i])) mark(tokens[i], `package script:${name}`);
      }
    } else {
      const packageName = packageForCli(tokens[0]);
      const locked = lockedPackage(packageName);
      const lockedRow = LOCK_PACKAGES.get(packageName);
      const bins = typeof lockedRow.bin === 'string' ? { [tokens[0]]: lockedRow.bin } : lockedRow.bin ?? {};
      const binPath = bins[tokens[0]];
      if (typeof binPath !== 'string') die(`script ${name} CLI ${tokens[0]} has no exact lock bin path`);
      scriptPackageRoots.add(locked.lock_path);
      scriptClis.push({
        script: name,
        class: 'npm_javascript_cli',
        target: packageName,
        lock_path: locked.lock_path,
        package_subpath: binPath.replace(/^\.\//, ''),
        version: locked.version,
        integrity: locked.integrity,
      });
      for (const token of tokens.slice(1)) {
        if (/^(?:tools|src)\/.+\.(?:mjs|js|ts)$/.test(token)) mark(token, `package script:${name}`);
      }
    }
  }
  const entrypoints = [...reasons].sort(([a], [b]) => a.localeCompare(b)).map(([file, why]) => ({ file, reasons: [...new Set(why)].sort() }));
  return { entrypoints, scriptClis, scriptPackageRoots: [...scriptPackageRoots].sort() };
}

try {
  const discovered = collectEntrypointsAndScripts();
  const analyzed = discovered.entrypoints.map(({ file }) => analyzeEntrypoint(file));
  const packageRoots = [
    ...discovered.scriptPackageRoots,
    ...analyzed.flatMap((entrypoint) => entrypoint.package_roots),
  ];
  const computed = {
    schema: 'runtime-inventory.v1',
    platform: PLATFORM,
    entrypoint_sources: discovered.entrypoints,
    script_clis: discovered.scriptClis,
    npm_closure: npmClosure(packageRoots),
    entrypoints: analyzed,
  };
  if (EMIT) {
    writeFileSync(MANIFEST, canonical(computed));
    process.stdout.write(`emitted ${MANIFEST}: ${computed.entrypoints.length} entrypoints\n`);
  } else {
    const declared = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    if (canonical(declared) !== canonical(computed)) die('manifest differs from recursively computed final-HEAD runtime closure');
    process.stdout.write(
      `runtime-inventory OK: ${computed.entrypoints.length} entrypoints, ` +
        `${computed.entrypoints.reduce((sum, row) => sum + row.modules.length, 0)} module-visits, ` +
        `${computed.entrypoints.reduce((sum, row) => sum + row.edges.length, 0)} edges, ` +
        `${computed.script_clis.length} script CLIs\n`,
    );
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
