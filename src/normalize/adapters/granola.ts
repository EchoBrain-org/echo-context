import type { CaptureEvent } from '../../storage/interface.js';
import type {
  Adapter,
  ActorRef,
  ArtifactRef,
  ContextRef,
  NormalizedContextEvent,
} from '../types.js';
import { buildProvenance, fail, getString } from './_shared.js';

export const GRANOLA_VERSION = 'granola@1';
export const GRANOLA_SOURCE_RE = /^api:granola$/;

export function matchesGranola(source: string): boolean {
  return GRANOLA_SOURCE_RE.test(source);
}

export const adaptGranola: Adapter = (event: CaptureEvent): NormalizedContextEvent => {
  const meta = event.metadata;
  const noteId = getString(meta, 'note_id');
  if (noteId === undefined) {
    fail(event, 'granola: missing metadata.note_id');
  }
  const atomType = getString(meta, 'granola_atom_type') ?? 'note';
  const title = getString(meta, 'title') ?? 'Untitled Granola note';
  const webUrl = getString(meta, 'web_url');
  const createdAt = getString(meta, 'created_at');
  const updatedAt = getString(meta, 'updated_at');

  const artifacts: ArtifactRef[] = [
    {
      type: 'meeting_note',
      provider: 'granola',
      id: `granola:${noteId}`,
      label: title,
      ...(webUrl !== undefined ? { locator: webUrl } : {}),
    },
  ];

  const ambient: Record<string, string> = {};
  if (createdAt !== undefined) ambient.created_at = createdAt;
  if (updatedAt !== undefined) ambient.updated_at = updatedAt;
  const context: ContextRef | undefined = Object.keys(ambient).length > 0 ? { ambient } : undefined;

  const out: NormalizedContextEvent = {
    schema_version: 1,
    id: event.id,
    time: { occurred_at: event.timestamp },
    source: {
      app: 'granola',
      surface: atomType,
      raw_pointer: event.source,
    },
    actors: actorsFromAttendees(meta),
    action: {
      kind: 'meeting_note',
      verb: atomType === 'transcript' ? 'transcribed' : 'summarized',
      output: event.content,
    },
    artifacts,
    provenance: buildProvenance(event, GRANOLA_VERSION),
  };
  if (context !== undefined) out.context = context;
  return out;
};

function actorsFromAttendees(meta: Record<string, unknown> | undefined): ActorRef[] {
  const attendees = meta?.['attendees'];
  if (!Array.isArray(attendees)) return [];
  const actors: ActorRef[] = [];
  for (const attendee of attendees) {
    if (typeof attendee === 'string' && attendee.length > 0) {
      actors.push({ role: 'participant', name: attendee });
      continue;
    }
    if (typeof attendee !== 'object' || attendee === null || Array.isArray(attendee)) continue;
    const name = (attendee as Record<string, unknown>)['name'];
    if (typeof name === 'string' && name.length > 0) {
      actors.push({ role: 'participant', name });
    }
  }
  return actors;
}
