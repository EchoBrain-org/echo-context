import { canonicalJsonText } from './canonical-json.mjs';
import { SHA_40, buildPublishIntent } from './beta-release-domain.mjs';

export function hasExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

export function validateDraftBinding(stageRecord, release) {
  const binding = stageRecord?.draft;
  if (!binding) return { state: 'absent' };
  if (
    !release ||
    !hasExactKeys(binding, [
      'artifact_sha256',
      'gate_run_id',
      'manifest_sha256',
      'release_id',
      'release_root',
      'release_url',
      'source_commit',
      'status',
      'tag',
    ]) ||
    binding.status !== 'drafted' ||
    binding.release_root !== stageRecord.release_root ||
    binding.release_id !== release.id ||
    binding.source_commit !== stageRecord.source_commit ||
    binding.artifact_sha256 !== stageRecord.tarball_sha256 ||
    binding.manifest_sha256 !== stageRecord.manifest_sha256 ||
    binding.tag !== stageRecord.manifest.tag ||
    !Number.isSafeInteger(binding.gate_run_id) ||
    binding.gate_run_id <= 0
  ) {
    return { state: 'unknown', error: 'draft result is not bound to the exact stage and release' };
  }
  return { state: 'observed', value: binding };
}

export function validatePublishRecords(stageRecord, binding, release) {
  const expectedIntent = buildPublishIntent({
    artifactSha256: stageRecord.tarball_sha256,
    gateRunId: binding.gate_run_id,
    manifestSha256: stageRecord.manifest_sha256,
    releaseId: release.id,
    sourceCommit: stageRecord.source_commit,
    tag: stageRecord.manifest.tag,
  });
  const intent = stageRecord.publish_intent;
  if (intent && canonicalJsonText(intent) !== canonicalJsonText(expectedIntent)) {
    return { state: 'unknown', error: 'publish intent is not bound to the exact draft' };
  }
  const result = stageRecord.publish_result;
  if (!result) return { intent: intent ? 'recorded' : 'absent', state: 'absent' };
  if (
    !intent ||
    !hasExactKeys(result, [
      'artifact_sha256',
      'gate_run_id',
      'gate_run_url',
      'release_root',
      'release_url',
      'source_commit',
      'status',
      'tag',
    ]) ||
    result.status !== 'published' ||
    result.release_root !== stageRecord.release_root ||
    result.source_commit !== stageRecord.source_commit ||
    result.artifact_sha256 !== stageRecord.tarball_sha256 ||
    result.gate_run_id !== binding.gate_run_id ||
    result.tag !== stageRecord.manifest.tag
  ) {
    return { state: 'unknown', error: 'publish result is not bound to the exact draft' };
  }
  return { intent: 'recorded', state: 'recorded' };
}

export function exactHostedRunIdentity(run, stageRecord, binding) {
  const expectedPaths = new Set([
    '.github/workflows/beta-release-gate.yml',
    `.github/workflows/beta-release-gate.yml@${stageRecord.manifest.tag}`,
  ]);
  return (
    run?.id === binding.gate_run_id &&
    run?.event === 'workflow_dispatch' &&
    run?.run_attempt === 1 &&
    expectedPaths.has(run?.path) &&
    run?.head_sha === stageRecord.source_commit
  );
}

export function classifyReleaseLookup(releaseRequest, repository) {
  if (releaseRequest.state !== 'not_found') return releaseRequest;
  return repository.state === 'observed' && repository.value?.permissions?.push === true
    ? { state: 'absent' }
    : { state: 'unknown', error: 'candidate release may be hidden from this GitHub viewer' };
}

export function selectBetaCandidate({
  checkout,
  localTag,
  refs,
  sourceReviewObservation,
  stageRecords,
}) {
  const remoteTagTarget = refs.state === 'observed' ? refs.tag : null;
  const localTagTarget = localTag.state === 'observed' ? localTag.target : null;
  const identitySource =
    remoteTagTarget ??
    localTagTarget ??
    (stageRecords.length === 1 ? stageRecords[0].source_commit : null);
  const sourceCommit =
    identitySource ??
    (sourceReviewObservation.state === 'verified'
      ? sourceReviewObservation.source_commit
      : checkout.head);
  let sourceReview =
    sourceReviewObservation.state === 'verified' &&
    sourceReviewObservation.source_commit === sourceCommit
      ? sourceReviewObservation
      : { state: sourceReviewObservation.state === 'unknown' ? 'unknown' : 'missing' };
  const matchingStage =
    stageRecords.find((record) => record.source_commit === sourceCommit) ?? null;
  if (matchingStage?.state === 'recorded_passed') {
    const expectedEvidence = matchingStage.manifest?.evidence
      ? {
          github_verify: matchingStage.manifest.evidence.github_verify,
          independent_review: matchingStage.manifest.evidence.independent_review,
        }
      : null;
    if (
      sourceReview.state === 'verified' &&
      (!sourceReview.evidence ||
        !expectedEvidence ||
        canonicalJsonText(sourceReview.evidence) !== canonicalJsonText(expectedEvidence))
    ) {
      sourceReview = { state: 'missing' };
    }
  }
  if (sourceReview.state === 'verified') {
    sourceReview = {
      ...(typeof sourceReview.approval === 'string'
        ? { approval: sourceReview.approval }
        : {}),
      ...(Number.isSafeInteger(sourceReview.pull_request)
        ? { pull_request: sourceReview.pull_request }
        : {}),
      source_commit: sourceReview.source_commit,
      state: sourceReview.state,
      ...(typeof sourceReview.verify_url === 'string'
        ? { verify_url: sourceReview.verify_url }
        : {}),
    };
  }
  const stage =
    stageRecords.length > 1 || (stageRecords.length === 1 && !matchingStage)
      ? { state: 'conflict' }
      : matchingStage
        ? { release_root: matchingStage.release_root, state: matchingStage.state }
        : { state: 'absent' };
  return {
    localTagTarget,
    matchingStage,
    remoteTagTarget,
    sourceCommit,
    sourceReview,
    stage,
  };
}

export function assembleBetaReleaseStatus({
  beta,
  checkout,
  draftBinding,
  gate,
  latestPublicBeta,
  live,
  localMain,
  localTag,
  publishRecords,
  refs,
  release,
  releaseIdentity,
  releaseNotes,
  releasePolicy,
  sourceOnMain,
  sourceReviewObservation,
  stageRecords,
  unknowns = [],
}) {
  const selection = selectBetaCandidate({
    checkout,
    localTag,
    refs,
    sourceReviewObservation,
    stageRecords,
  });
  const draft =
    release?.draft === true
      ? {
          state:
            releaseIdentity.state === 'validated' && draftBinding.state === 'observed'
              ? 'validated'
              : 'partial',
          url: release.html_url ?? null,
        }
      : { state: 'absent' };
  let publication = { state: 'absent' };
  if (release && !release.draft) {
    const gateBeforePublish = Date.parse(gate.completed_at ?? '');
    const publishedAt = Date.parse(release.published_at ?? '');
    const fullyBound =
      releaseIdentity.state === 'validated' &&
      draftBinding.state === 'observed' &&
      publishRecords.state === 'recorded' &&
      gate.state === 'verified_succeeded' &&
      Number.isFinite(gateBeforePublish) &&
      Number.isFinite(publishedAt) &&
      publishedAt >= gateBeforePublish;
    publication = {
      immutable: release.immutable,
      intent: publishRecords.intent,
      state: fullyBound ? 'validated' : 'partial',
      url: release.html_url ?? null,
    };
  }
  const candidate = {
    draft,
    gate,
    publication,
    release_identity: releaseIdentity,
    release_notes: releaseNotes.error
      ? { error: releaseNotes.error, state: releaseNotes.state }
      : { state: releaseNotes.state },
    release_policy: releasePolicy.error
      ? { error: releasePolicy.error, state: releasePolicy.state }
      : { state: releasePolicy.state },
    runtime_digest: selection.matchingStage?.runtime_digest ?? null,
    source_commit: selection.sourceCommit,
    source_on_main: sourceOnMain,
    source_review: selection.sourceReview,
    stage: selection.stage,
    tarball_sha256: selection.matchingStage?.tarball_sha256 ?? null,
    tag: {
      local_target: selection.localTagTarget,
      name: beta.tag,
      remote:
        refs.state === 'observed'
          ? { state: 'observed', target: refs.tag }
          : { state: 'unknown', target: null },
    },
    tag_mismatch: Boolean(
      (selection.localTagTarget &&
        selection.remoteTagTarget &&
        selection.localTagTarget !== selection.remoteTagTarget) ||
        (release && selection.remoteTagTarget !== selection.sourceCommit) ||
        (release && release.target_commitish !== selection.sourceCommit),
    ),
    version: beta.version,
  };
  const snapshotUnknowns = [...unknowns];
  if (candidate.release_notes.state === 'unknown') {
    snapshotUnknowns.push('release notes: candidate source is unavailable');
  }
  if (candidate.source_on_main === 'unknown') snapshotUnknowns.push('main ancestry: unavailable');
  const snapshot = {
    candidate,
    checkout,
    latest_public_beta: latestPublicBeta,
    live,
    main: {
      local: localMain.state === 'observed' ? localMain.value : null,
      remote:
        refs.state === 'observed'
          ? { commit: refs.main, state: 'observed' }
          : { commit: null, state: 'unknown' },
    },
    schema: 'beta-release-status.v2',
    unknowns: snapshotUnknowns,
  };
  return { ...snapshot, ...deriveBetaReleaseState(snapshot) };
}

export function deriveBetaReleaseState(snapshot) {
  const candidate = snapshot.candidate;
  const action = (overall, id, summary, command = null) => ({
    next_action: { command, id, summary },
    overall,
  });
  const exactCheckout = snapshot.checkout.clean && snapshot.checkout.head === candidate.source_commit;
  const requireExactCheckout = () => {
    if (exactCheckout) return null;
    if (!snapshot.checkout.clean) {
      return action(
        'blocked',
        'clean_checkout',
        'Make the worktree clean without discarding work, then check out the exact reviewed source.',
      );
    }
    return action(
      'blocked',
      'checkout_exact_source',
      `Check out the exact reviewed source ${candidate.source_commit}; do not rebuild or retag it.`,
      ['git', 'switch', '--detach', candidate.source_commit],
    );
  };
  if ((snapshot.unknowns ?? []).length > 0) {
    return action('unknown', 'restore_visibility', 'Restore the unavailable read-only evidence before changing release state.');
  }
  if (
    candidate.tag_mismatch ||
    candidate.stage.state === 'conflict' ||
    candidate.release_identity.state === 'invalid'
  ) {
    return action('blocked', 'inspect_identity_conflict', 'Inspect the conflicting tag or stage identity; do not retag or rebuild.');
  }
  if (!['absent', 'recorded_passed'].includes(candidate.stage.state)) {
    return action('blocked', 'inspect_stage_evidence', 'Inspect the existing incomplete stage; its version cannot be silently rebuilt.');
  }
  if (
    candidate.release_notes.state === 'missing' &&
    (candidate.tag.remote.target || candidate.tag.local_target || candidate.stage.state === 'recorded_passed')
  ) {
    return action('blocked', 'prepare_next_beta', `Treat ${candidate.version} as consumed and prepare the next beta with reviewed notes before staging.`);
  }
  if (candidate.release_notes.state !== 'present') {
    return action('blocked', 'add_release_notes', `Add reviewed release-notes/${candidate.version}.md before staging.`);
  }
  if (candidate.publication.state === 'validated') {
    if (
      snapshot.live.state === 'healthy' &&
      candidate.runtime_digest &&
      snapshot.live.runtime_digest === candidate.runtime_digest
    ) {
      return action('complete', 'none', 'Published and live runtime identities match.');
    }
    return action('published_not_live', 'promote_founder_live', 'The beta is published; founder-live promotion remains a separate operator decision.');
  }
  if (candidate.source_on_main !== true || candidate.source_review.state !== 'verified') {
    return action('blocked', 'merge_reviewed_source', 'Finish and merge the reviewed source before changing release state.');
  }
  if (candidate.release_policy.state !== 'verified') {
    return action(
      'blocked',
      'repair_release_policy',
      `Repair the beta release policy before continuing: ${candidate.release_policy.error ?? 'policy is invalid'}.`,
    );
  }
  if (candidate.publication.state === 'partial') {
    if (candidate.gate.state === 'verified_succeeded' && candidate.publication.intent === 'recorded') {
      const checkoutAction = requireExactCheckout();
      if (checkoutAction) return checkoutAction;
      return action(
        'ready_to_publish',
        'finish_exact_publication',
        'Re-run the authoritative publish gate to verify and finish the already-public exact release.',
        [
          'npm', 'run', 'beta:publish', '--',
          '--release-root', candidate.stage.release_root,
          '--confirm-source-sha', candidate.source_commit,
          '--confirm-artifact-sha', candidate.tarball_sha256,
        ],
      );
    }
    return action('blocked', 'inspect_published_handoff', 'The public release lacks one complete locally recorded publication handoff.');
  }
  if (candidate.draft.state === 'validated') {
    if (candidate.gate.state === 'verified_succeeded') {
      const checkoutAction = requireExactCheckout();
      if (checkoutAction) return checkoutAction;
      return action(
        'ready_to_publish',
        'publish_exact_draft',
        'Publish the unchanged, fully validated draft from its recorded release root.',
        [
          'npm', 'run', 'beta:publish', '--',
          '--release-root', candidate.stage.release_root,
          '--confirm-source-sha', candidate.source_commit,
          '--confirm-artifact-sha', candidate.tarball_sha256,
        ],
      );
    }
    if (candidate.gate.state === 'pending') {
      return action('waiting_for_gate', 'approve_or_wait', 'Approve or wait for the recorded beta release gate.');
    }
    return action('blocked', 'inspect_draft_gate', 'The draft and hosted gate do not form one complete handoff.');
  }
  if (candidate.draft.state === 'partial') {
    return action('blocked', 'inspect_partial_draft', 'A GitHub draft exists without one exact validated local handoff.');
  }
  if (candidate.tag.remote.target || candidate.tag.local_target) {
    return action('blocked', 'inspect_partial_candidate', 'A tag exists without a resumable draft; inspect it instead of deleting or repointing it.');
  }
  if (candidate.stage.state === 'recorded_passed') {
    const checkoutAction = requireExactCheckout();
    if (checkoutAction) return checkoutAction;
    return action(
      'ready_to_draft',
      'draft_exact_stage',
      'Run the authoritative draft gate against the exact recorded stage; do not rebuild.',
      ['npm', 'run', 'beta:draft', '--', '--release-root', candidate.stage.release_root],
    );
  }
  const checkoutAction = requireExactCheckout();
  if (checkoutAction) return checkoutAction;
  return action(
    'ready_to_stage',
    'stage_candidate',
    'Run the authoritative stage gate for the exact reviewed source.',
    ['npm', 'run', 'beta:stage'],
  );
}

export function formatBetaReleaseStatus(status) {
  const short = (value) => (SHA_40.test(value ?? '') ? value.slice(0, 7) : 'unknown');
  const shellWord = (value) =>
    /^[A-Za-z0-9_./:=+-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
  const candidate = status.candidate;
  const mainText =
    status.main.remote.state === 'observed'
      ? `${short(status.main.local)} local / ${short(status.main.remote.commit)} GitHub${status.main.local === status.main.remote.commit ? ' (agree)' : ' (differ)'}`
      : `${short(status.main.local)} local / GitHub unknown`;
  const tagText =
    candidate.tag.remote.state === 'observed'
      ? candidate.tag.remote.target
        ? `${candidate.tag.name} → ${short(candidate.tag.remote.target)}`
        : `${candidate.tag.name} absent`
      : `${candidate.tag.name} → unknown`;
  const latest =
    status.latest_public_beta.state === 'published'
      ? status.latest_public_beta.version
      : status.latest_public_beta.state;
  const live =
    status.live.state === 'healthy'
      ? `healthy ${status.live.version} at ${status.live.endpoint}`
      : `${status.live.state}${status.live.endpoint ? ` at ${status.live.endpoint}` : ''}`;
  return [
    `Beta status — ${candidate.version}`,
    '',
    `Checkout    ${short(status.checkout.head)}  ${status.checkout.branch}  ${status.checkout.clean ? 'clean' : 'dirty'}`,
    `Main        ${mainText}`,
    `Candidate   ${short(candidate.source_commit)}`,
    `Tag         ${tagText}`,
    `Notes       ${candidate.release_notes.state}`,
    `Stage       ${candidate.stage.state}`,
    `Draft       ${candidate.draft.state}`,
    `Gate        ${candidate.gate.state}`,
    `Published   ${candidate.publication.state}; latest public beta is ${latest}`,
    `Live        ${live}`,
    '',
    `State       ${status.overall.toUpperCase()}`,
    `Next        ${status.next_action.summary}`,
    ...(status.next_action.command
      ? [`Command     ${status.next_action.command.map(shellWord).join(' ')}`]
      : []),
    ...(status.unknowns.length > 0 ? ['', `Unknown     ${status.unknowns.join('; ')}`] : []),
  ].join('\n');
}
