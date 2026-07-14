import type { CaptureEvent } from '../../../src/storage/interface.js';

export const cursorFixture: CaptureEvent = {
  id: 'evt_cursor_0001',
  source:
    'fs:/Users/dev/Library/Application Support/Cursor/User/globalStorage/state.vscdb',
  timestamp: '2026-05-01T08:40:14.313Z',
  content:
    'USER: please add a null check to handleClick in main.tsx\n\nASSISTANT: Done — added the null check and a regression test.',
  metadata: {
    composer_id: '3ce99c8c-aaaa-bbbb-cccc-ddddeeeeffff',
    session_id: '3ce99c8c-aaaa-bbbb-cccc-ddddeeeeffff',
    user_bubble_id: '36fd2364-1111-2222-3333-444455556666',
    assistant_bubble_id: 'e031feac-aaaa-bbbb-cccc-ddddeeeeffff',
    assistant_bubble_ids: ['e031feac-aaaa-bbbb-cccc-ddddeeeeffff'],
    turn_index: 4,
    mtime: 1777673685792,
    workspace_id: 'ws_demo_hash',
    context: {
      attached_files: ['/Users/dev/Desktop/demo-repo/src/main.tsx'],
      referenced_files: [
        {
          path: '/Users/dev/Desktop/demo-repo/src/main.tsx',
          language: 'typescriptreact',
        },
        {
          path: '/Users/dev/Desktop/demo-repo/src/main.test.tsx',
          language: 'typescriptreact',
        },
      ],
      deleted_files: ['/Users/dev/Desktop/demo-repo/src/legacy.tsx'],
    },
  },
};

export const cursorFixtureNoContext: CaptureEvent = {
  id: 'evt_cursor_0002',
  source:
    'fs:/Users/dev/Library/Application Support/Cursor/User/globalStorage/state.vscdb',
  timestamp: '2026-05-01T09:00:00.000Z',
  content:
    'USER: hello, are you working?\n\nASSISTANT: Yes — I am responding through ECHO.',
  metadata: {
    composer_id: '4ce99c8c-aaaa-bbbb-cccc-ddddeeeeffff',
    user_bubble_id: '46fd2364-1111-2222-3333-444455556666',
    assistant_bubble_id: 'f031feac-aaaa-bbbb-cccc-ddddeeeeffff',
    mtime: 1777673999999,
  },
};
