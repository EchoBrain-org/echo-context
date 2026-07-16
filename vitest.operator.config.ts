import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/operator/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    pool: 'forks',
    fileParallelism: false,
  },
});
