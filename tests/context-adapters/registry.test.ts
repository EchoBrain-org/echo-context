import { describe, expect, it } from 'vitest';
import { CLAUDE_CODE_CHECKPOINT_NAMESPACE } from '../../src/capture/extractors/claude-code.js';
import { CODEX_CHECKPOINT_NAMESPACE } from '../../src/capture/extractors/codex.js';
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
  } = {},
): ContextAdapterDefinition {
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
    options.checkpointNamespace !== undefined
      ? {
          capture: {
            component_id: options.componentId ?? `${adapterId}_component`,
            checkpoint_namespace:
              options.checkpointNamespace ?? `${adapterId}_checkpoint`,
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
    expect(
      registry
        .filter((entry) => entry.capture !== undefined)
        .map((entry) => entry.identity.adapter_id),
    ).toEqual(['claude-code', 'codex']);

    const captures = createCaptureAdapterRegistrations(CONFIG);
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
    expect(captureAdapterStatus(CONFIG)).toEqual({
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
        definition('alpha', { componentId: 'shared' }),
        definition('beta', { componentId: 'shared' }),
      ]),
    ).toThrow('capture health component already registered: shared');

    expect(() =>
      validateContextAdapterDefinitions([
        definition('alpha', { checkpointNamespace: 'shared' }),
        definition('beta', { checkpointNamespace: 'shared' }),
      ]),
    ).toThrow('capture checkpoint namespace already registered: shared');

    expect(() =>
      validateContextAdapterDefinitions([
        definition('alpha', { componentId: '', checkpointNamespace: 'alpha' }),
      ]),
    ).toThrow('context adapter capture identity must be non-empty: alpha');
  });
});
