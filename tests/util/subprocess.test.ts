import { describe, expect, it } from 'vitest';
import { resolveCommand } from '../../src/util/subprocess.js';

describe('resolveCommand', () => {
  it('finds a Windows .cmd shim through injected PATH and PATHEXT', () => {
    const seen: string[] = [];
    const found = 'C:\\Tools\\codex.CMD';
    const result = resolveCommand('codex', {
      platform: 'win32',
      env: {
        PATH: 'C:\\Tools;D:\\Other',
        PATHEXT: '.EXE;.CMD',
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      },
      existsSync: (path) => {
        seen.push(path);
        return path === found;
      },
    });

    expect(seen).toEqual([
      'C:\\Tools\\codex',
      'C:\\Tools\\codex.EXE',
      'C:\\Tools\\codex.CMD',
    ]);
    expect(result).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      prependArgs: ['/d', '/s', '/c', found],
    });
  });

  it('returns a Windows .exe directly', () => {
    const result = resolveCommand('claude', {
      platform: 'win32',
      env: { PATH: 'C:\\Tools', PATHEXT: '.EXE;.CMD' },
      existsSync: (path) => path === 'C:\\Tools\\claude.EXE',
    });
    expect(result).toEqual({ command: 'C:\\Tools\\claude.EXE' });
  });

  it('leaves POSIX commands unchanged without consulting host PATH', () => {
    const result = resolveCommand('claude', {
      platform: 'darwin',
      env: { PATH: '/usr/bin' },
      existsSync: () => {
        throw new Error('should not inspect POSIX PATH');
      },
    });
    expect(result).toEqual({ command: 'claude' });
  });
});
