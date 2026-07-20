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

/** Coarse SQL prefilter for SqliteStorage's authoritative scalar predicate:
 *  the portion of a source /
 *  source_prefix filter value before its first path separator (`/` or
 *  `\`), e.g. `fs:` from `fs:/a/b`, `C:` from `C:/Users/me/`, the whole
 *  string from separator-free values like `coord:`. Matching it with an
 *  ASCII-case-insensitive `LIKE chunk%` is provably a SUPERSET of the JS
 *  predicates above: normalization never alters the pre-separator chunk
 *  except by case-folding (backslash→slash and trailing-slash stripping
 *  only touch the path part at/after the first separator), and SQLite
 *  LIKE's case-insensitivity covers both the Windows case-fold and the
 *  case-sensitive raw-startsWith fallback. Returns null (no usable
 *  prefilter — caller must full-scan) when the value starts with a
 *  separator, or when the chunk contains non-ASCII characters (LIKE's
 *  case-insensitivity is ASCII-only, so it could NOT cover a win32
 *  case-fold of a non-ASCII letter and the superset guarantee would
 *  break). The JS predicate remains authoritative; this only narrows
 *  the candidate rows. */
export function likePrefilterChunk(value: string): string | null {
  const sep = value.search(/[\\/]/);
  if (sep === 0) return null;
  const chunk = sep === -1 ? value : value.slice(0, sep);
  for (let i = 0; i < chunk.length; i++) {
    if (chunk.charCodeAt(i) > 0x7f) return null;
  }
  return chunk;
}
