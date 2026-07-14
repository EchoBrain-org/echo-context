#!/usr/bin/env node
// verify-context-tools.mjs — AC3 context-roster projector (item 135).
//
// Takes a full MCP tool roster (the source may expose a mixed 15-tool roster),
// requires the eight context IDs each exactly once, byte-projects only those
// eight, and classifies every ignored (non-context) ID. Fails on a missing or
// duplicated context ID. Pure JSON in/out — no source import, no network.
//
// Usage:
//   node tools/verify-context-tools.mjs --roster <roster.json> [--pin context-tools.v1.json]
// roster.json is either a JSON array of tool-descriptor objects each with a
// `name`, or a JSON array of name strings.

import { readFileSync } from 'node:fs';

const CONTEXT_TOOLS = [
  'echo_ping',
  'echo_resolve_mru',
  'find_clusters',
  'get_atom',
  'get_atoms',
  'get_recent_work_context',
  'search_memories',
  'wait_for_new_turns',
];

function fail(msg) {
  process.stderr.write(`verify-context-tools: ${msg}\n`);
  process.exit(1);
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function canon(v) {
  const s = (x) =>
    Array.isArray(x)
      ? x.map(s)
      : x && typeof x === 'object'
        ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, s(x[k])]))
        : x;
  return JSON.stringify(s(v), null, 2) + '\n';
}

const rosterPath = arg('--roster');
if (!rosterPath) fail('--roster <file> is required');
let roster;
try {
  roster = JSON.parse(readFileSync(rosterPath, 'utf8'));
} catch (e) {
  fail(`cannot read/parse --roster: ${e.message}`);
}
if (!Array.isArray(roster)) fail('--roster must be a JSON array');

// Normalize to descriptors keyed by name.
const descriptors = roster.map((r) => (typeof r === 'string' ? { name: r } : r));
for (const d of descriptors) if (!d || typeof d.name !== 'string') fail('each roster entry needs a string `name`');

const names = descriptors.map((d) => d.name);
const counts = new Map();
for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);

// Require each of the 8 context IDs exactly once.
const missing = CONTEXT_TOOLS.filter((t) => (counts.get(t) ?? 0) === 0);
const duplicated = CONTEXT_TOOLS.filter((t) => (counts.get(t) ?? 0) > 1);
if (missing.length) fail(`missing context tool(s): ${missing.join(', ')}`);
if (duplicated.length) fail(`duplicated context tool(s): ${duplicated.join(', ')}`);

// Byte-project only the eight, in canonical id order.
const contextSet = new Set(CONTEXT_TOOLS);
const projected = CONTEXT_TOOLS.map((t) => descriptors.find((d) => d.name === t));

// Classify every ignored (non-context) id.
const ignored = names
  .filter((n) => !contextSet.has(n))
  .sort()
  .map((n) => ({ id: n, classification: 'ignored_non_context' }));

// Optional: assert the pinned roster file lists exactly these eight.
const pinPath = arg('--pin');
if (pinPath) {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'));
  const pinned = Array.isArray(pin.tools) ? [...pin.tools].sort() : [];
  if (JSON.stringify(pinned) !== JSON.stringify([...CONTEXT_TOOLS].sort())) {
    fail(`--pin roster does not equal the eight context tools`);
  }
}

process.stdout.write(
  canon({
    schema: 'context-tools-projection.v1',
    projected_tool_ids: CONTEXT_TOOLS,
    projected_descriptors: projected,
    ignored_ids: ignored,
    ignored_count: ignored.length,
  }),
);
