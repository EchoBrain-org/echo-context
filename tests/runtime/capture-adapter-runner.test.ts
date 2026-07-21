import { describe, expect, it } from 'vitest';
import type {
  ExtractorHandle,
  ExtractorHealth,
} from '../../src/capture/extractors/_shared.js';
import type { CaptureAdapterRegistration } from '../../src/context-adapters/contracts.js';
import { createCaptureAdapterRunner } from '../../src/runtime/capture-adapter-runner.js';
import { HealthTracker } from '../../src/runtime/health.js';
import { MemoryStorage } from '../../src/storage/memory.js';

function healthyState(): ExtractorHealth {
  return {
    state: 'healthy',
    queueDepth: 0,
    overflowCount: 0,
    reconciliationPending: false,
    errorCount: 0,
    lastError: null,
  };
}

function registration(
  id: string,
  order: string[],
  options: {
    enabled?: boolean;
    health?: ExtractorHealth;
    stopError?: Error;
  } = {},
): CaptureAdapterRegistration {
  return {
    identity: { adapter_id: id, version: '1' },
    component_id: id,
    checkpoint_namespace: id,
    enabled: options.enabled ?? true,
    async start(): Promise<ExtractorHandle> {
      order.push(`start:${id}`);
      return {
        initialCatchUp: Promise.resolve().then(() => {
          order.push(`caught-up:${id}`);
        }),
        getHealth: () => options.health ?? healthyState(),
        async stop() {
          order.push(`stop:${id}`);
          if (options.stopError !== undefined) throw options.stopError;
        },
        probeFreshness: async () => ({
          maxGapBytes: 0,
          maxGapPath: null,
          filesChecked: 0,
        }),
      };
    },
  };
}

describe('capture adapter runner', () => {
  it('starts and catches up sequentially, then stops in reverse order', async () => {
    const order: string[] = [];
    const runner = createCaptureAdapterRunner([
      registration('first', order),
      registration('second', order),
    ]);
    const health = new HealthTracker();

    await expect(runner.start(new MemoryStorage(), health)).resolves.toBe(
      false,
    );
    await runner.stop();

    expect(order).toEqual([
      'start:first',
      'caught-up:first',
      'start:second',
      'caught-up:second',
      'stop:second',
      'stop:first',
    ]);
  });

  it('does not start disabled registrations', async () => {
    const order: string[] = [];
    const runner = createCaptureAdapterRunner([
      registration('disabled', order, { enabled: false }),
      registration('enabled', order),
    ]);
    const health = new HealthTracker();

    await runner.start(new MemoryStorage(), health);

    expect(order).toEqual(['start:enabled', 'caught-up:enabled']);
    expect(health.snapshot().components['disabled']).toMatchObject({
      status: 'healthy',
      message: 'disabled',
    });
  });

  it('projects live extractor health without provider-specific branches', async () => {
    const order: string[] = [];
    const adapterHealth: ExtractorHealth = {
      state: 'catching_up',
      queueDepth: 3,
      overflowCount: 1,
      reconciliationPending: true,
      errorCount: 2,
      lastError: 'retrying source',
      sourceStatus: 'active',
    };
    const runner = createCaptureAdapterRunner([
      registration('source', order, { health: adapterHealth }),
    ]);
    const health = new HealthTracker({ initialStatus: 'healthy' });
    await runner.start(new MemoryStorage(), health);
    health.transition('healthy');

    const observed = runner.observe(health.snapshot());

    expect(observed.status).toBe('catching_up');
    expect(observed.components['source']).toMatchObject({
      status: 'catching_up',
      message: 'retrying source',
      details: {
        queueDepth: 3,
        overflowCount: 1,
        reconciliationPending: true,
        errorCount: 2,
        sourceStatus: 'active',
      },
    });
  });

  it('continues reverse shutdown when one adapter stop fails', async () => {
    const order: string[] = [];
    const stopErrors: string[] = [];
    const runner = createCaptureAdapterRunner(
      [
        registration('first', order),
        registration('second', order, { stopError: new Error('stop failed') }),
      ],
      {
        onStopError: (componentId, error) => {
          stopErrors.push(`${componentId}:${(error as Error).message}`);
        },
      },
    );
    await runner.start(new MemoryStorage(), new HealthTracker());

    await runner.stop();
    await runner.stop();

    expect(order.slice(-2)).toEqual(['stop:second', 'stop:first']);
    expect(stopErrors).toEqual(['second:stop failed']);
  });
});
