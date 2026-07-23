/** Canonicalize query-bound timestamps before lexicographic storage compares.
 *  R2 root cause: non-UTC offset forms compare incorrectly against stored
 *  canonical UTC `...Z` timestamps unless both sides are in `toISOString()`
 *  form. Naive strings intentionally keep JS local-time parse semantics. */
export function canonicalizeTimestamp(s: string): string {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid timestamp: ${s}`);
  return d.toISOString();
}

/** Compare two timestamp strings by the instant they represent, not by their
 * textual offset spelling. Invalid values sort after valid values and then
 * lexically so callers that operate on partially trusted data stay
 * deterministic without pretending an invalid clock is meaningful. */
export function compareTimestampInstants(left: string, right: string): number {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  const leftValid = !Number.isNaN(leftMs);
  const rightValid = !Number.isNaN(rightMs);
  if (leftValid && rightValid) {
    if (leftMs < rightMs) return -1;
    if (leftMs > rightMs) return 1;
  } else if (leftValid !== rightValid) {
    return leftValid ? -1 : 1;
  }
  return left.localeCompare(right);
}
