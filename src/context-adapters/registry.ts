import {
  CLAUDE_CODE_CHECKPOINT_NAMESPACE,
  startClaudeCodeExtractor,
} from '../capture/extractors/claude-code.js';
import {
  CODEX_CHECKPOINT_NAMESPACE,
  startCodexExtractor,
} from '../capture/extractors/codex.js';
import {
  adaptClaudeCode,
  CLAUDE_CODE_VERSION,
  matchesClaudeCode,
} from '../normalize/adapters/claude-code.js';
import {
  adaptCodex,
  CODEX_VERSION,
  matchesCodex,
} from '../normalize/adapters/codex.js';
import {
  adaptCursor,
  CURSOR_VERSION,
  matchesCursor,
} from '../normalize/adapters/cursor.js';
import {
  adaptGit,
  GIT_VERSION,
  matchesGit,
} from '../normalize/adapters/git.js';
import {
  adaptGranola,
  GRANOLA_VERSION,
  matchesGranola,
} from '../normalize/adapters/granola.js';
import type { AdapterRegistration } from '../normalize/types.js';
import type { CaptureRuntimeConfig } from '../runtime/config.js';
import type {
  CaptureAdapterRegistration,
  ContextAdapterDefinition,
} from './contracts.js';

interface BundledContextAdapterDefinition extends ContextAdapterDefinition {
  createCapture?: (config: CaptureRuntimeConfig) => CaptureAdapterRegistration;
}

function withTrailingSlash(path: string): string {
  return path.endsWith('/') ? path : `${path}/`;
}

const CLAUDE_CODE_ADAPTER: BundledContextAdapterDefinition = {
  identity: {
    adapter_id: 'claude-code',
    version: CLAUDE_CODE_VERSION,
  },
  normalization: {
    name: 'claude-code',
    version: CLAUDE_CODE_VERSION,
    matches: matchesClaudeCode,
    adapter: adaptClaudeCode,
  },
  capture: {
    component_id: 'claude_code',
    checkpoint_namespace: CLAUDE_CODE_CHECKPOINT_NAMESPACE,
  },
  createCapture: (config) => ({
    identity: CLAUDE_CODE_ADAPTER.identity,
    component_id: CLAUDE_CODE_ADAPTER.capture!.component_id,
    checkpoint_namespace: CLAUDE_CODE_ADAPTER.capture!.checkpoint_namespace,
    enabled: config.claudeCode,
    start: (storage) =>
      startClaudeCodeExtractor(storage, {
        projectsPrefix: withTrailingSlash(config.claudeProjectsDir),
      }),
  }),
};

const CODEX_ADAPTER: BundledContextAdapterDefinition = {
  identity: {
    adapter_id: 'codex',
    version: CODEX_VERSION,
  },
  normalization: {
    name: 'codex',
    version: CODEX_VERSION,
    matches: matchesCodex,
    adapter: adaptCodex,
  },
  capture: {
    component_id: 'codex',
    checkpoint_namespace: CODEX_CHECKPOINT_NAMESPACE,
  },
  createCapture: (config) => ({
    identity: CODEX_ADAPTER.identity,
    component_id: CODEX_ADAPTER.capture!.component_id,
    checkpoint_namespace: CODEX_ADAPTER.capture!.checkpoint_namespace,
    enabled: config.codex,
    start: (storage) =>
      startCodexExtractor(storage, {
        sessionsPrefix: withTrailingSlash(config.codexSessionsDir),
      }),
  }),
};

const CONTEXT_ADAPTERS: readonly BundledContextAdapterDefinition[] =
  Object.freeze([
    CLAUDE_CODE_ADAPTER,
    CODEX_ADAPTER,
    {
      identity: { adapter_id: 'cursor', version: CURSOR_VERSION },
      normalization: {
        name: 'cursor',
        version: CURSOR_VERSION,
        matches: matchesCursor,
        adapter: adaptCursor,
      },
    },
    {
      identity: { adapter_id: 'git', version: GIT_VERSION },
      normalization: {
        name: 'git',
        version: GIT_VERSION,
        matches: matchesGit,
        adapter: adaptGit,
      },
    },
    {
      identity: { adapter_id: 'granola', version: GRANOLA_VERSION },
      normalization: {
        name: 'granola',
        version: GRANOLA_VERSION,
        matches: matchesGranola,
        adapter: adaptGranola,
      },
    },
  ]);

const CAPTURE_ORDER = ['codex', 'claude-code'] as const;

export function validateContextAdapterDefinitions(
  definitions: readonly ContextAdapterDefinition[],
): void {
  const adapterIds = new Set<string>();
  const components = new Set<string>();
  const checkpoints = new Set<string>();
  for (const definition of definitions) {
    const { adapter_id, version } = definition.identity;
    if (adapter_id.length === 0 || version.length === 0) {
      throw new Error('context adapter identity must be non-empty');
    }
    if (adapterIds.has(adapter_id)) {
      throw new Error(`context adapter already registered: ${adapter_id}`);
    }
    adapterIds.add(adapter_id);
    if (
      definition.normalization.name !== adapter_id ||
      definition.normalization.version !== version
    ) {
      throw new Error(
        `context adapter normalization identity mismatch: ${adapter_id}`,
      );
    }
    const capture = definition.capture;
    if (capture === undefined) continue;
    if (
      capture.component_id.length === 0 ||
      capture.checkpoint_namespace.length === 0
    ) {
      throw new Error(
        `context adapter capture identity must be non-empty: ${adapter_id}`,
      );
    }
    if (components.has(capture.component_id)) {
      throw new Error(
        `capture health component already registered: ${capture.component_id}`,
      );
    }
    if (checkpoints.has(capture.checkpoint_namespace)) {
      throw new Error(
        `capture checkpoint namespace already registered: ${capture.checkpoint_namespace}`,
      );
    }
    components.add(capture.component_id);
    checkpoints.add(capture.checkpoint_namespace);
  }
}

validateContextAdapterDefinitions(CONTEXT_ADAPTERS);

const NORMALIZATION_ADAPTERS: readonly AdapterRegistration[] = Object.freeze(
  CONTEXT_ADAPTERS.map((definition) => definition.normalization),
);

export function getContextAdapterRegistry(): readonly ContextAdapterDefinition[] {
  return CONTEXT_ADAPTERS;
}

export function getNormalizationAdapterRegistry(): readonly AdapterRegistration[] {
  return NORMALIZATION_ADAPTERS;
}

export function createCaptureAdapterRegistrations(
  config: CaptureRuntimeConfig,
): readonly CaptureAdapterRegistration[] {
  return CAPTURE_ORDER.map((adapterId) => {
    const definition = CONTEXT_ADAPTERS.find(
      (candidate) => candidate.identity.adapter_id === adapterId,
    );
    if (
      definition?.capture === undefined ||
      definition.createCapture === undefined
    ) {
      throw new Error(`capture adapter is not installed: ${adapterId}`);
    }
    return definition.createCapture(config);
  });
}

export function captureAdapterStatus(
  config: CaptureRuntimeConfig,
): Record<string, boolean> {
  return Object.fromEntries(
    createCaptureAdapterRegistrations(config).map((registration) => [
      registration.component_id,
      registration.enabled,
    ]),
  );
}
