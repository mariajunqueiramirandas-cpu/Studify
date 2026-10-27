// Unit and integration tests for the worker. CI never calls Claude: the integration test points the SDK at
// the mock server (packages/ai/src/mock). The DB-backed test needs TEST_DATABASE_URL (see test/ingest/README
// section in the worker README); it is skipped when the database is not reachable.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
