import { describe, expect, it } from 'vitest';
import { normalizeEvent } from '../../../src/context-adapters/normalization.js';
import type { CaptureEvent } from '../../../src/storage/interface.js';

const granolaSummaryFixture: CaptureEvent = {
  id: 'evt_granola_0001',
  source: 'api:granola',
  timestamp: '2026-06-21T10:00:00.000Z',
  content: '## Customer call\n\n- They need deployment clarity.',
  metadata: {
    note_id: 'note_123',
    granola_atom_type: 'summary',
    dedupe_key: 'granola:note_123:summary',
    title: 'Customer call',
    created_at: '2026-06-21T09:00:00.000Z',
    updated_at: '2026-06-21T10:00:00.000Z',
    attendees: [{ name: 'Avery' }, { name: 'Morgan' }],
    web_url: 'https://granola.ai/notes/note_123',
  },
};

describe('granola adapter', () => {
  const out = normalizeEvent(granolaSummaryFixture);
  if (out === null) throw new Error('expected adapter to match');

  it('source.app=granola and surface follows atom type', () => {
    expect(out.source.app).toBe('granola');
    expect(out.source.surface).toBe('summary');
    expect(out.source.raw_pointer).toBe('api:granola');
  });

  it('actors carry attendee names as participants', () => {
    expect(out.actors).toEqual([
      { role: 'participant', name: 'Avery' },
      { role: 'participant', name: 'Morgan' },
    ]);
  });

  it('action.kind=meeting_note and output is the atom content', () => {
    expect(out.action.kind).toBe('meeting_note');
    expect(out.action.verb).toBe('summarized');
    expect(out.action.output).toContain('deployment clarity');
  });

  it('artifacts include the Granola note identity and locator', () => {
    expect(out.artifacts).toEqual([
      {
        type: 'meeting_note',
        provider: 'granola',
        id: 'granola:note_123',
        label: 'Customer call',
        locator: 'https://granola.ai/notes/note_123',
      },
    ]);
  });

  it('context.ambient carries created_at and updated_at', () => {
    expect(out.context?.ambient).toEqual({
      created_at: '2026-06-21T09:00:00.000Z',
      updated_at: '2026-06-21T10:00:00.000Z',
    });
  });

  it('provenance.extractor_version is granola@1', () => {
    expect(out.provenance.extractor_version).toBe('granola@1');
  });
});
