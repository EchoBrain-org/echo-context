// Shared strict input-schema wrapper for the MCP retrieval tools.
//
// B2 (0.1.0-beta.5 audit): raw-shape inputSchemas made the SDK build a
// plain z.object(), which silently STRIPS unknown top-level keys before the
// handler. A caller that read the old find_clusters description literally
// and passed `membership_cursor:`/`next_cursor:` as input keys lost
// continuation with zero warnings and got a legacy-shaped listing back.
// Registering a full z.strictObject() instance closes the trap end to end:
// the SDK passes schema instances through unchanged (its
// normalizeObjectSchema returns v4 object schemas as-is), validates every
// call with them at runtime, and publishes `additionalProperties: false`
// so schema-validating clients reject before the wire.

import { z } from 'zod';

export interface StrictInputOptions {
  /** Trap-specific guidance keyed by offending input key. When an unknown
   *  key matches, its guidance replaces the generic unknown-key message. */
  keyGuidance?: Record<string, string>;
  /** Extra JSON-Schema keywords merged into the published schema through
   *  zod's metadata registry (e.g. a top-level `anyOf` requirement that
   *  zod cannot express directly). Parse-time behavior is unaffected. */
  jsonSchemaExtras?: Record<string, unknown>;
}

export function strictInputSchema<Shape extends z.ZodRawShape>(
  tool: string,
  shape: Shape,
  options: StrictInputOptions = {},
) {
  const schema = z.strictObject(shape, {
    error: (issue) => {
      if (issue.code !== 'unrecognized_keys') return undefined;
      for (const key of issue.keys) {
        const guidance = options.keyGuidance?.[key];
        if (guidance !== undefined) return guidance;
      }
      const keys = issue.keys.map((key) => `\`${key}\``).join(', ');
      return `${tool}: unknown input key(s) ${keys} — unknown keys are rejected, not ignored`;
    },
  });
  return options.jsonSchemaExtras !== undefined
    ? schema.meta(options.jsonSchemaExtras)
    : schema;
}
