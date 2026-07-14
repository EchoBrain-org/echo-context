// Item 046 / AC1 + AC4 — canonical_anchors parser for role-typed task-state
// pointer files. Parses the bulleted `- key: value` block under the
// `## canonical_anchors` heading into a typed { spec, reviews? } shape.
//
// TypeScript-only parser in V1 (deliberate, per spec): the Python lint
// (tools/task-state/lint.py) only checks block presence and order, not
// anchor structure, so there is no Python parser to drift from. If a future
// Python consumer needs anchor parsing, it MUST be a port that passes the
// shared fixture file at `tests/task-state/anchors-fixtures.json`.

export interface ParsedAnchors {
  spec: string;
  reviews?: string;
}

export interface AnchorParseFailure {
  spec?: string;
  _parse_error: string;
}

/** Allowed V1 keys. New keys MUST be added here AND a fixture written
 *  before the parser accepts them — preventing silent drift between
 *  what the parser understands and what consumers expect. */
const ALLOWED_KEYS = new Set<string>(['spec', 'reviews']);
const REQUIRED_KEYS = ['spec'] as const;

const _HEADING_RE = /^##\s+canonical_anchors\s*$/;
const _BULLET_RE = /^-\s+([a-z_]+)\s*:\s*(.+?)\s*$/;
const _NEXT_HEADING_RE = /^##\s+\S/;

/**
 * Parse the `## canonical_anchors` block from a pointer file body.
 *
 * Input is the full body (the content after the optional YAML frontmatter
 * close, or the full file if no frontmatter). The parser scans for the
 * `## canonical_anchors` heading and reads bullet lines until the next
 * `## ` heading (or end of body).
 *
 * Success: returns `{ spec, reviews? }`. Required key `spec` is present,
 * all keys are in ALLOWED_KEYS, no duplicate keys.
 *
 * Failure: returns `{ _parse_error: <reason>, spec?: <best-effort> }`.
 * Consumers that allow degraded output (e.g. `list_task_states`) surface
 * the best-effort `spec` plus `_parse_error`; strict consumers should
 * treat any `_parse_error` as fatal.
 */
export function parseAnchors(body: string): ParsedAnchors | AnchorParseFailure {
  const lines = body.split(/\r?\n/);
  let inBlock = false;
  const collected = new Map<string, string>();
  const duplicates: string[] = [];

  for (const raw of lines) {
    if (!inBlock) {
      if (_HEADING_RE.test(raw)) {
        inBlock = true;
      }
      continue;
    }
    // Inside the block. End at the next `## ` heading.
    if (_NEXT_HEADING_RE.test(raw)) break;
    // Allow blank lines.
    if (raw.trim() === '') continue;
    // Allow indented continuation lines? V1 says one anchor per line.
    // Reject any non-bullet, non-blank line as malformed.
    const m = _BULLET_RE.exec(raw);
    if (m === null) {
      return {
        _parse_error: `canonical_anchors: unrecognised line ${JSON.stringify(raw)}`,
      };
    }
    const key = m[1];
    const value = m[2];
    if (!ALLOWED_KEYS.has(key)) {
      return {
        _parse_error: `canonical_anchors: unknown key '${key}' (allowed: ${[...ALLOWED_KEYS].join(', ')})`,
      };
    }
    if (collected.has(key)) {
      duplicates.push(key);
    }
    collected.set(key, value);
  }

  if (!inBlock) {
    return { _parse_error: 'canonical_anchors: heading not found' };
  }

  if (duplicates.length > 0) {
    const best = collected.has('spec') ? { spec: collected.get('spec')! } : {};
    return {
      ...best,
      _parse_error: `canonical_anchors: duplicate key(s): ${duplicates.join(', ')}`,
    };
  }

  for (const required of REQUIRED_KEYS) {
    if (!collected.has(required)) {
      const best = collected.has('spec')
        ? { spec: collected.get('spec')! }
        : {};
      return {
        ...best,
        _parse_error: `canonical_anchors: missing required key '${required}'`,
      };
    }
  }

  const result: ParsedAnchors = { spec: collected.get('spec')! };
  if (collected.has('reviews')) {
    result.reviews = collected.get('reviews')!;
  }
  return result;
}

export function isParseFailure(
  r: ParsedAnchors | AnchorParseFailure,
): r is AnchorParseFailure {
  return '_parse_error' in r;
}
