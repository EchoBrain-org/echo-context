export const HEALTH_STATUSES = ['starting', 'catching_up', 'healthy', 'stopping', 'unhealthy'] as const;

export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export type HealthComponentDetail = string | number | boolean | null;

export interface HealthComponentSnapshot {
  status: HealthStatus;
  updated_at: string;
  message?: string;
  details?: Record<string, HealthComponentDetail>;
}

export interface HealthSnapshot {
  schema_version: 1;
  status: HealthStatus;
  started_at: string;
  updated_at: string;
  components: Record<string, HealthComponentSnapshot>;
}

export type HealthSnapshotProvider = () => HealthSnapshot | Promise<HealthSnapshot>;

export interface HealthTrackerOptions {
  initialStatus?: HealthStatus;
  now?: () => Date;
}

export interface HealthComponentUpdate {
  message?: string;
  details?: Record<string, HealthComponentDetail>;
}

/**
 * In-memory lifecycle state for the daemon and its independently observed
 * components. Callers own the transitions; snapshots are detached copies so
 * an HTTP consumer cannot mutate the tracked state.
 */
export class HealthTracker {
  private readonly now: () => Date;
  private readonly startedAt: string;
  private status: HealthStatus;
  private updatedAt: string;
  private readonly components = new Map<string, HealthComponentSnapshot>();

  constructor(options: HealthTrackerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    const initializedAt = this.now().toISOString();
    this.startedAt = initializedAt;
    this.updatedAt = initializedAt;
    this.status = options.initialStatus ?? 'starting';
  }

  transition(status: HealthStatus): HealthSnapshot {
    this.status = status;
    this.updatedAt = this.now().toISOString();
    return this.snapshot();
  }

  setComponent(
    name: string,
    status: HealthStatus,
    update: HealthComponentUpdate | string = {},
  ): HealthSnapshot {
    const normalizedName = name.trim();
    if (normalizedName.length === 0) {
      throw new Error('health component name must not be empty');
    }

    const updatedAt = this.now().toISOString();
    const normalizedUpdate = typeof update === 'string' ? { message: update } : update;
    this.components.set(normalizedName, {
      status,
      updated_at: updatedAt,
      ...(normalizedUpdate.message !== undefined ? { message: normalizedUpdate.message } : {}),
      ...(normalizedUpdate.details !== undefined
        ? { details: { ...normalizedUpdate.details } }
        : {}),
    });
    this.updatedAt = updatedAt;
    return this.snapshot();
  }

  snapshot(): HealthSnapshot {
    return {
      schema_version: 1,
      status: this.status,
      started_at: this.startedAt,
      updated_at: this.updatedAt,
      components: Object.fromEntries(
        [...this.components.entries()].map(([name, component]) => {
          const copy = {
            ...component,
            ...(component.details !== undefined ? { details: { ...component.details } } : {}),
          };
          return [name, copy];
        }),
      ),
    };
  }
}
