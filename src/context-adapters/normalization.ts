import { createNormalizer } from '../normalize/index.js';
import { getNormalizationAdapterRegistry } from './registry.js';

const normalizer = createNormalizer(getNormalizationAdapterRegistry());

export const getRegistry = normalizer.getRegistry;
export const findAdapter = normalizer.findAdapter;
export const normalizeEvent = normalizer.normalizeEvent;
export const normalizeEvents = normalizer.normalizeEvents;
