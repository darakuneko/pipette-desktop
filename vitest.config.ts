// SPDX-License-Identifier: GPL-2.0-or-later

import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    // Default: node environment for preload/shared tests
    // Component tests use // @vitest-environment jsdom directive
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
    setupFiles: ['src/renderer/__tests__/setup.ts'],
  },
})
