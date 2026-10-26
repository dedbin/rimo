import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    maxWorkers: 4,
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
  resolve: { tsconfigPaths: true },
  oxc: { jsx: { runtime: 'automatic' } },
});
