import type { CaptureEvent } from '../../../src/storage/interface.js';

export const codexFixture: CaptureEvent = {
  id: 'evt_codex_0001',
  source:
    'fs:/Users/dev/.codex/sessions/2026/05/06/rollout-2026-05-06T14-37-05-019dff39-1891-74a1-aaaa-bbbbccccdddd.jsonl',
  timestamp: '2026-05-07T05:42:03.649Z',
  content:
    'USER: refactor the file reader so it streams\n\nASSISTANT: Here is the refactor — I switched the reader to a streaming implementation.\n\nLet me know if you want me to add tests.',
  metadata: {
    session_id: '019dff39-1891-74a1-aaaa-bbbbccccdddd',
    turn_index: 19,
    mtime: 1778132523675,
    byte_offset: 2992658,
    cwd: '/Users/dev/Desktop/demo-repo',
    repo_root: '/Users/dev/Desktop/demo-repo',
    had_tool_use: true,
    git: {
      sha: 'b72be9555594790fc4289cdcfa70a7542851071c',
      branch: 'main',
      origin_url: 'https://github.com/example/demo-repo.git',
    },
    codex: {
      source: 'cli',
      cli_version: '0.128.0',
      model_provider: 'openai',
      model: 'gpt-5.5',
      reasoning_effort: 'xhigh',
      personality: 'pragmatic',
      approval_policy: 'on-request',
      sandbox_policy_type: 'workspace-write',
    },
    files_referenced: [
      '/Users/dev/Desktop/demo-repo/src/reader.ts',
      '/Users/dev/Desktop/demo-repo/src/reader.test.ts',
    ],
    git_state: {
      head_sha: 'dadbc55874a0bab366953e7454966a3257d03dde',
      captured_at: '2026-05-07T05:42:04.583Z',
      branch: 'main',
      dirty_count: 0,
      fresh: true,
    },
  },
};
