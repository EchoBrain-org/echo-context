import type { CaptureEvent } from '../storage/interface.js';

export class NormalizationError extends Error {
  override readonly cause: CaptureEvent;

  constructor(message: string, event: CaptureEvent) {
    super(message);
    this.name = 'NormalizationError';
    this.cause = event;
  }
}
