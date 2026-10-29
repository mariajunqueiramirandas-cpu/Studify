// The database-backed tests each create and migrate a scratch database (test/support/scratch.ts). Roles are shared
// by the whole cluster, so the files run one after another.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
