import { createHash } from 'node:crypto';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function compareKeys(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function normalize(value, seen) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON rejects non-finite numbers');
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('canonical JSON rejects cyclic values');
    seen.add(value);
    const result = value.map((entry) => {
      if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol') {
        throw new TypeError('canonical JSON rejects non-JSON array entries');
      }
      return normalize(entry, seen);
    });
    seen.delete(value);
    return result;
  }
  if (typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError('canonical JSON accepts plain objects only');
    }
    if (seen.has(value)) throw new TypeError('canonical JSON rejects cyclic values');
    seen.add(value);
    const result = {};
    for (const key of Object.keys(value).sort(compareKeys)) {
      const entry = value[key];
      if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol') {
        throw new TypeError(`canonical JSON rejects non-JSON value at key ${JSON.stringify(key)}`);
      }
      result[key] = normalize(entry, seen);
    }
    seen.delete(value);
    return result;
  }
  throw new TypeError(`canonical JSON rejects ${typeof value}`);
}

export function canonicalJsonText(value) {
  return `${JSON.stringify(normalize(value, new Set()))}\n`;
}

export function canonicalJsonBytes(value) {
  return Buffer.from(encoder.encode(canonicalJsonText(value)));
}

export function parseCanonicalJsonBytes(bytes, label = 'JSON') {
  const input = Buffer.from(bytes);
  let text;
  try {
    text = decoder.decode(input);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8: ${error.message}`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  const expected = canonicalJsonBytes(value);
  if (!input.equals(expected)) {
    throw new Error(`${label} is not canonical JSON (sorted keys, compact UTF-8, one trailing LF required)`);
  }
  return value;
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
