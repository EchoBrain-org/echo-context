import { isNonEmptyString } from '../../guards.js';
import type { CaptureEvent } from '../../storage/interface.js';

// Retrieval-only source identifiers. These remain available so a migrated
// ledger can resolve the current Granola signal run without importing the
// product-owned enrichment worker/poller subtree into the package build.
export const GRANOLA_SIGNAL_SOURCE = 'derived:granola-signals';
export const GRANOLA_SIGNAL_INDEX_SOURCE = 'derived:granola-signals-index';

export interface GranolaSignalRunManifest {
  note_id: string;
  extractor_version: string;
  extraction_run_id: string;
  completed_at: string;
  supersedes: string | null;
  signal_atom_ids: string[];
}

function parseManifest(event: CaptureEvent): GranolaSignalRunManifest | null {
  const metadata = event.metadata;
  if (metadata === undefined) return null;
  const noteId = metadata['note_id'];
  const extractorVersion = metadata['extractor_version'];
  const extractionRunId = metadata['extraction_run_id'];
  const completedAt = metadata['completed_at'];
  const supersedes = metadata['supersedes'];
  const signalAtomIds = metadata['signal_atom_ids'];
  if (
    !isNonEmptyString(noteId) ||
    !isNonEmptyString(extractorVersion) ||
    !isNonEmptyString(extractionRunId) ||
    !isNonEmptyString(completedAt) ||
    !Array.isArray(signalAtomIds) ||
    !signalAtomIds.every((id) => typeof id === 'string')
  ) {
    return null;
  }
  return {
    note_id: noteId,
    extractor_version: extractorVersion,
    extraction_run_id: extractionRunId,
    completed_at: completedAt,
    supersedes: typeof supersedes === 'string' ? supersedes : null,
    signal_atom_ids: signalAtomIds,
  };
}

export function resolveCurrentGranolaSignalRuns(
  manifestEvents: readonly CaptureEvent[],
): Map<string, GranolaSignalRunManifest> {
  const byNote = new Map<string, GranolaSignalRunManifest[]>();
  const superseded = new Set<string>();
  for (const event of manifestEvents) {
    const manifest = parseManifest(event);
    if (manifest === null) continue;
    const list = byNote.get(manifest.note_id) ?? [];
    list.push(manifest);
    byNote.set(manifest.note_id, list);
    if (manifest.supersedes !== null) superseded.add(manifest.supersedes);
  }

  const out = new Map<string, GranolaSignalRunManifest>();
  for (const [noteId, manifests] of byNote) {
    const current = manifests
      .filter((manifest) => !superseded.has(manifest.extraction_run_id))
      .sort((a, b) => {
        const completed = b.completed_at.localeCompare(a.completed_at);
        if (completed !== 0) return completed;
        return b.extraction_run_id.localeCompare(a.extraction_run_id);
      })[0];
    if (current !== undefined) out.set(noteId, current);
  }
  return out;
}
