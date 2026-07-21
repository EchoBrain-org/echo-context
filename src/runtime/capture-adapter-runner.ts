import type {
  ExtractorHandle,
  ExtractorHealth,
} from '../capture/contracts.js';
import type { CaptureAdapterRegistration } from '../context-adapters/contracts.js';
import type { Storage } from '../storage/interface.js';
import { HealthTracker, type HealthSnapshot } from './health.js';

export interface CaptureAdapterRunnerOptions {
  onStopError?: (componentId: string, error: unknown) => void;
}

export interface CaptureAdapterRunner {
  start(storage: Storage, health: HealthTracker): Promise<boolean>;
  observe(snapshot: HealthSnapshot): HealthSnapshot;
  stop(): Promise<void>;
}

function observedComponentStatus(
  health: ExtractorHealth,
  runtimeStatus: HealthSnapshot['status'],
): HealthSnapshot['status'] {
  if (health.state !== 'stopped') return health.state;
  return runtimeStatus === 'stopping' ? 'stopping' : 'unhealthy';
}

export function createCaptureAdapterRunner(
  registrations: readonly CaptureAdapterRegistration[],
  options: CaptureAdapterRunnerOptions = {},
): CaptureAdapterRunner {
  const handles = new Map<string, ExtractorHandle>();
  let started = false;
  let stopped = false;

  return {
    async start(storage, health) {
      if (started) throw new Error('capture adapter runner already started');
      if (stopped) throw new Error('capture adapter runner already stopped');
      started = true;
      let startupUnhealthy = false;
      for (const registration of registrations) {
        const componentId = registration.component_id;
        if (!registration.enabled) {
          health.setComponent(componentId, 'healthy', 'disabled');
          continue;
        }
        health.transition('catching_up');
        health.setComponent(componentId, 'starting');
        const handle = await registration.start(storage);
        handles.set(componentId, handle);
        health.setComponent(componentId, 'catching_up');
        await handle.initialCatchUp;
        const adapterHealth = handle.getHealth();
        const componentStatus = observedComponentStatus(
          adapterHealth,
          health.snapshot().status,
        );
        if (componentStatus === 'unhealthy') startupUnhealthy = true;
        health.setComponent(
          componentId,
          componentStatus,
          adapterHealth.lastError ??
            `queued=${adapterHealth.queueDepth}; overflow=${adapterHealth.overflowCount}`,
        );
      }
      return startupUnhealthy;
    },

    observe(snapshot) {
      let observedStatus = snapshot.status;
      for (const registration of registrations) {
        const adapter = handles.get(registration.component_id)?.getHealth();
        if (adapter === undefined) continue;
        const componentStatus = observedComponentStatus(
          adapter,
          snapshot.status,
        );
        snapshot.components[registration.component_id] = {
          status: componentStatus,
          updated_at: new Date().toISOString(),
          ...(adapter.lastError !== null ? { message: adapter.lastError } : {}),
          details: {
            queueDepth: adapter.queueDepth,
            overflowCount: adapter.overflowCount,
            reconciliationPending: adapter.reconciliationPending,
            errorCount: adapter.errorCount,
            ...(adapter.sourceStatus !== undefined
              ? { sourceStatus: adapter.sourceStatus }
              : {}),
          },
        };
        if (snapshot.status === 'healthy') {
          if (componentStatus === 'unhealthy') observedStatus = 'unhealthy';
          else if (
            observedStatus !== 'unhealthy' &&
            (componentStatus === 'starting' ||
              componentStatus === 'catching_up')
          ) {
            observedStatus = 'catching_up';
          }
        }
      }
      snapshot.status = observedStatus;
      return snapshot;
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      for (const registration of [...registrations].reverse()) {
        const handle = handles.get(registration.component_id);
        if (handle === undefined) continue;
        try {
          await handle.stop();
        } catch (error) {
          options.onStopError?.(registration.component_id, error);
        }
      }
    },
  };
}
