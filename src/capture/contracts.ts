/** Bounded freshness evidence reported by a live capture adapter. */
export interface FreshnessProbe {
  maxGapBytes: number;
  maxGapPath: string | null;
  filesChecked: number;
}

export type ExtractorHealthState =
  | 'starting'
  | 'catching_up'
  | 'healthy'
  | 'unhealthy'
  | 'stopped';

/** Provider-neutral health projected by the generic capture runner. */
export interface ExtractorHealth {
  state: ExtractorHealthState;
  queueDepth: number;
  overflowCount: number;
  reconciliationPending: boolean;
  errorCount: number;
  lastError: string | null;
  sourceStatus?: 'active' | 'absent';
}

/** Provider-neutral lifecycle handle returned by every live capture adapter. */
export interface ExtractorHandle {
  /** Resolves once watcher readiness, bounded boot scan, and any overflow
   * reconciliation caused during that scan have completed. */
  initialCatchUp: Promise<void>;
  getHealth: () => ExtractorHealth;
  stop: () => Promise<void>;
  probeFreshness: () => Promise<FreshnessProbe>;
}
