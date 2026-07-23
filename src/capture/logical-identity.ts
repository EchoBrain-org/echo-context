const UUID_V7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Recover the millisecond creation time encoded in a UUIDv7 identifier.
 *
 * Codex preserves its UUIDv7 turn id when it copies parent history into a
 * forked session, but rewrites the JSONL line timestamp to the fork time. The
 * identifier is therefore the only truthful occurrence clock carried by both
 * the original observation and every inherited copy.
 */
export function occurredAtFromUuidV7(id: string | undefined): string | undefined {
  if (id === undefined || !UUID_V7_RE.test(id)) return undefined;
  const millis = Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16);
  if (!Number.isSafeInteger(millis)) return undefined;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export type ContextInitiator = 'human' | 'agent' | 'system' | 'unknown';

const SYSTEM_INPUT_PREFIXES = [
  '<system-reminder>',
  '<recommended_plugins>',
  '<environment_context>',
  '<permissions instructions>',
  '<collaboration_mode>',
  '<skills_instructions>',
  '<apps_instructions>',
  '<plugins_instructions>',
  '# AGENTS.md instructions',
] as const;

export function classifyContextInitiator(
  text: string,
  fallback: Exclude<ContextInitiator, 'system'> = 'human',
): ContextInitiator {
  const head = text.trimStart();
  for (const prefix of SYSTEM_INPUT_PREFIXES) {
    if (head.startsWith(prefix)) return 'system';
  }
  if (head.startsWith('<teammate-message')) return 'agent';
  return fallback;
}

export type ObservationKind = 'original' | 'inherited' | 'unknown';

export function classifyCodexObservation(input: {
  threadKind: string | undefined;
  sessionStartedAt: string | undefined;
  logicalTurnId: string | undefined;
  userTurnId: string | undefined;
  assistantTurnId: string | undefined;
  localTrigger: boolean;
}): ObservationKind {
  if (input.threadKind === 'root') return 'original';
  if (input.threadKind !== 'subagent') return 'unknown';
  if (input.localTrigger) return 'original';
  if (
    input.logicalTurnId === undefined ||
    input.userTurnId === undefined ||
    input.assistantTurnId === undefined ||
    input.userTurnId !== input.assistantTurnId
  ) {
    return 'unknown';
  }
  const occurredAt = occurredAtFromUuidV7(input.logicalTurnId);
  const occurredMs = occurredAt === undefined ? Number.NaN : Date.parse(occurredAt);
  const startedMs = Date.parse(input.sessionStartedAt ?? '');
  if (Number.isNaN(occurredMs) || Number.isNaN(startedMs)) return 'unknown';
  // Allow one second for timestamp/serialization jitter at the fork boundary.
  return occurredMs + 1_000 < startedMs ? 'inherited' : 'unknown';
}
