/** Canonicalize query-bound timestamps before lexicographic storage compares.
 *  R2 root cause: non-UTC offset forms compare incorrectly against stored
 *  canonical UTC `...Z` timestamps unless both sides are in `toISOString()`
 *  form. Naive strings intentionally keep JS local-time parse semantics. */
export function canonicalizeTimestamp(s: string): string {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid timestamp: ${s}`);
  return d.toISOString();
}
