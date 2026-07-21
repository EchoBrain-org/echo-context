import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveContextRuntimeConfig } from '../../src/runtime/config.js';
import {
  AuthorityTransactionError,
  REQUIRED_AUTHORITY_SAMPLES,
  advanceAuthorityAcceptanceWindow,
  bootstrapAndKickstartLaunchdAgent,
  executeAuthorityRollback,
  executeAuthorityRecovery,
  executeAuthorityTransfer,
  executeConfirmedStop,
  acquireAuthorityOperationLock,
  preparingRecoveryAuthorityAccepted,
  renderLaunchdPlist,
} from '../../src/runtime/launchd.js';

describe('launchd package boundary', () => {
  const testCliPath = fileURLToPath(import.meta.url);

  it('requires consecutive acceptance and resets after a flapping sample', () => {
    let consecutive = 0;
    const observed: number[] = [];
    for (const accepted of [true, false, true, true, true]) {
      consecutive = advanceAuthorityAcceptanceWindow(consecutive, accepted);
      observed.push(consecutive);
    }
    expect(observed).toEqual([1, 0, 1, 2, REQUIRED_AUTHORITY_SAMPLES]);
  });

  it('bootstraps then explicitly kickstarts a dormant launchd job without killing it', () => {
    const calls: string[][] = [];
    bootstrapAndKickstartLaunchdAgent(
      'com.echo.context.candidate',
      '/tmp/context.plist',
      (args) => calls.push(args),
    );
    const domain = `gui/${process.getuid?.()}`;
    expect(calls).toEqual([
      ['bootstrap', domain, '/tmp/context.plist'],
      ['kickstart', `${domain}/com.echo.context.candidate`],
    ]);
    expect(calls.flat()).not.toContain('-k');
  });

  it('does not kickstart after bootstrap fails and propagates kickstart failure', () => {
    const bootstrapCalls: string[][] = [];
    expect(() =>
      bootstrapAndKickstartLaunchdAgent(
        'com.echo.context.candidate',
        '/tmp/context.plist',
        (args) => {
          bootstrapCalls.push(args);
          throw new Error('bootstrap rejected');
        },
      ),
    ).toThrow('bootstrap rejected');
    expect(bootstrapCalls).toHaveLength(1);

    const kickstartCalls: string[][] = [];
    expect(() =>
      bootstrapAndKickstartLaunchdAgent(
        'com.echo.context.candidate',
        '/tmp/context.plist',
        (args) => {
          kickstartCalls.push(args);
          if (args[0] === 'kickstart') throw new Error('kickstart rejected');
        },
      ),
    ).toThrow('kickstart rejected');
    expect(kickstartCalls.map((args) => args[0])).toEqual([
      'bootstrap',
      'kickstart',
    ]);
  });

  it('renders a lean plist with no Project_echo or product secrets', () => {
    const config = resolveContextRuntimeConfig({
      ECHO_CONTEXT_HOME: '/tmp/context-home',
      ECHO_CONTEXT_DB_PATH: '/tmp/context-home/context.db',
    });
    const plist = renderLaunchdPlist(
      'com.echo.context.candidate',
      testCliPath,
      config,
    );
    expect(plist).toContain('com.echo.context.candidate');
    expect(plist).toContain(realpathSync(testCliPath));
    expect(plist).toContain('ECHO_CONTEXT_DB_PATH');
    expect(plist).not.toMatch(/Project_echo|SLACK|ANTHROPIC|OPENAI_API_KEY|coord|backlog/i);
    expect(plist).toContain('<string>/dev/null</string>');
    expect(plist).not.toMatch(/daemon(?:\.error)?\.log/);
  });

  it('renders the per-install acceptance identity into the daemon environment', () => {
    const base = resolveContextRuntimeConfig({
      ECHO_CONTEXT_HOME: '/tmp/context-home',
      ECHO_CONTEXT_DB_PATH: '/tmp/context-home/context.db',
    });
    const config = {
      ...base,
      identity: {
        instanceNonce: 'nonce-123',
        artifactDigest: 'a'.repeat(64),
        promotionReceiptDigest: 'c'.repeat(64),
        databaseDigest: 'b'.repeat(64),
      },
    };
    const plist = renderLaunchdPlist(
      'com.echo.context',
      testCliPath,
      config,
    );
    expect(plist).toContain('nonce-123');
    expect(plist).toContain('a'.repeat(64));
    expect(plist).toContain('c'.repeat(64));
    expect(plist).toContain('b'.repeat(64));
  });
});

describe('launchd authority transactions', () => {
  it('accepts an absent preparing candidate while healthy legacy solely owns the port', () => {
    expect(
      preparingRecoveryAuthorityAccepted({
        nextLoaded: false,
        nextRunning: false,
        nextPid: null,
        legacyRunning: true,
        legacyPid: 410,
        listenerOwnerPids: new Set([410]),
        endpointHealthy: true,
        endpointReachable: true,
      }),
    ).toBe(true);
  });

  it('rejects preparing recovery when next exists or the port owner is not legacy', () => {
    const acceptedLegacy = {
      nextLoaded: false,
      nextRunning: false,
      nextPid: null,
      legacyRunning: true,
      legacyPid: 410,
      listenerOwnerPids: new Set([410]),
      endpointHealthy: true,
      endpointReachable: true,
    };
    expect(
      preparingRecoveryAuthorityAccepted({
        ...acceptedLegacy,
        nextLoaded: true,
        nextRunning: true,
        nextPid: 411,
      }),
    ).toBe(false);
    expect(
      preparingRecoveryAuthorityAccepted({
        ...acceptedLegacy,
        listenerOwnerPids: new Set([999]),
      }),
    ).toBe(false);
  });

  it('recovers a preparing receipt without stopping an already accepted legacy owner', async () => {
    const calls: string[] = [];
    await executeAuthorityRecovery({
      stopNext: () => {
        calls.push('prove-next-absent-with-legacy-owner');
        if (
          !preparingRecoveryAuthorityAccepted({
            nextLoaded: false,
            nextRunning: false,
            nextPid: null,
            legacyRunning: true,
            legacyPid: 410,
            listenerOwnerPids: new Set([410]),
            endpointHealthy: true,
            endpointReachable: true,
          })
        ) {
          throw new Error('preparing authority was not accepted');
        }
      },
      restoreLegacy: () => {
        calls.push('legacy-already-running');
      },
      verifyLegacy: () => {
        calls.push('verify-legacy');
      },
      stopLegacy: () => {
        calls.push('stop-legacy');
      },
    });
    expect(calls).toEqual([
      'prove-next-absent-with-legacy-owner',
      'legacy-already-running',
      'verify-legacy',
    ]);
  });

  it('does not read parity or watermarks until a delayed stop proof completes', async () => {
    const calls: string[] = [];
    let confirmStopped: (() => void) | undefined;
    const stopped = new Promise<void>((resolve) => {
      confirmStopped = resolve;
    });
    const operation = executeConfirmedStop({
      requestStop: () => {
        calls.push('request-stop');
      },
      verifyStopped: async () => {
        calls.push('begin-stop-proof');
        await stopped;
        calls.push('stop-proven');
      },
      afterStopped: () => {
        calls.push('read-final-watermark');
        return 'snapshot';
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(calls).toEqual(['request-stop', 'begin-stop-proof']);
    calls.push('late-final-write');
    confirmStopped?.();
    await expect(operation).resolves.toBe('snapshot');
    expect(calls).toEqual([
      'request-stop',
      'begin-stop-proof',
      'late-final-write',
      'stop-proven',
      'read-final-watermark',
    ]);
  });

  it('never runs post-stop parity when socket release cannot be proven', async () => {
    const calls: string[] = [];
    await expect(
      executeConfirmedStop({
        requestStop: () => {
          calls.push('request-stop');
        },
        verifyStopped: () => {
          calls.push('verify-stop');
          throw new Error('socket still owned');
        },
        afterStopped: () => {
          calls.push('read-parity');
        },
      }),
    ).rejects.toThrow('socket still owned');
    expect(calls).toEqual(['request-stop', 'verify-stop']);
  });

  it('serializes authority operations independently of candidate home', () => {
    const root = mkdtempSync(join(tmpdir(), 'echo-context-authority-lock-'));
    const first = acquireAuthorityOperationLock(root);
    try {
      expect(() => acquireAuthorityOperationLock(root)).toThrow(/already running/);
    } finally {
      first.release();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('restores and verifies only legacy when candidate start fails', async () => {
    const calls: string[] = [];
    const operation = executeAuthorityTransfer({
      stopLegacy: () => {
        calls.push('stop-legacy');
      },
      startNext: () => {
        calls.push('start-next');
        throw new Error('candidate rejected');
      },
      stopNext: () => {
        calls.push('stop-next');
      },
      restoreLegacy: () => {
        calls.push('start-legacy');
      },
      verifyLegacy: () => {
        calls.push('verify-legacy');
      },
    });
    await expect(operation).rejects.toMatchObject({
      acceptedAuthority: 'legacy',
      operation: 'cutover',
      failedPhase: 'start_next',
    });
    await expect(operation).rejects.toThrow('candidate rejected');
    expect(calls).toEqual([
      'stop-legacy',
      'start-next',
      'stop-next',
      'start-legacy',
      'verify-legacy',
    ]);
  });

  it('does not start legacy if candidate stop cannot be confirmed', async () => {
    const calls: string[] = [];
    const operation = executeAuthorityTransfer({
      stopLegacy: () => {
        calls.push('stop-legacy');
      },
      startNext: () => {
        calls.push('start-next');
        throw new Error('candidate rejected');
      },
      stopNext: () => {
        calls.push('stop-next');
        throw new Error('ambiguous stop');
      },
      restoreLegacy: () => {
        calls.push('start-legacy');
      },
      verifyLegacy: () => {
        calls.push('verify-legacy');
      },
    });
    await expect(operation).rejects.toMatchObject({
      acceptedAuthority: 'ambiguous',
      failedPhase: 'stop_rejected_next',
    });
    await expect(operation).rejects.toThrow(/legacy state was not restored/);
    expect(calls).not.toContain('start-legacy');
  });

  it('restores the exact next authority when explicit legacy rollback fails', async () => {
    const calls: string[] = [];
    const operation = executeAuthorityRollback({
      stopNext: () => {
        calls.push('stop-next');
      },
      startLegacy: () => {
        calls.push('start-legacy');
      },
      verifyLegacy: () => {
        calls.push('verify-legacy');
        throw new Error('legacy unhealthy');
      },
      stopLegacy: () => {
        calls.push('stop-legacy');
      },
      startNext: () => {
        calls.push('start-next');
      },
      verifyNext: () => {
        calls.push('verify-next');
      },
    });
    await expect(operation).rejects.toMatchObject({
      acceptedAuthority: 'next',
      operation: 'rollback',
      failedPhase: 'accept_legacy',
    });
    await expect(operation).rejects.toThrow(/rollback aborted and next authority was restored/);
    expect(calls).toEqual([
      'stop-next',
      'start-legacy',
      'verify-legacy',
      'stop-legacy',
      'start-next',
      'verify-next',
    ]);
  });

  it('rollback snapshots stopped next before starting legacy', async () => {
    const calls: string[] = [];
    await executeAuthorityRollback({
      stopNext: async () => {
        await executeConfirmedStop({
          requestStop: () => {
            calls.push('request-stop-next');
          },
          verifyStopped: () => {
            calls.push('prove-next-stopped-unowned');
          },
          afterStopped: () => {
            calls.push('snapshot-next');
          },
        });
      },
      startLegacy: () => {
        calls.push('start-legacy');
      },
      verifyLegacy: () => {
        calls.push('verify-legacy');
      },
      stopLegacy: () => {
        calls.push('stop-legacy');
      },
      startNext: () => {
        calls.push('start-next');
      },
      verifyNext: () => {
        calls.push('verify-next');
      },
    });
    expect(calls).toEqual([
      'request-stop-next',
      'prove-next-stopped-unowned',
      'snapshot-next',
      'start-legacy',
      'verify-legacy',
    ]);
  });

  it('marks a failed legacy stop terminal only after legacy is re-accepted', async () => {
    const calls: string[] = [];
    const operation = executeAuthorityTransfer({
      stopLegacy: () => {
        calls.push('stop-legacy');
        throw new Error('bootout uncertain');
      },
      startNext: () => {
        calls.push('start-next');
      },
      stopNext: () => {
        calls.push('stop-next');
      },
      restoreLegacy: () => {
        calls.push('start-legacy');
      },
      verifyLegacy: () => {
        calls.push('verify-legacy');
      },
    });
    await expect(operation).rejects.toBeInstanceOf(AuthorityTransactionError);
    await expect(operation).rejects.toMatchObject({ acceptedAuthority: 'legacy' });
    expect(calls).toEqual(['stop-legacy', 'start-legacy', 'verify-legacy']);
  });

  it('recovery confirms candidate stop before it starts legacy', async () => {
    const calls: string[] = [];
    await executeAuthorityRecovery({
      stopNext: () => {
        calls.push('stop-next');
      },
      restoreLegacy: () => {
        calls.push('start-legacy');
      },
      verifyLegacy: () => {
        calls.push('verify-legacy');
      },
      stopLegacy: () => {
        calls.push('stop-legacy');
      },
    });
    expect(calls).toEqual(['stop-next', 'start-legacy', 'verify-legacy']);
  });

  it('recovery never starts legacy when candidate stop is ambiguous', async () => {
    const calls: string[] = [];
    const operation = executeAuthorityRecovery({
      stopNext: () => {
        calls.push('stop-next');
        throw new Error('cannot confirm');
      },
      restoreLegacy: () => {
        calls.push('start-legacy');
      },
      verifyLegacy: () => {
        calls.push('verify-legacy');
      },
      stopLegacy: () => {
        calls.push('stop-legacy');
      },
    });
    await expect(operation).rejects.toMatchObject({
      acceptedAuthority: 'ambiguous',
      operation: 'recover',
      failedPhase: 'stop_next',
    });
    expect(calls).toEqual(['stop-next']);
  });

  it('candidate failure restores a previously stopped legacy state without bootstrapping it', async () => {
    const calls: string[] = [];
    const operation = executeAuthorityTransfer({
      stopLegacy: () => {
        calls.push('confirm-legacy-stopped');
      },
      startNext: () => {
        calls.push('start-next');
        throw new Error('candidate failed');
      },
      stopNext: () => {
        calls.push('stop-next');
      },
      restoreLegacy: () => {
        calls.push('keep-legacy-stopped');
      },
      verifyLegacy: () => {
        calls.push('verify-stopped-unowned');
      },
    });
    await expect(operation).rejects.toMatchObject({ acceptedAuthority: 'legacy' });
    expect(calls).toEqual([
      'confirm-legacy-stopped',
      'start-next',
      'stop-next',
      'keep-legacy-stopped',
      'verify-stopped-unowned',
    ]);
    expect(calls).not.toContain('start-legacy');
  });

  it('recovery can converge on a previously stopped and unowned legacy state', async () => {
    const calls: string[] = [];
    await executeAuthorityRecovery({
      stopNext: () => {
        calls.push('stop-next');
      },
      restoreLegacy: () => {
        calls.push('keep-legacy-stopped');
      },
      verifyLegacy: () => {
        calls.push('verify-stopped-unowned');
      },
      stopLegacy: () => {
        calls.push('stop-legacy');
      },
    });
    expect(calls).toEqual([
      'stop-next',
      'keep-legacy-stopped',
      'verify-stopped-unowned',
    ]);
    expect(calls).not.toContain('start-legacy');
  });

  it('rollback recovery recomputes the next watermark only after confirmed stop', async () => {
    const calls: string[] = [];
    await executeAuthorityRecovery({
      stopNext: async () => {
        await executeConfirmedStop({
          requestStop: () => {
            calls.push('request-stop-next');
          },
          verifyStopped: () => {
            calls.push('prove-next-stopped-unowned');
          },
          afterStopped: () => {
            calls.push('recompute-next-watermark');
          },
        });
      },
      restoreLegacy: () => {
        calls.push('restore-legacy');
      },
      verifyLegacy: () => {
        calls.push('verify-legacy');
      },
      stopLegacy: () => {
        calls.push('stop-legacy');
      },
    });
    expect(calls).toEqual([
      'request-stop-next',
      'prove-next-stopped-unowned',
      'recompute-next-watermark',
      'restore-legacy',
      'verify-legacy',
    ]);
  });
});
