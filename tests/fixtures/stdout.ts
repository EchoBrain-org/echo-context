type WriteFn = typeof process.stdout.write;

export function captureStdout(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const original: WriteFn = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    writes.push(text);
    return true;
  }) as WriteFn;
  return {
    writes,
    restore: () => {
      process.stdout.write = original;
    },
  };
}
