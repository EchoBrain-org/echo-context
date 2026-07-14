// V1.5 trace role taxonomy. Classifies a shared artifact by what it tells you
// about a pair of atoms — used by the cluster.edges filter to drop edges whose
// only shared artifacts are scope/session (cluster-membership restatement) and
// keep edges that carry real cross-tool signal.
//
// `unknown: keep` is the deliberate default: future V2+ adapters will emit
// types this registry doesn't know about (e.g. `opportunity`, `matter`,
// `patient_record`); generalizability requires keeping their edges until the
// registry catches up.

export type ArtifactRole = 'work' | 'session' | 'scope' | 'unknown';

const TYPE_TO_ROLE: Record<string, ArtifactRole> = {
  // scope — broad context everyone in the cluster shares
  repo: 'scope',
  workspace: 'scope',
  account: 'scope',
  org: 'scope',

  // session — continuous conversational/temporal thread
  conversation: 'session',
  thread: 'session',
  channel: 'session',

  // work — concrete artifact both atoms touched (cross-tool / cross-time signal)
  file: 'work',
  pr: 'work',
  issue: 'work',
  branch: 'work',
  commit: 'work',
  doc: 'work',
  crm_record: 'work',
  task: 'work',
  meeting: 'work',
  email_thread: 'work',
  record: 'work',
};

export function roleOf(artifactType: string): ArtifactRole {
  return TYPE_TO_ROLE[artifactType.toLowerCase()] ?? 'unknown';
}
