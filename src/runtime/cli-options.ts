export function assertOptions(
  args: readonly string[],
  valueOptions: readonly string[],
  flagOptions: readonly string[] = [],
): void {
  const values = new Set(valueOptions);
  const flags = new Set(flagOptions);
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!values.has(token) && !flags.has(token)) {
      throw new Error(`unknown option: ${token}`);
    }
    if (seen.has(token)) throw new Error(`duplicate option: ${token}`);
    seen.add(token);
    if (values.has(token)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${token} requires a value`);
      }
      index += 1;
    }
  }
}
