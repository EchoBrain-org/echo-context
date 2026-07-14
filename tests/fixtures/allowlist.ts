import { CAPTURED_SOURCES } from '../../src/capture/sources.js';

export function resetAllowlist(): void {
  const apps = CAPTURED_SOURCES.apps as Record<string, unknown>;
  const domains = CAPTURED_SOURCES.domains as Record<string, unknown>;
  const fsPaths = CAPTURED_SOURCES.fs_paths as unknown as string[];
  const apis = CAPTURED_SOURCES.apis as unknown as string[];
  for (const k of Object.keys(apps)) delete apps[k];
  for (const k of Object.keys(domains)) delete domains[k];
  fsPaths.length = 0;
  apis.length = 0;
}

export function snapshotFsPaths(): string[] {
  return [...(CAPTURED_SOURCES.fs_paths as unknown as string[])];
}

export function restoreFsPaths(snapshot: ReadonlyArray<string>): void {
  const fsPaths = CAPTURED_SOURCES.fs_paths as unknown as string[];
  for (const p of snapshot) fsPaths.push(p);
}
