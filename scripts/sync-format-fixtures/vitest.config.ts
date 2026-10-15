// SPDX-License-Identifier: GPL-2.0-or-later
// Vitest config for the Cloud Sync format vectors shared with the Rust crate
// src-tauri/crates/pipette-sync-format. Kept separate from the root config so
// `pnpm test` never rewrites the vectors and never needs the Rust output.
//
// Run:
//   pnpm run generate:sync-format-fixtures   (TypeScript → Rust vectors)
//   pnpm run verify:sync-format-rust-vectors (Rust → TypeScript, after
//                                             `cargo test -p pipette-sync-format`)

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
    include: ['scripts/sync-format-fixtures/**/*.test.ts'],
    retry: 0,
    // PBKDF2 with 600,000 iterations runs for every envelope.
    testTimeout: 120_000,
  },
})
