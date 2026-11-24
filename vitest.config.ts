import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // All tests run offline. The LiveKit dependency is mocked in agent.test.ts.
    // Concurrent Windows workers contend with the child-process startup tests
    // while loading the large Google API dependency tree. Keep their budgets intact.
    ...(process.platform === 'win32' ? { fileParallelism: false } : {}),
  },
});
