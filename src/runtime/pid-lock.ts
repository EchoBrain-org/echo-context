import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface PidLock {
  path: string;
  release: () => void;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readPid(path: string): number | null {
  try {
    const value = Number(readFileSync(path, 'utf8').trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Acquire a single-process daemon lock without inheriting stale PID files. */
export function acquirePidLock(path: string): PidLock {
  mkdirSync(dirname(path), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number | undefined;
    try {
      fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, `${process.pid}\n`, 'utf8');
      closeSync(fd);
      fd = undefined;

      let released = false;
      return {
        path,
        release: () => {
          if (released) return;
          released = true;
          if (readPid(path) === process.pid) {
            try {
              unlinkSync(path);
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
            }
          }
        },
      };
    } catch (err) {
      if (fd !== undefined) closeSync(fd);
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      const owner = readPid(path);
      if (owner !== null && isProcessAlive(owner)) {
        throw new Error(`echo-context daemon is already running (pid ${owner})`);
      }
      try {
        unlinkSync(path);
      } catch (unlinkErr) {
        if ((unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkErr;
      }
    }
  }

  throw new Error(`could not acquire daemon PID lock at ${path}`);
}
