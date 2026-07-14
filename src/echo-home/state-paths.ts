import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isNonEmptyString } from '../guards.js';

export interface EchoStatePaths {
  root: string;
  state: string;
}

export function resolveEchoStatePaths(
  homeOverride?: string,
  env: NodeJS.ProcessEnv = process.env,
): EchoStatePaths {
  if (homeOverride !== undefined && !isNonEmptyString(homeOverride)) {
    throw new Error('invalid --home: expected path');
  }
  const configured = homeOverride ?? env['ECHO_HOME'];
  const root = isNonEmptyString(configured) ? resolve(configured) : join(homedir(), '.echo');
  return Object.freeze({ root, state: join(root, 'state') });
}

export let ECHO_STATE_PATHS = resolveEchoStatePaths();

export function setEchoStateRoot(homeOverride: string): EchoStatePaths {
  ECHO_STATE_PATHS = resolveEchoStatePaths(homeOverride);
  return ECHO_STATE_PATHS;
}
