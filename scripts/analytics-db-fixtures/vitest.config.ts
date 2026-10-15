// SPDX-License-Identifier: GPL-2.0-or-later
// Vitest config for the typing-analytics DB fixtures shared with the Rust
// crate src-tauri/crates/pipette-typing-analytics-db. Kept separate from the
// root config so `pnpm test` never rewrites the fixtures.
//
// Unlike the root config, `better-sqlite3` is NOT routed to the sql.js
// adapter: the fixtures must come from the real native module the app ships.
// That module is built for Electron's ABI, so this config runs under Electron
// acting as Node (see the `generate:analytics-db-fixtures` script).
//
// Run: pnpm run generate:analytics-db-fixtures

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
    include: ['scripts/analytics-db-fixtures/**/*.test.ts'],
    retry: 0,
    testTimeout: 600_000,
    // The seed lays sessions on local wall-clock hours; UTC keeps the
    // generated JSONL the same on every machine.
    env: { TZ: 'UTC' },
  },
})
