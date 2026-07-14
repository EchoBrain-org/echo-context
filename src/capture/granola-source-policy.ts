import type { CaptureSourcePolicy } from './pipeline-core.js';

export const GRANOLA_API_SOURCE = 'api:granola';
export const GRANOLA_DERIVED_SOURCE = 'derived:granola-signals';
export const GRANOLA_DERIVED_INDEX_SOURCE = 'derived:granola-signals-index';

const ALLOWED = new Set([
  GRANOLA_API_SOURCE,
  GRANOLA_DERIVED_SOURCE,
  GRANOLA_DERIVED_INDEX_SOURCE,
]);

export function isAllowedGranolaSource(source: string): boolean {
  return ALLOWED.has(source);
}

export function isAllowedGranolaDerivedSource(source: string): boolean {
  return source === GRANOLA_DERIVED_SOURCE || source === GRANOLA_DERIVED_INDEX_SOURCE;
}

export const GRANOLA_SOURCE_POLICY: CaptureSourcePolicy<'unknown_api'> = Object.freeze({
  validateSource(source: string) {
    return source === GRANOLA_API_SOURCE
      ? ({ accepted: true, reason: 'allowlisted' } as const)
      : ({ accepted: false, reason: 'unknown_api' } as const);
  },
});
