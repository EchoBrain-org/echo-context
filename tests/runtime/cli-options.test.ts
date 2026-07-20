import { describe, expect, it } from 'vitest';
import { assertOptions } from '../../src/runtime/cli-options.js';

describe('destructive CLI option validation', () => {
  it('rejects unknown and misspelled options', () => {
    expect(() => assertOptions(['--lable', 'foo'], ['--label'])).toThrow(
      /unknown option: --lable/,
    );
  });

  it('rejects duplicate options and missing values', () => {
    expect(() => assertOptions(['--label', 'a', '--label', 'b'], ['--label'])).toThrow(
      /duplicate/,
    );
    expect(() => assertOptions(['--label'], ['--label'])).toThrow(/requires a value/);
  });

  it('accepts only explicitly listed value and boolean flags', () => {
    expect(() =>
      assertOptions(['--label', 'com.echo.context', '--replace'], ['--label'], ['--replace']),
    ).not.toThrow();
  });
});
