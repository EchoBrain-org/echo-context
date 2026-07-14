import { describe, expect, it } from 'vitest';
import { roleOf } from '../../src/trace/role.js';

describe('roleOf — V1.5 type→role registry', () => {
  it('classifies scope-role types', () => {
    expect(roleOf('repo')).toBe('scope');
    expect(roleOf('workspace')).toBe('scope');
    expect(roleOf('account')).toBe('scope');
    expect(roleOf('org')).toBe('scope');
  });

  it('classifies session-role types', () => {
    expect(roleOf('conversation')).toBe('session');
    expect(roleOf('thread')).toBe('session');
    expect(roleOf('channel')).toBe('session');
  });

  it('classifies work-role types', () => {
    expect(roleOf('file')).toBe('work');
    expect(roleOf('pr')).toBe('work');
    expect(roleOf('issue')).toBe('work');
    expect(roleOf('branch')).toBe('work');
    expect(roleOf('commit')).toBe('work');
    expect(roleOf('doc')).toBe('work');
    expect(roleOf('crm_record')).toBe('work');
    expect(roleOf('task')).toBe('work');
    expect(roleOf('meeting')).toBe('work');
    expect(roleOf('email_thread')).toBe('work');
    expect(roleOf('record')).toBe('work');
  });

  it('returns "unknown" for unrecognized types — generalizability default', () => {
    expect(roleOf('opportunity')).toBe('unknown');
    expect(roleOf('matter')).toBe('unknown');
    expect(roleOf('patient_record')).toBe('unknown');
    expect(roleOf('something_we_have_not_seen')).toBe('unknown');
  });

  it('returns "unknown" for empty string', () => {
    expect(roleOf('')).toBe('unknown');
  });

  it('normalizes case via toLowerCase — registry handles whatever adapters emit', () => {
    expect(roleOf('FILE')).toBe('work');
    expect(roleOf('File')).toBe('work');
    expect(roleOf('Repo')).toBe('scope');
    expect(roleOf('CONVERSATION')).toBe('session');
    expect(roleOf('Email_Thread')).toBe('work');
  });
});
