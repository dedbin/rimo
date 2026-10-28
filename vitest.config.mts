import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    // Better Auth introspects all PostgreSQL schemas; a concurrent test's DROP
    // SCHEMA can invalidate that introspection. Keep database suites sequential.
    maxWorkers: process.env.RIMO_TEST_DATABASE_URL ? 1 : 4,
    exclude: [...configDefaults.exclude, 'e2e/**', 'temp/**', 'dist/**', '.next/**'],
  },
  resolve: { tsconfigPaths: true },
  oxc: { jsx: { runtime: 'automatic' } },
});
