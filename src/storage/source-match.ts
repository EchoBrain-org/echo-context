// Shared source / source_prefix matching semantics for both storage
// adapters. Extracted verbatim from MemoryStorage (whose behavior is the
// contract) so SqliteStorage can apply the SAME predicate over bounded
// descriptor pages instead of raw `source = ?` / ASCII-case-insensitive
// `LIKE` —
// those diverged on backslash-stored Windows sources, component
// boundaries (`fs:/a/b` vs `fs:/a/bc`), prefix case (`GIT:` vs `git:`),
// and trailing-slash equality.

function stripTrailingSlash(value: string): string {
  let out = value;
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

function pathStartIndex(value: string): number | null {
  if (/^[A-Za-z]:[\\/]/.test(value)) return 0;
  if (value.startsWith('/') || value.startsWith('~/') || value.startsWith('\\')) return 0;
  const match = /^([A-Za-z_][A-Za-z0-9_+.-]*:)(.*)$/.exec(value);
  if (match === null) return value.includes('\\') ? 0 : null;
  const rest = match[2]!;
  if (
    rest.startsWith('/') ||
    rest.startsWith('\\') ||
    rest.startsWith('~/') ||
    /^[A-Za-z]:[\\/]/.test(rest)
  ) {
    return match[1]!.length;
  }
  return null;
}

export function normalizePathLikeSource(value: string): string | null {
  const start = pathStartIndex(value);
  if (start === null) return null;
  const sourcePrefix = value.slice(0, start);
  const pathPart = stripTrailingSlash(value.slice(start).replace(/\\/g, '/'));
  const windowsLike = process.platform === 'win32' || /^[A-Za-z]:(?:\/|$)/.test(pathPart);
  const normalized = `${sourcePrefix}${pathPart}`;
  return windowsLike ? normalized.toLowerCase() : normalized;
}

export function sourceEquals(left: string, right: string): boolean {
  const normalizedLeft = normalizePathLikeSource(left);
  const normalizedRight = normalizePathLikeSource(right);
  if (normalizedLeft !== null && normalizedRight !== null)
    return normalizedLeft === normalizedRight;
  return left === right;
}

export function sourceHasPrefix(source: string, prefix: string): boolean {
  const normalizedSource = normalizePathLikeSource(source);
  const normalizedPrefix = normalizePathLikeSource(prefix);
  if (normalizedSource !== null && normalizedPrefix !== null) {
    if (normalizedSource === normalizedPrefix) return true;
    return normalizedSource.startsWith(
      normalizedPrefix.endsWith('/') ? normalizedPrefix : `${normalizedPrefix}/`,
    );
  }
  return source.startsWith(prefix);
}

export const SOURCE_FAMILY_VALUES = ['cursor', 'claude_code', 'codex', 'git', 'granola'] as const;

export type SourceFamily = (typeof SOURCE_FAMILY_VALUES)[number];

/** Stable bits persisted by migration 0006's generated source-family mask.
 * A mask, rather than one enum-valued column, is deliberate: a synthetic or
 * moved path can contain more than one app marker and must remain a candidate
 * for every matching family. */
export const SOURCE_FAMILY_BITS: Readonly<Record<SourceFamily, number>> = {
  cursor: 1,
  claude_code: 2,
  codex: 4,
  git: 8,
  granola: 16,
};

const SOURCE_FAMILY_SET = new Set<string>(SOURCE_FAMILY_VALUES);

export function isSourceFamily(value: unknown): value is SourceFamily {
  return typeof value === 'string' && SOURCE_FAMILY_SET.has(value);
}

/** Conservative, platform-invariant source-family membership. Filesystem
 * markers are separator-normalized and ASCII case-folded on every platform,
 * so the result is a superset of platform-specific `sourceHasPrefix` matches.
 * The authoritative prefix predicate still decides which candidates return.
 * Raw git and Granola families remain BINARY/case-sensitive, matching their
 * non-path source-prefix semantics. */
export function sourceFamilyMask(source: string): number {
  let mask = 0;
  const normalized = source.replace(/\\/g, '/').toLowerCase();
  if (normalized.startsWith('fs:')) {
    const withTerminator = `${normalized}/`;
    if (withTerminator.includes('/library/application support/cursor/')) {
      mask |= SOURCE_FAMILY_BITS.cursor;
    }
    if (withTerminator.includes('/.claude/projects/')) {
      mask |= SOURCE_FAMILY_BITS.claude_code;
    }
    if (withTerminator.includes('/.codex/sessions/')) {
      mask |= SOURCE_FAMILY_BITS.codex;
    }
  }
  if (source.startsWith('git:')) mask |= SOURCE_FAMILY_BITS.git;
  if (source.startsWith('api:granola')) mask |= SOURCE_FAMILY_BITS.granola;
  return mask;
}

export function sourceBelongsToFamily(source: string, family: SourceFamily): boolean {
  return (sourceFamilyMask(source) & SOURCE_FAMILY_BITS[family]) !== 0;
}
