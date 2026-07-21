import type { ExtractorHandle } from '../capture/extractors/_shared.js';
import type { AdapterRegistration } from '../normalize/types.js';
import type { Storage } from '../storage/interface.js';

/** Stable observational identity for one context adapter implementation. */
export interface ContextAdapterIdentity {
  readonly adapter_id: string;
  readonly version: string;
}

/** Static capture metadata. The extractor owns the named durable checkpoint. */
export interface ContextCaptureDescriptor {
  readonly component_id: string;
  readonly checkpoint_namespace: string;
}

/** One bundled context adapter. Capture is optional so migrated sources can
 * remain readable without retaining their live provider integration. */
export interface ContextAdapterDefinition {
  readonly identity: ContextAdapterIdentity;
  readonly normalization: AdapterRegistration;
  readonly capture?: ContextCaptureDescriptor;
}

/** Fully composed live-capture registration consumed by the generic runner. */
export interface CaptureAdapterRegistration extends ContextCaptureDescriptor {
  readonly identity: ContextAdapterIdentity;
  readonly enabled: boolean;
  start(storage: Storage): Promise<ExtractorHandle>;
}
