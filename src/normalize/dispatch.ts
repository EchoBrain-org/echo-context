import { getNormalizationAdapterRegistry } from '../context-adapters/registry.js';
import type { AdapterRegistration } from './types.js';

export function getRegistry(): readonly AdapterRegistration[] {
  return getNormalizationAdapterRegistry();
}

export function findAdapter(source: string): AdapterRegistration | null {
  for (const reg of getNormalizationAdapterRegistry()) {
    if (reg.matches(source)) return reg;
  }
  return null;
}
