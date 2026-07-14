/**
 * Shared subject normalizer — the single cross-source join key normalizer for
 * Granola signal atoms (`metadata.canonical_subject`) and team-decision atoms
 * (`metadata.canonical_subject` plus the backcompat `metadata.normalized_subject`).
 *
 * Behavior: fold separator classes (`_`, `-`, and runs of them) to a single
 * space, then lowercase, trim, and collapse internal whitespace runs to a single
 * space.
 *
 * Item 118 (AC1) added the separator fold so `openai_investment_terms`,
 * `openai-investment-terms`, and `openai investment terms` produce the identical
 * key — the empirical drift study found the extractor flips snake_case vs
 * space-separated per meeting, and the exact-equality drift join silently
 * dropped every separator-only-differing pair. Consequence, intended: subjects
 * that differ ONLY by separator now collapse to the same normalized key (and the
 * `team-decision:<normalized>` dedupe_key derived from it). Subjects that
 * contained NO separators are byte-unchanged from the prior behavior, so their
 * dedupe_key stays stable across this change.
 */
export function normalizeSubject(value: string): string {
  return value.replace(/[_-]+/g, ' ').toLowerCase().trim().replace(/\s+/g, ' ');
}
