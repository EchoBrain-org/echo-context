const MAX_LOGICAL_TURN_ID_LENGTH = 512;
const LOGICAL_TURN_ID_RE = /^[^\s\u0000-\u001f\u007f]+$/u;

/** Logical turn IDs are provider-opaque, but grouping accepts only bounded,
 * non-whitespace tokens so malformed metadata cannot become a shared key. */
export function isValidLogicalTurnId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_LOGICAL_TURN_ID_LENGTH &&
    LOGICAL_TURN_ID_RE.test(value)
  );
}
