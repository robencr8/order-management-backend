/// <reference types="vitest" />

export default {
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./src/tests/setup.ts'],
    fileParallelism: false, // Run tests sequentially for proper DB isolation
  },
}
