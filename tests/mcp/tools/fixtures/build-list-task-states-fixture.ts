import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ListTaskStatesFixture {
  repoRoot: string;
  ref: string;
  cleanup: () => void;
}

interface BuildFixtureOptions {
  extraCompleteTasks?: number;
  bodyPaddingBytes?: number;
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'ECHO Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@echo.local',
  GIT_AUTHOR_DATE: '2026-07-02T12:00:00Z',
  GIT_COMMITTER_NAME: 'ECHO Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@echo.local',
  GIT_COMMITTER_DATE: '2026-07-02T12:00:00Z',
};

function git(repoRoot: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
}

function pointerBody(taskId: string, specStage: string, bodyPaddingBytes = 0): string {
  const padding = bodyPaddingBytes > 0 ? `\n<!-- ${'x'.repeat(bodyPaddingBytes)} -->\n` : '';
  return `## current_thesis
Fixture pointer for ${taskId}.${padding}

## locked_decisions
- Keep this pointer compact.

## open_questions
- None.

## dont_touch
- Fixture-only content.

## canonical_anchors
- spec: backlog/${specStage}/${taskId}.md
- reviews: backlog/reviews/${taskId}/
`;
}

function malformedPointerBody(taskId: string): string {
  return `## current_thesis
Malformed anchor fixture for ${taskId}.

## locked_decisions
- Exercise degraded anchor parsing.

## open_questions
- None.

## dont_touch
- Fixture-only content.

## canonical_anchors
- spec: backlog/ready/${taskId}.md
- bogus_key: unsupported
`;
}

function writeTaskState(
  repoRoot: string,
  taskId: string,
  role: 'strategist' | 'builder' | 'round-state',
  body: string,
): void {
  const dir = join(repoRoot, 'backlog', 'task-state', taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${role}.md`), body);
}

function writeStageItem(repoRoot: string, taskId: string, stage: string): void {
  const dir = join(repoRoot, 'backlog', stage);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${taskId}.md`), `---\nid: ${taskId}\n---\nfixture\n`);
}

export function buildListTaskStatesFixture(
  options: BuildFixtureOptions = {},
): ListTaskStatesFixture {
  const repoRoot = mkdtempSync(join(tmpdir(), 'echo-111-list-task-states-'));
  try {
    git(repoRoot, ['init', '-q', '-b', 'main']);
    git(repoRoot, ['config', 'user.email', 'fixture@echo.local']);
    git(repoRoot, ['config', 'user.name', 'ECHO Fixture']);
    git(repoRoot, ['config', 'commit.gpgsign', 'false']);

    const ready = '2026-07-02-111-fixture-ready';
    writeStageItem(repoRoot, ready, 'ready');
    writeTaskState(repoRoot, ready, 'strategist', pointerBody(ready, 'ready'));
    writeTaskState(repoRoot, ready, 'builder', pointerBody(ready, 'ready'));

    const claimed = '2026-07-02-111-fixture-claimed';
    writeStageItem(repoRoot, claimed, 'claimed');
    writeTaskState(repoRoot, claimed, 'strategist', pointerBody(claimed, 'claimed'));

    const pending = '2026-07-02-111-fixture-pending';
    writeStageItem(repoRoot, pending, 'pending_review');
    writeTaskState(repoRoot, pending, 'round-state', pointerBody(pending, 'pending_review'));

    const complete = '2026-07-02-111-fixture-complete-builder-only';
    writeStageItem(repoRoot, complete, 'complete');
    writeTaskState(repoRoot, complete, 'builder', pointerBody(complete, 'complete'));

    const stageLess = '2026-07-02-111-fixture-stage-less';
    writeTaskState(repoRoot, stageLess, 'strategist', pointerBody(stageLess, 'ready'));

    const malformed = '2026-07-02-111-fixture-malformed-anchors';
    writeStageItem(repoRoot, malformed, 'ready');
    writeTaskState(repoRoot, malformed, 'strategist', malformedPointerBody(malformed));

    for (let i = 0; i < (options.extraCompleteTasks ?? 0); i += 1) {
      const taskId = `2026-07-02-111-fixture-bulk-${String(i).padStart(4, '0')}`;
      writeStageItem(repoRoot, taskId, 'complete');
      writeTaskState(
        repoRoot,
        taskId,
        'builder',
        pointerBody(taskId, 'complete', options.bodyPaddingBytes ?? 0),
      );
    }

    git(repoRoot, ['add', '-A']);
    git(repoRoot, ['commit', '-q', '-m', 'seed list_task_states fixture'], GIT_ENV);
    const ref = git(repoRoot, ['rev-parse', 'HEAD']).trim();
    return {
      repoRoot,
      ref,
      // Antivirus/indexing and Git's final file-handle release can briefly race
      // recursive removal on hosted runners. Node's bounded retry is only used
      // for ENOTEMPTY/EBUSY/EPERM and still surfaces a durable cleanup failure.
      cleanup: () =>
        rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
    };
  } catch (err) {
    rmSync(repoRoot, { recursive: true, force: true });
    throw err;
  }
}
