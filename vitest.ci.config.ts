import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/operator/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
