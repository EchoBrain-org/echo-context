import { readFileSync } from 'node:fs';

export function stripLeadingJsonBom(raw: string): string {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

export function parseJson<T = unknown>(raw: string): T {
  return JSON.parse(stripLeadingJsonBom(raw)) as T;
}

export function readJsonFile<T = unknown>(filePath: string): T {
  return parseJson<T>(readFileSync(filePath, 'utf8'));
}
