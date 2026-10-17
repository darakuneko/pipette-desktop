// SPDX-License-Identifier: GPL-2.0-or-later
// Vitest config for the Hub peer comparison of the uploads and the startup
// update (uploads.test.ts), in the Hub fixture harness: the sync fixture
// harness (../sync-fixtures/setup.ts), then the Hub one
// (../hub-fixtures/setup.ts). The Analyze export comparison needs the real
// better-sqlite3 and runs under Electron with analytics.config.ts.
//
// Run: pnpm run test:hub-peer

import { fixtureConfig } from '../fixture-vitest-config'

export default fixtureConfig(
  'hub-peer',
  {
    setupFiles: ['scripts/sync-fixtures/setup.ts', 'scripts/hub-fixtures/setup.ts'],
    exclude: ['scripts/hub-peer/analytics.test.ts'],
    env: { TZ: 'UTC' },
    testTimeout: 900_000,
  },
  'scripts/sync-fixtures/electron-harness.ts',
)
