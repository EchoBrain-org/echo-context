import { existsSync as nodeExistsSync } from 'node:fs';
import { win32 } from 'node:path';

export interface ResolveCommandDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  existsSync: (path: string) => boolean;
}

export interface ResolvedCommand {
  command: string;
  prependArgs?: string[];
}

const DEFAULT_WINDOWS_PATHEXT = ['.COM', '.EXE', '.BAT', '.CMD'] as const;

function windowsPathEntries(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATH ?? env.Path ?? env.path ?? '';
  return raw.split(';').filter((entry) => entry.length > 0);
}

function windowsPathExts(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATHEXT;
  const values =
    raw === undefined || raw.trim().length === 0
      ? [...DEFAULT_WINDOWS_PATHEXT]
      : raw.split(';').filter((entry) => entry.length > 0);
  return values.map((entry) => (entry.startsWith('.') ? entry : `.${entry}`));
}

function hasWindowsExecutableExtension(cmd: string, exts: readonly string[]): boolean {
  const lower = win32.extname(cmd).toLowerCase();
  return exts.some((ext) => ext.toLowerCase() === lower);
}

function resolveWindowsExecutable(cmd: string, deps: ResolveCommandDeps): string | null {
  const exts = windowsPathExts(deps.env);
  const candidates = hasWindowsExecutableExtension(cmd, exts)
    ? [cmd]
    : [cmd, ...exts.map((ext) => `${cmd}${ext}`)];
  const searchDirs =
    win32.isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\')
      ? ['']
      : windowsPathEntries(deps.env);

  for (const dir of searchDirs) {
    for (const candidate of candidates) {
      const resolved = dir.length === 0 ? candidate : win32.join(dir, candidate);
      if (deps.existsSync(resolved)) return resolved;
    }
  }
  return null;
}

function isWindowsCommandScript(command: string): boolean {
  const ext = win32.extname(command).toLowerCase();
  return ext === '.cmd' || ext === '.bat';
}

export function resolveCommand(cmd: string, deps: ResolveCommandDeps): ResolvedCommand {
  if (deps.platform !== 'win32') return { command: cmd };

  const resolved = resolveWindowsExecutable(cmd, deps) ?? cmd;
  if (!isWindowsCommandScript(resolved)) return { command: resolved };

  return {
    command: deps.env.ComSpec ?? deps.env.COMSPEC ?? 'cmd.exe',
    prependArgs: ['/d', '/s', '/c', resolved],
  };
}

export function resolveCommandForCurrentProcess(cmd: string): ResolvedCommand {
  return resolveCommand(cmd, {
    platform: process.platform,
    env: process.env,
    existsSync: nodeExistsSync,
  });
}
