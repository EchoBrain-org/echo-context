import { mkdirSync, readdirSync, readFileSync, lstatSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { atomicWrite, AtomicWriteError } from './atomic-write.js';
import type { InstallProfile } from '../paths.js';

export type PopulateEchoSkillsResult =
  | { ok: true; copied: string[]; skipped: string[]; targetDir: string }
  | { ok: false; sourceDir: string; targetDir: string; error: string };

export interface SyncClaudeSkillsResult {
  copied: string[];
  skipped: string[];
  targetDir: string;
}

export interface SyncCodexSkillsResult {
  copied: string[];
  skipped: string[];
  targetDir: string;
}

export interface SkillSyncOpts {
  sourceDir: string;
  targetDir: string;
  profile?: InstallProfile;
}

export class SkillSyncError extends Error {
  constructor(
    public readonly code: 'ENOENT' | 'EISDIR' | 'UNKNOWN',
    public readonly file: string,
    public readonly operation: 'read' | 'stat',
    message: string,
  ) {
    super(message);
    this.name = 'SkillSyncError';
  }
}

const CODEX_REQUIRED_SKILLS = ['using-echo-mcp.md'] as const;

function audienceFor(content: string): InstallProfile {
  if (!content.startsWith('---\n')) return 'customer';
  const end = content.indexOf('\n---', 4);
  if (end === -1) return 'customer';
  const frontmatter = content.slice(4, end).split(/\r?\n/);
  for (const line of frontmatter) {
    const match = /^audience:\s*["']?(customer|dogfood)["']?\s*$/.exec(line.trim());
    if (match !== null) return match[1] as InstallProfile;
  }
  return 'customer';
}

function includedForProfile(content: string, profile: InstallProfile): boolean {
  return profile === 'dogfood' || audienceFor(content) === 'customer';
}

function listMdFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((n) => n.endsWith('.md'))
    .sort();
}

function skillSyncErrorCode(err: unknown): 'ENOENT' | 'EISDIR' | 'UNKNOWN' {
  if (err instanceof Error && 'code' in err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR') return code;
  }
  return 'UNKNOWN';
}

function assertRequiredCodexSkill(
  sourceDir: string,
  fileName: string,
  profile: InstallProfile,
): void {
  const srcPath = join(sourceDir, fileName);
  try {
    const lst = lstatSync(srcPath);
    if (!lst.isFile()) {
      throw new SkillSyncError(
        'EISDIR',
        srcPath,
        'stat',
        `missing required Codex skill source: ${srcPath} is not a regular file`,
      );
    }
  } catch (err) {
    if (err instanceof SkillSyncError) throw err;
    throw new SkillSyncError(
      skillSyncErrorCode(err),
      srcPath,
      'stat',
      `missing required Codex skill source: ${srcPath}`,
    );
  }

  let content: string;
  try {
    content = readFileSync(srcPath, 'utf8');
  } catch (err) {
    throw new SkillSyncError(
      skillSyncErrorCode(err),
      srcPath,
      'read',
      `cannot read required Codex skill source: ${srcPath}: ${(err as Error).message}`,
    );
  }
  if (!includedForProfile(content, profile)) {
    throw new SkillSyncError(
      'UNKNOWN',
      srcPath,
      'read',
      `required Codex skill source is excluded by profile ${profile}: ${srcPath}`,
    );
  }
}

function upsertCodexNameFrontmatter(skillName: string, content: string): string {
  if (content.startsWith('---\n')) {
    const end = content.indexOf('\n---', 4);
    if (end !== -1) {
      const bodyStart = end + '\n---'.length;
      const frontmatter = content.slice(4, end).split(/\r?\n/);
      let sawName = false;
      const next = frontmatter.map((line) => {
        if (/^name\s*:/.test(line.trim())) {
          sawName = true;
          return `name: ${skillName}`;
        }
        return line;
      });
      if (!sawName) next.unshift(`name: ${skillName}`);
      return `---\n${next.join('\n')}\n---${content.slice(bodyStart)}`;
    }
  }
  return `---\nname: ${skillName}\n---\n${content}`;
}

/**
 * First-hop: copies regular .md files from packaged assets/echo-skills/ into ~/.echo/skills/.
 * Symlinks within sourceDir are NEVER followed.
 *
 * Returns a discriminated result; never throws on missing/unreadable sourceDir.
 */
export function populateEchoSkills(opts: SkillSyncOpts): PopulateEchoSkillsResult {
  const { sourceDir, targetDir } = opts;
  const profile = opts.profile ?? 'dogfood';
  const copied: string[] = [];
  const skipped: string[] = [];

  let entries: string[];
  try {
    entries = listMdFiles(sourceDir);
  } catch (err) {
    return {
      ok: false,
      sourceDir,
      targetDir,
      error: `cannot read sourceDir: ${(err as Error).message}`,
    };
  }

  try {
    mkdirSync(targetDir, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      sourceDir,
      targetDir,
      error: `cannot create targetDir: ${(err as Error).message}`,
    };
  }

  for (const name of entries) {
    const srcPath = join(sourceDir, name);
    try {
      const lst = lstatSync(srcPath);
      if (!lst.isFile()) {
        skipped.push(name);
        continue;
      }
    } catch {
      skipped.push(name);
      continue;
    }
    let content: string;
    try {
      content = readFileSync(srcPath, 'utf8');
    } catch {
      skipped.push(name);
      continue;
    }
    if (!includedForProfile(content, profile)) {
      skipped.push(name);
      continue;
    }
    const tgtPath = join(targetDir, name);
    try {
      atomicWrite({ filePath: tgtPath, content });
      copied.push(name);
    } catch (err) {
      if (err instanceof AtomicWriteError && err.code === 'EEXIST') {
        // target is a symlink — skip per AC4 / AC7.2a
        skipped.push(name);
      } else {
        return {
          ok: false,
          sourceDir,
          targetDir,
          error: `failed to write ${name}: ${(err as Error).message}`,
        };
      }
    }
  }

  return { ok: true, copied, skipped, targetDir };
}

/**
 * Second-hop: copies regular .md files from ~/.echo/skills/ into the per-vendor
 * commands directory (e.g. ~/.claude/commands/).
 *
 * On hard failure (sourceDir unreadable, etc.), throws — syncAll's try/catch
 * surfaces it via the agent's errors[]. Symlink-target skips push into the
 * skipped[] array.
 */
export function syncClaudeSkills(opts: SkillSyncOpts): SyncClaudeSkillsResult {
  const { sourceDir, targetDir } = opts;
  const copied: string[] = [];
  const skipped: string[] = [];

  mkdirSync(targetDir, { recursive: true });
  const entries = listMdFiles(sourceDir);

  for (const name of entries) {
    const srcPath = join(sourceDir, name);
    try {
      const lst = lstatSync(srcPath);
      if (!lst.isFile()) {
        skipped.push(name);
        continue;
      }
    } catch {
      skipped.push(name);
      continue;
    }
    const content = readFileSync(srcPath, 'utf8');
    const tgtPath = join(targetDir, name);
    try {
      atomicWrite({ filePath: tgtPath, content });
      copied.push(name);
    } catch (err) {
      if (err instanceof AtomicWriteError && err.code === 'EEXIST') {
        skipped.push(name);
      } else {
        throw err;
      }
    }
  }

  return { copied, skipped, targetDir };
}

/**
 * Codex second-hop: materializes packaged ECHO skills into Codex's native
 * directory layout: <codexHome>/skills/<name>/SKILL.md.
 *
 * Required customer skills are validated before any target directory or marker
 * write can happen, so a broken tarball fails hard without partial targets.
 */
export function syncCodexSkills(opts: SkillSyncOpts): SyncCodexSkillsResult {
  const { sourceDir, targetDir } = opts;
  const profile = opts.profile ?? 'dogfood';
  const copied: string[] = [];
  const skipped: string[] = [];

  for (const fileName of CODEX_REQUIRED_SKILLS) {
    assertRequiredCodexSkill(sourceDir, fileName, profile);
  }

  const entries = listMdFiles(sourceDir);
  const sources: Array<{ fileName: string; content: string }> = [];
  for (const fileName of entries) {
    const srcPath = join(sourceDir, fileName);
    try {
      const lst = lstatSync(srcPath);
      if (!lst.isFile()) {
        skipped.push(fileName);
        continue;
      }
    } catch {
      skipped.push(fileName);
      continue;
    }
    let content: string;
    try {
      content = readFileSync(srcPath, 'utf8');
    } catch {
      skipped.push(fileName);
      continue;
    }
    if (!includedForProfile(content, profile)) {
      skipped.push(fileName);
      continue;
    }
    sources.push({ fileName, content });
  }

  mkdirSync(targetDir, { recursive: true });
  for (const source of sources) {
    const skillName = basename(source.fileName, '.md');
    const targetPath = join(targetDir, skillName, 'SKILL.md');
    mkdirSync(dirname(targetPath), { recursive: true });
    try {
      atomicWrite({
        filePath: targetPath,
        content: upsertCodexNameFrontmatter(skillName, source.content),
      });
      copied.push(`${skillName}/SKILL.md`);
    } catch (err) {
      if (err instanceof AtomicWriteError && err.code === 'EEXIST') {
        skipped.push(`${skillName}/SKILL.md`);
      } else {
        throw err;
      }
    }
  }

  return { copied, skipped, targetDir };
}
