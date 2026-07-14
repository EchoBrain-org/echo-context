import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseJson, readJsonFile } from '../../src/util/json.js';

describe('BOM-tolerant JSON helper', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'echo-json-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses input with one leading UTF-8 BOM', () => {
    expect(parseJson('\ufeff{"ok":true}')).toEqual({ ok: true });
  });

  it('leaves non-BOM JSON unchanged', () => {
    expect(parseJson('{"ok":true}')).toEqual({ ok: true });
  });

  it('throws the normal SyntaxError for malformed JSON', () => {
    expect(() => parseJson('\ufeff{"ok":')).toThrow(SyntaxError);
  });

  it('reads BOM-prefixed JSON files', () => {
    const file = join(dir, 'answers.json');
    writeFileSync(file, '\ufeff{"confirm_setup":true}', 'utf8');
    expect(readJsonFile(file)).toEqual({ confirm_setup: true });
  });
});
