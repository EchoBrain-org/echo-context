import type { CaptureEvent } from '../../../src/storage/interface.js';

export const claudeCodeFixture: CaptureEvent = {
  id: 'evt_cc_0001',
  source:
    'fs:/Users/dev/.claude/projects/-Users-dev-Desktop-demo-repo/4e273691-aaaa-bbbb-cccc-ddddeeeeffff.jsonl',
  timestamp: '2026-05-07T06:03:42.830Z',
  content:
    'USER: how many items are in the demo backlog?\n\nASSISTANT: There are 16 total items in the demo backlog.',
  metadata: {
    project: '-Users-dev-Desktop-demo-repo',
    session_id: '4e273691-aaaa-bbbb-cccc-ddddeeeeffff',
    turn_index: 9,
    mtime: 1778133823137,
    byte_offset: 848272,
    had_tool_use: true,
    repo_root: '/Users/dev/Desktop/demo-repo',
    files_referenced: [
      '/Users/dev/Desktop/demo-repo/src/index.ts',
      '/tmp/scratchpad.md',
    ],
    tool_calls: [
      {
        name: 'Bash',
        call_id: 'toolu_xyz1',
        args: '{"command":"ls"}',
        output: 'src\nREADME.md',
      },
    ],
    tool_call_total: 1,
    permission_mode: 'auto',
    cli_version: '2.1.119',
    model: 'claude-opus-4-7',
    git_state: {
      head_sha: '3aba18ae4163490fb3fdeba9fed60f35c0afd1f5',
      captured_at: '2026-05-07T06:03:43.931Z',
      branch: 'main',
      dirty_count: 0,
      fresh: true,
    },
    branch: 'main',
  },
};
