// SPDX-License-Identifier: GPL-2.0-or-later
// Vitest config for verify-rust-analytics.test.ts on Node, where the
// Electron-ABI better-sqlite3 cannot load: better-sqlite3 goes to the sql.js
// adapter the root config uses. TZ is UTC, the zone the crate's test writes
// the tree in.
//
// Run: pnpm run verify:analytics-rust-user-data

import { resolve } from 'node:path'
import { mergeConfig } from 'vitest/config'
import { REPO_ROOT, fixtureConfig } from '../fixture-vitest-config'

export default mergeConfig(
  fixtureConfig('analytics-db-fixtures', {
    include: ['scripts/analytics-db-fixtures/verify-rust-analytics.test.ts'],
    setupFiles: ['src/main/__tests__/setup-sqlite-mock.ts'],
    env: { TZ: 'UTC' },
  }),
  {
    resolve: {
      alias: { 'better-sqlite3': resolve(REPO_ROOT, 'src/main/__tests__/better-sqlite3-adapter.ts') },
    },
  },
)
