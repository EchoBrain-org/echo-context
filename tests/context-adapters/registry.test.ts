import { describe, expect, it } from 'vitest';
import {
  CLAUDE_CODE_CHECKPOINT_NAMESPACE,
  CODEX_CHECKPOINT_NAMESPACE,
} from '../../src/capture/checkpoint-namespaces.js';
import type { ContextAdapterDefinition } from '../../src/context-adapters/contracts.js';
import {
  captureAdapterStatus,
  createCaptureAdapterRegistrations,
  getContextAdapterRegistry,
  getNormalizationAdapterRegistry,
  validateContextAdapterDefinitions,
} from '../../src/context-adapters/registry.js';
import type { CaptureRuntimeConfig } from '../../src/runtime/config.js';

const CONFIG: CaptureRuntimeConfig = {
  codex: true,
  claudeCode: false,
  codexSessionsDir: '/tmp/codex-sessions',
  claudeProjectsDir: '/tmp/claude-projects',
};

function definition(
  adapterId: string,
  options: {
    version?: string;
    normalizationName?: string;
    normalizationVersion?: string;
    componentId?: string;
    checkpointNamespace?: string;
    startupPriority?: number;
  } = {},
): ContextAdapterDefinition<CaptureRuntimeConfig> {
  const version = options.version ?? '1';
  return {
    identity: { adapter_id: adapterId, version },
    normalization: {
      name: options.normalizationName ?? adapterId,
      version: options.normalizationVersion ?? version,
      matches: () => false,
      adapter: () => null,
    },
    ...(options.componentId !== undefined ||
    options.checkpointNamespace !== undefined ||
    options.startupPriority !== undefined
      ? {
          capture: {
            component_id: options.componentId ?? `${adapterId}_component`,
            checkpoint_namespace:
              options.checkpointNamespace ?? `${adapterId}_checkpoint`,
            startup_priority: options.startupPriority ?? 10,
            configure: () => ({
              enabled: false,
              start: async () => {
                throw new Error('test capture must not start');
              },
            }),
          },
        }
      : {}),
  };
}

describe('context adapter registry', () => {
  it('keeps one stable identity order across definitions and normalization', () => {
    const expected = ['claude-code', 'codex', 'cursor', 'git', 'granola'];

    expect(
      getContextAdapterRegistry().map((entry) => entry.identity.adapter_id),
    ).toEqual(expected);
    expect(
      getNormalizationAdapterRegistry().map((entry) => entry.name),
    ).toEqual(expected);
  });

  it('exposes live capture only for Codex and Claude Code', () => {
    const registry = getContextAdapterRegistry();
    const liveDefinitions = registry.filter(
      (entry) => entry.capture !== undefined,
    );
    expect(liveDefinitions.map((entry) => entry.identity.adapter_id)).toEqual([
      'claude-code',
      'codex',
    ]);

    const captures = createCaptureAdapterRegistrations(CONFIG);
    expect(
      captures.map((entry) => entry.identity.adapter_id).sort(),
    ).toEqual(
      liveDefinitions.map((entry) => entry.identity.adapter_id).sort(),
    );
    expect(
      captures.map((entry) => ({
        adapter: entry.identity.adapter_id,
        component: entry.component_id,
        checkpoint: entry.checkpoint_namespace,
        enabled: entry.enabled,
      })),
    ).toEqual([
      {
        adapter: 'codex',
        component: 'codex',
        checkpoint: CODEX_CHECKPOINT_NAMESPACE,
        enabled: true,
      },
      {
        adapter: 'claude-code',
        component: 'claude_code',
        checkpoint: CLAUDE_CODE_CHECKPOINT_NAMESPACE,
        enabled: false,
      },
    ]);
    expect(captures).toHaveLength(liveDefinitions.length);
    for (const registration of captures) {
      const definition = liveDefinitions.find(
        (entry) =>
          entry.identity.adapter_id === registration.identity.adapter_id,
      );
      expect(definition?.capture).toMatchObject({
        component_id: registration.component_id,
        checkpoint_namespace: registration.checkpoint_namespace,
      });
    }
    expect(captureAdapterStatus(captures)).toEqual({
      codex: true,
      claude_code: false,
    });
  });

  it('rejects ambiguous or mismatched definitions before runtime startup', () => {
    expect(() =>
      validateContextAdapterDefinitions([
        definition('same'),
        definition('same'),
      ]),
    ).toThrow('context adapter already registered: same');

    expect(() =>
      validateContextAdapterDefinitions([
        definition('alpha', { normalizationName: 'other' }),
      ]),
    ).toThrow('context adapter normalization identity mismatch: alpha');

    expect(() =>
      validateContextAdapterDefinitions([
        definition('alpha', { componentId: 'shared', startupPriority: 1 }),
        definition('beta', { componentId: 'shared', startupPriority: 2 }),
      ]),
    ).toThrow('capture health component already registered: shared');

    expect(() =>
      validateContextAdapterDefinitions([
        definition('alpha', {
          checkpointNamespace: 'shared',
          startupPriority: 1,
        }),
        definition('beta', {
          checkpointNamespace: 'shared',
          startupPriority: 2,
        }),
      ]),
    ).toThrow('capture checkpoint namespace already registered: shared');

    expect(() =>
      validateContextAdapterDefinitions([
        definition('alpha', { componentId: '', checkpointNamespace: 'alpha' }),
      ]),
    ).toThrow('context adapter capture identity must be non-empty: alpha');

    for (const startupPriority of [-1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() =>
        validateContextAdapterDefinitions([
          definition('alpha', { startupPriority }),
        ]),
      ).toThrow(
        'context adapter capture startup priority must be a non-negative safe integer: alpha',
      );
    }

    expect(() =>
      validateContextAdapterDefinitions([
        definition('alpha', { startupPriority: 1 }),
        definition('beta', { startupPriority: 1 }),
      ]),
    ).toThrow('capture startup priority already registered: 1');
  });
});
