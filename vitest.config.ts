// SPDX-License-Identifier: GPL-2.0-or-later

import os from 'node:os'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Leave 2 cores free so high-parallelism workers don't starve fake-timer-based
// polling tests (race-prone under saturated CPU).
const TEST_MAX_THREADS = Math.max(1, os.cpus().length - 2)

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify('0.1.0'),
  },
  test: {
    // Default: node environment for preload/shared tests
    // Component tests use // @vitest-environment jsdom directive
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
    setupFiles: ['src/renderer/__tests__/setup.ts'],
    // Retry timer/concurrency-sensitive tests up to 3 times before failing the suite.
    retry: 3,
    poolOptions: {
      threads: {
        maxThreads: TEST_MAX_THREADS,
        minThreads: 1,
      },
    },
  },
})
