// Unit and integration tests for the worker. CI never calls Claude: the integration tests point the SDK at
// the mock server (packages/ai/src/mock). The DB-backed tests use TEST_DATABASE_URL (default: the
// studify_test_worker database created by supabase/tests/run.sh) and are skipped when it is unreachable.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
