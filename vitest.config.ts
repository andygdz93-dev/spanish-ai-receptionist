import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // All tests run offline. The LiveKit dependency is mocked in agent.test.ts.
  },
});
