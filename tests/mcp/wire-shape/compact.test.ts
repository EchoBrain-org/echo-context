import { describe, expect, it } from 'vitest';
import { compactAtom, compactCluster } from '../../../src/mcp/wire-shape/compact.js';
import { projectMatch } from '../../../src/mcp/wire-shape/match.js';
import type { CaptureEvent } from '../../../src/storage/interface.js';

describe('compactCluster', () => {
  it('keeps the compact cluster fields, preserves truncation companions, and filters rank_reason', () => {
    const cluster = compactCluster({
      cluster_id: 'ctx_12345678',
      rank_reason: ['recent_activity', 'has_open_loop', 'dense', 'matches_artifact_hint'],
      atom_ids: ['a1', 'a2'],
      atom_ids_truncated: true,
      atom_ids_total: 12,
      source_breakdown: { codex: 2 },
      time_range: { from: '2026-05-20T10:00:00.000Z', to: '2026-05-20T10:05:00.000Z' },
      label: 'discussion about 11111111-2222-3333-4444-555555555555',
      open_loop_hints: [{ atom_id: 'a1', resolved: false }],
      open_loop_hints_omitted: 5,
    });

    expect(cluster).toEqual({
      cluster_id: 'ctx_12345678',
      atom_ids: ['a1', 'a2'],
      source_breakdown: { codex: 2 },
      time_range: { from: '2026-05-20T10:00:00.000Z', to: '2026-05-20T10:05:00.000Z' },
      label: null,
      open_loop_hints: [{ atom_id: 'a1', resolved: false }],
      open_loop_hints_omitted: 5,
      atom_ids_truncated: true,
      atom_ids_total: 12,
      rank_reason: ['has_open_loop'],
    });
    expect(cluster).not.toHaveProperty('rank');
  });

  it('omits rank_reason when has_open_loop is absent and preserves useful labels', () => {
    const cluster = compactCluster({
      cluster_id: 'ctx_abcdef12',
      rank_reason: ['recent_activity', 'dense'],
      atom_ids: ['a1'],
      source_breakdown: { claude_code: 1 },
      time_range: { from: '2026-05-20T10:00:00.000Z', to: '2026-05-20T10:00:00.000Z' },
      label: 'work on compact projection',
      open_loop_hints: [],
    });
    expect(cluster.label).toBe('work on compact projection');
    expect(cluster.rank_reason).toBeUndefined();
  });
});

describe('compactAtom', () => {
  it('keeps universal metadata and claude_code promoted fields while dropping debug plumbing', () => {
    const atom = compactAtom({
      id: 'evt_cc',
      source: 'fs:/Users/dev/.claude/projects/demo/session.jsonl',
      timestamp: '2026-05-20T10:00:00.000Z',
      content: 'USER: q\n\nASSISTANT: a',
      truncations: ['metadata.tool_calls:projected'],
      metadata: {
        project: 'demo',
        session_id: 'sess_cc',
        repo_root: '/repo',
        tool_call_total: 2,
        had_tool_use: true,
        tool_calls: ['Read', 'Bash'],
        tool_calls_by_name: { Read: 1, Bash: 1 },
        tool_calls_truncated: true,
        files_referenced: ['/repo/a.ts'],
        mtime: 1,
        byte_offset: 2,
        model: 'claude-opus-4-7',
        permission_mode: 'auto',
        cli_version: '2.1.119',
        git_state: { branch: 'main', head_sha: 'abc' },
        branch: 'feature/compact',
      },
    });

    expect(atom).toEqual({
      id: 'evt_cc',
      source: 'fs:/Users/dev/.claude/projects/demo/session.jsonl',
      timestamp: '2026-05-20T10:00:00.000Z',
      content: 'USER: q\n\nASSISTANT: a',
      metadata: {
        session_id: 'sess_cc',
        repo_root: '/repo',
        tool_call_total: 2,
        had_tool_use: true,
        tool_calls_by_name: { Read: 1, Bash: 1 },
        files_referenced: ['/repo/a.ts'],
        model: 'claude-opus-4-7',
        permission_mode: 'auto',
        branch: 'feature/compact',
      },
      truncations: ['metadata.tool_calls:projected'],
    });
  });

  it('keeps cursor continuation, context subsets, and non-duplicated thinking', () => {
    const atom = compactAtom({
      id: 'evt_cursor',
      source: 'fs:/Users/dev/Library/Application Support/Cursor/User/globalStorage/state.vscdb',
      timestamp: '2026-05-20T10:00:00.000Z',
      content: 'USER: q\n\nASSISTANT: final answer',
      truncations: [],
      metadata: {
        composer_id: 'composer',
        session_id: 'composer',
        user_bubble_id: 'user',
        assistant_bubble_id: 'assistant',
        assistant_bubble_ids: ['assistant'],
        bubble_text_sources: ['text'],
        continuation_of_assistant_bubble_id: 'prior',
        is_continuation: true,
        thinking: 'private reasoning',
        context: {
          attached_files: ['/repo/a.ts'],
          referenced_files: [{ path: '/repo/b.ts' }],
          deleted_files: ['/repo/c.ts'],
          ignored: true,
        },
      },
    });

    expect(atom.metadata).toEqual({
      session_id: 'composer',
      is_continuation: true,
      context: {
        attached_files: ['/repo/a.ts'],
        referenced_files: [{ path: '/repo/b.ts' }],
        deleted_files: ['/repo/c.ts'],
      },
      thinking: 'private reasoning',
    });
  });

  it('drops cursor thinking when content already starts with it', () => {
    const atom = compactAtom({
      id: 'evt_cursor',
      source: 'fs:/Users/dev/Library/Application Support/Cursor/User/globalStorage/state.vscdb',
      timestamp: '2026-05-20T10:00:00.000Z',
      content: 'same prefix plus visible answer',
      truncations: [],
      metadata: { thinking: 'same prefix', session_id: 'composer' },
    });
    expect(atom.metadata).toEqual({ session_id: 'composer' });
  });

  it('keeps codex model, reasoning effort, git branch, and shrinks heavy tool metadata below 2KB', () => {
    const event: CaptureEvent = {
      id: 'evt_codex',
      source: 'fs:/Users/dev/.codex/sessions/2026/05/20/rollout.jsonl',
      timestamp: '2026-05-20T10:00:00.000Z',
      content: 'USER: q\n\nASSISTANT: a',
      metadata: {
        session_id: 'sess_codex',
        repo_root: '/repo',
        cwd: '/repo',
        had_tool_use: true,
        tool_call_total: 50,
        files_referenced: ['/repo/a.ts'],
        tool_calls: Array.from({ length: 50 }, () => ({
          name: 'exec_command',
          args: 'x'.repeat(2_000),
          output: 'y'.repeat(2_000),
        })),
        codex: {
          source: 'cli',
          cli_version: '0.128.0',
          model_provider: 'openai',
          model: 'gpt-5.5',
          reasoning_effort: 'xhigh',
          personality: 'pragmatic',
          approval_policy: 'on-request',
          sandbox_policy_type: 'workspace-write',
          permission_profile_type: 'workspace',
          permission_file_system_type: 'workspace-write',
          permission_network: false,
          file_system_sandbox_kind: 'workspace-write',
          sandbox_network_access: false,
          sandbox_exclude_tmpdir_env_var: false,
          sandbox_exclude_slash_tmp: false,
          sandbox_writable_roots: ['/repo', '/private/tmp'],
        },
        git: {
          sha: 'abc123',
          branch: 'agent/compact',
          origin_url: 'https://github.com/example/repo.git',
        },
        git_state: { branch: 'agent/compact', head_sha: 'abc123' },
      },
    };

    const rich = projectMatch(event);
    expect(rich.metadata_bytes_elided).toBeGreaterThan(100_000);
    const atom = compactAtom(rich);

    expect(atom.metadata).toEqual({
      session_id: 'sess_codex',
      repo_root: '/repo',
      tool_call_total: 50,
      had_tool_use: true,
      tool_calls_by_name: { exec_command: 50 },
      files_referenced: ['/repo/a.ts'],
      codex: { model: 'gpt-5.5', reasoning_effort: 'xhigh' },
      git: { branch: 'agent/compact' },
    });
    expect(JSON.stringify(atom.metadata).length).toBeLessThan(2048);
    expect(atom).not.toHaveProperty('metadata_bytes_elided');
    expect(atom).not.toHaveProperty('metadata_keys_projected');
  });

  it('keeps only universal metadata for git atoms', () => {
    const atom = compactAtom({
      id: 'evt_git',
      source: 'git:/repo',
      timestamp: '2026-05-20T10:00:00.000Z',
      content: 'commit body',
      truncations: [],
      metadata: {
        session_id: 'git-session',
        repo_root: '/repo',
        files_referenced: ['/repo/a.ts'],
        sha: 'abc',
        branch: 'main',
        parent_sha: 'def',
      },
    });
    expect(atom.metadata).toEqual({
      session_id: 'git-session',
      repo_root: '/repo',
      files_referenced: ['/repo/a.ts'],
    });
  });
});
