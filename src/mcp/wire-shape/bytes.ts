/** UTF-8 byte size of the exact JSON payload emitted on the wire. */
export function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}
