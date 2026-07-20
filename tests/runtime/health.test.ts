import { describe, expect, it } from 'vitest';
import { HealthTracker } from '../../src/runtime/health.js';

describe('HealthTracker', () => {
  it('tracks lifecycle transitions and component snapshots', () => {
    const instants = [
      '2026-07-20T10:00:00.000Z',
      '2026-07-20T10:00:01.000Z',
      '2026-07-20T10:00:02.000Z',
      '2026-07-20T10:00:03.000Z',
      '2026-07-20T10:00:04.000Z',
      '2026-07-20T10:00:05.000Z',
    ];
    let index = 0;
    const tracker = new HealthTracker({
      now: () => new Date(instants[index++]!),
    });

    expect(tracker.snapshot()).toMatchObject({
      schema_version: 1,
      status: 'starting',
      started_at: instants[0],
      updated_at: instants[0],
      components: {},
    });

    tracker.transition('catching_up');
    tracker.setComponent('codex', 'catching_up', {
      message: 'replaying history',
      details: { queueDepth: 4, reconciliationPending: true },
    });
    tracker.setComponent('codex', 'healthy', {
      details: { queueDepth: 0, reconciliationPending: false },
    });
    tracker.transition('healthy');
    const stopping = tracker.transition('stopping');

    expect(stopping).toEqual({
      schema_version: 1,
      status: 'stopping',
      started_at: instants[0],
      updated_at: instants[5],
      components: {
        codex: {
          status: 'healthy',
          updated_at: instants[3],
          details: { queueDepth: 0, reconciliationPending: false },
        },
      },
    });
  });

  it('returns detached snapshots and rejects empty component names', () => {
    const tracker = new HealthTracker({ initialStatus: 'healthy' });
    const details = { queueDepth: 0 };
    const first = tracker.setComponent('watcher', 'healthy', { details });
    details.queueDepth = 9;
    first.components['watcher']!.status = 'unhealthy';
    first.components['watcher']!.details!['queueDepth'] = 12;

    expect(tracker.snapshot().components['watcher']?.status).toBe('healthy');
    expect(tracker.snapshot().components['watcher']?.details).toEqual({ queueDepth: 0 });
    expect(() => tracker.setComponent('  ', 'unhealthy')).toThrow('health component name must not be empty');
  });
});
