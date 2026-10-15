// SPDX-License-Identifier: GPL-2.0-or-later
// Vitest config for the virtual-device fixture generator. Kept separate from
// the root config so `pnpm test` never rewrites the fixtures.
//
// Run: pnpm run generate:virtual-device-fixtures

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')

export default defineConfig({
  root: repoRoot,
  resolve: {
    alias: {
      // Same stub the root config uses: the real `electron` package throws
      // at import time outside an Electron runtime.
      electron: resolve(repoRoot, 'src/main/__tests__/electron-stub.ts'),
    },
  },
  test: {
    include: ['scripts/virtual-device-fixtures/**/*.test.ts'],
    retry: 0,
  },
})
