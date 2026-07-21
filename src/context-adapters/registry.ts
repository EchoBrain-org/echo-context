import {
  CLAUDE_CODE_CHECKPOINT_NAMESPACE,
  CODEX_CHECKPOINT_NAMESPACE,
} from '../capture/checkpoint-namespaces.js';
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
  ContextCaptureDefinition,
} from './contracts.js';

function withTrailingSlash(path: string): string {
  return path.endsWith('/') ? path : `${path}/`;
}

type BundledContextAdapterDefinition = ContextAdapterDefinition<CaptureRuntimeConfig>;
type LiveContextAdapterDefinition = BundledContextAdapterDefinition & {
  capture: ContextCaptureDefinition<CaptureRuntimeConfig>;
};

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
    startup_priority: 20,
    configure: (config) => ({
      enabled: config.claudeCode,
      start: async (storage) => {
        const { startClaudeCodeExtractor } = await import(
          '../capture/extractors/claude-code.js'
        );
        return startClaudeCodeExtractor(storage, {
          projectsPrefix: withTrailingSlash(config.claudeProjectsDir),
        });
      },
    }),
  },
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
    startup_priority: 10,
    configure: (config) => ({
      enabled: config.codex,
      start: async (storage) => {
        const { startCodexExtractor } = await import(
          '../capture/extractors/codex.js'
        );
        return startCodexExtractor(storage, {
          sessionsPrefix: withTrailingSlash(config.codexSessionsDir),
        });
      },
    }),
  },
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

export function validateContextAdapterDefinitions<Config>(
  definitions: readonly ContextAdapterDefinition<Config>[],
): void {
  const adapterIds = new Set<string>();
  const components = new Set<string>();
  const checkpoints = new Set<string>();
  const startupPriorities = new Set<number>();
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
    if (
      !Number.isSafeInteger(capture.startup_priority) ||
      capture.startup_priority < 0
    ) {
      throw new Error(
        `context adapter capture startup priority must be a non-negative safe integer: ${adapter_id}`,
      );
    }
    if (startupPriorities.has(capture.startup_priority)) {
      throw new Error(
        `capture startup priority already registered: ${capture.startup_priority}`,
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
    startupPriorities.add(capture.startup_priority);
  }
}

validateContextAdapterDefinitions(CONTEXT_ADAPTERS);

const NORMALIZATION_ADAPTERS: readonly AdapterRegistration[] = Object.freeze(
  CONTEXT_ADAPTERS.map((definition) => definition.normalization),
);

const CAPTURE_ADAPTERS: readonly LiveContextAdapterDefinition[] = Object.freeze(
  CONTEXT_ADAPTERS.filter(
    (definition): definition is LiveContextAdapterDefinition =>
      definition.capture !== undefined,
  ).sort(
    (left, right) =>
      left.capture.startup_priority - right.capture.startup_priority,
  ),
);

export function getContextAdapterRegistry(): readonly BundledContextAdapterDefinition[] {
  return CONTEXT_ADAPTERS;
}

export function getNormalizationAdapterRegistry(): readonly AdapterRegistration[] {
  return NORMALIZATION_ADAPTERS;
}

export function createCaptureAdapterRegistrations(
  config: CaptureRuntimeConfig,
): readonly CaptureAdapterRegistration[] {
  return CAPTURE_ADAPTERS.map((definition) => {
    const binding = definition.capture.configure(config);
    return {
      identity: definition.identity,
      component_id: definition.capture.component_id,
      checkpoint_namespace: definition.capture.checkpoint_namespace,
      enabled: binding.enabled,
      start: binding.start,
    };
  });
}

export function captureAdapterStatus(
  registrations: readonly CaptureAdapterRegistration[],
): Readonly<Record<string, boolean>> {
  return Object.freeze(Object.fromEntries(
    registrations.map((registration) => [
      registration.component_id,
      registration.enabled,
    ]),
  ));
}
