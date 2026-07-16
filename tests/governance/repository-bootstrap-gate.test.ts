import { describe, expect, it } from 'vitest';
// @ts-expect-error committed injected model is plain JavaScript.
import { FROZEN_BOOTSTRAP, parseCreatedMainPorcelain, runRepositoryBootstrapGate } from '../../tools/repository-bootstrap-gate.mjs';

type Overrides = Record<string, unknown>;

function repository(overrides: Overrides = {}) {
  return {
    id: FROZEN_BOOTSTRAP.repositoryId,
    node_id: FROZEN_BOOTSTRAP.repositoryNodeId,
    full_name: `${FROZEN_BOOTSTRAP.ownerLogin}/${FROZEN_BOOTSTRAP.repositoryName}`,
    owner: { login: FROZEN_BOOTSTRAP.ownerLogin, id: FROZEN_BOOTSTRAP.ownerId },
    private: true,
    default_branch: 'main',
    ...overrides,
  };
}

function fixture(overrides: Overrides = {}) {
  const calls: string[] = [];
  let mainReads = 0;
  const adapter = {
    getUser: async () => { calls.push('getUser'); return { status: 200, direct: true, body: { login: 'zhenye0616', id: 73834646 } }; },
    getRepositoryByName: async () => { calls.push('getRepositoryByName'); return { status: 404, direct: true }; },
    listOwnedRepositories: async () => { calls.push('listOwnedRepositories'); return { complete: true, pages: [[]] }; },
    createRepository: async (body: unknown) => { calls.push(`createRepository:${JSON.stringify(body)}`); return { status: 201, direct: true, body: repository() }; },
    getRepositoryById: async () => { calls.push('getRepositoryById'); return { status: 200, direct: true, body: repository() }; },
    listBranches: async () => { calls.push('listBranches'); return { complete: true, pages: [[]] }; },
    lsRemote: async () => { calls.push('lsRemote'); return { status: 0, signal: null, stdout: '', stderr: '' }; },
    push: async (argv: string[]) => { calls.push(`push:${JSON.stringify(argv)}`); return { status: 0, signal: null, stdout: 'To https://github.com/zhenye0616/echo-context.git\n*\trefs/heads/main:refs/heads/main\t[new branch]\nDone\n', stderr: '', ambiguous: false }; },
    getMainRef: async () => {
      calls.push('getMainRef');
      mainReads += 1;
      return mainReads === 1
        ? { status: 404, direct: true, oid: null }
        : { status: 200, direct: true, oid: FROZEN_BOOTSTRAP.baseline };
    },
    ...overrides,
  };
  return { adapter, calls };
}

describe('AC1 — frozen repository bootstrap gate model', () => {
  it('accepts exactly one direct create and one create-only leased porcelain push', async () => {
    const { adapter, calls } = fixture();
    await expect(runRepositoryBootstrapGate(adapter)).resolves.toMatchObject({ baseline: FROZEN_BOOTSTRAP.baseline });
    expect(calls.filter((call) => call.startsWith('createRepository:'))).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith('push:'))).toHaveLength(1);
    expect(calls.find((call) => call.startsWith('push:'))).toContain('--force-with-lease=refs/heads/main:');
  });

  it.each([
    ['redirect create', { createRepository: async () => ({ status: 201, direct: false, body: repository() }) }, /direct HTTP 201/],
    ['non-201 create', { createRepository: async () => ({ status: 200, direct: true, body: repository() }) }, /direct HTTP 201/],
    ['wrong owner', { getUser: async () => ({ status: 200, direct: true, body: { login: 'foreign', id: 73834646 } }) }, /identity differs/],
    ['ID drift', { getRepositoryById: async () => ({ status: 200, direct: true, body: repository({ id: 7 }) }) }, /identity or visibility differs/],
    ['incomplete pagination', { listBranches: async () => ({ complete: false, pages: [[]] }) }, /pagination is incomplete/],
    ['foreign branch', { listBranches: async () => ({ complete: true, pages: [[{ name: 'main' }]] }) }, /namespace is not empty/],
    ['foreign ref', { lsRemote: async () => ({ status: 0, signal: null, stdout: `${'1'.repeat(40)}\trefs/heads/main\n`, stderr: '' }) }, /zero refs/],
  ])('rejects %s before any push', async (_name, override, expected) => {
    const { adapter, calls } = fixture(override);
    await expect(runRepositoryBootstrapGate(adapter)).rejects.toThrow(expected as RegExp);
    expect(calls.some((call) => call.startsWith('push:'))).toBe(false);
  });

  it('rejects identical pre-existing main without adoption or cleanup', async () => {
    const { adapter, calls } = fixture({ getMainRef: async () => ({ status: 200, direct: true, oid: FROZEN_BOOTSTRAP.baseline }) });
    await expect(runRepositoryBootstrapGate(adapter)).rejects.toThrow(/pre-existing main/);
    expect(calls.some((call) => call.startsWith('push:'))).toBe(false);
  });

  it.each([
    ['missing porcelain', { status: 0, signal: null, stdout: 'Done\n', stderr: '', ambiguous: false }],
    ['up-to-date', { status: 0, signal: null, stdout: '=\trefs/heads/main:refs/heads/main\t[up to date]\n', stderr: '', ambiguous: false }],
    ['multiple rows', { status: 0, signal: null, stdout: '*\trefs/heads/main:refs/heads/main\t[new branch]\n*\trefs/tags/x:refs/tags/x\t[new tag]\n', stderr: '', ambiguous: false }],
    ['lost response', { status: null, signal: null, stdout: '', stderr: '', ambiguous: true }],
  ])('rejects %s push proof', (_name, result) => {
    expect(() => parseCreatedMainPorcelain(result)).toThrow();
  });

  it('stops after ambiguous push and performs no post-readback/retry', async () => {
    const { adapter, calls } = fixture({ push: async () => ({ status: null, signal: null, stdout: '', stderr: '', ambiguous: true }) });
    await expect(runRepositoryBootstrapGate(adapter)).rejects.toThrow(/ambiguous/);
    expect(calls.filter((call) => call.startsWith('push:'))).toHaveLength(0);
    // The override does not append to calls; main is read exactly once pre-push.
    expect(calls.filter((call) => call === 'getMainRef')).toHaveLength(1);
  });

  it('rejects a failed post-readback without a second write', async () => {
    let mainReads = 0;
    const { adapter, calls } = fixture({
      getMainRef: async () => {
        mainReads += 1;
        return mainReads === 1
          ? { status: 404, direct: true, oid: null }
          : { status: 200, direct: true, oid: 'f'.repeat(40) };
      },
    });
    await expect(runRepositoryBootstrapGate(adapter)).rejects.toThrow(/post-push/);
    expect(calls.filter((call) => call.startsWith('push:'))).toHaveLength(1);
  });
});
