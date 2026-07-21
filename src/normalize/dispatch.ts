import type { CaptureEvent } from '../storage/interface.js';
import type { AdapterRegistration } from './types.js';
import type { NormalizedContextEvent } from './types.js';

export interface Normalizer {
  getRegistry(): readonly AdapterRegistration[];
  findAdapter(source: string): AdapterRegistration | null;
  normalizeEvent(event: CaptureEvent): NormalizedContextEvent | null;
  normalizeEvents(events: readonly CaptureEvent[]): NormalizedContextEvent[];
}

/** Build a provider-neutral normalizer from registrations supplied by the
 * outer composition layer. Core normalization never imports bundled adapters. */
export function createNormalizer(
  registry: readonly AdapterRegistration[],
): Normalizer {
  const registrations = Object.freeze([...registry]);

  function findAdapter(source: string): AdapterRegistration | null {
    for (const registration of registrations) {
      if (registration.matches(source)) return registration;
    }
    return null;
  }

  function normalizeEvent(event: CaptureEvent): NormalizedContextEvent | null {
    const registration = findAdapter(event.source);
    if (registration === null) return null;
    return registration.adapter(event);
  }

  function normalizeEvents(
    events: readonly CaptureEvent[],
  ): NormalizedContextEvent[] {
    const normalized: NormalizedContextEvent[] = [];
    for (const event of events) {
      const result = normalizeEvent(event);
      if (result !== null) normalized.push(result);
    }
    return normalized;
  }

  return Object.freeze({
    getRegistry: () => registrations,
    findAdapter,
    normalizeEvent,
    normalizeEvents,
  });
}
