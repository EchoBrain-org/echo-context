import type { ExtractorHandle } from '../capture/contracts.js';
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

/** Configured provider lifecycle. Static identity remains in the descriptor so
 * registration metadata cannot drift from the implementation binding. */
export interface CaptureAdapterBinding {
  readonly enabled: boolean;
  start(storage: Storage): Promise<ExtractorHandle>;
}

/** Complete optional capture capability for one bundled adapter. */
export interface ContextCaptureDefinition<Config>
  extends ContextCaptureDescriptor {
  /** Lower priorities catch up first. Values must be unique safe integers. */
  readonly startup_priority: number;
  configure(config: Config): CaptureAdapterBinding;
}

/** One bundled context adapter. Capture is optional so migrated sources can
 * remain readable without retaining their live provider integration. */
export interface ContextAdapterDefinition<Config = never> {
  readonly identity: ContextAdapterIdentity;
  readonly normalization: AdapterRegistration;
  readonly capture?: ContextCaptureDefinition<Config>;
}

/** Fully composed live-capture registration consumed by the generic runner. */
export interface CaptureAdapterRegistration
  extends ContextCaptureDescriptor,
    CaptureAdapterBinding {
  readonly identity: ContextAdapterIdentity;
}
