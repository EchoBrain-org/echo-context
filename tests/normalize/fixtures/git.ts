import type { CaptureEvent } from '../../../src/storage/interface.js';

export const gitFixture: CaptureEvent = {
  id: 'evt_git_0001',
  source: 'git:/Users/dev/Desktop/demo-repo',
  timestamp: '2026-05-06T23:00:12-07:00',
  content:
    'COMMIT 3aba18a: refactor: extract reader helper\n\nMove reader logic into its own module so the test suite can target it directly.\n\n--- DIFF ---\ndiff --git a/src/reader.ts b/src/reader.ts\n+++ b/src/reader.ts\n@@\n+export function read(path: string) { return path; }\ndiff --git a/src/index.ts b/src/index.ts\n@@\n-export { foo } from "./foo.js";\n+export { read } from "./reader.js";',
  metadata: {
    sha: '3aba18ae4163490fb3fdeba9fed60f35c0afd1f5',
    author: 'Dev',
    files_changed: 2,
    additions: 4,
    deletions: 1,
    repo_root: '/Users/dev/Desktop/demo-repo',
    parent_sha: '92d3b7e41dde9a28e34df241c1ace7614c906df7',
    files_referenced: [
      '/Users/dev/Desktop/demo-repo/src/reader.ts',
      '/Users/dev/Desktop/demo-repo/src/index.ts',
    ],
    branch: 'main',
  },
};
