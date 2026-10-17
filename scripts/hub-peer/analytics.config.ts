// SPDX-License-Identifier: GPL-2.0-or-later
// Vitest config for the Hub peer comparison of the Analyze post export
// (analytics.test.ts): the Hub fixture harness with the real
// better-sqlite3 the app ships, so it runs under Electron acting as Node
// (see the `test:hub-peer` script). Both sides run in UTC.
//
// Run: pnpm run test:hub-peer

import { fixtureConfig } from '../fixture-vitest-config'

export default fixtureConfig(
  'hub-peer',
  {
    include: ['scripts/hub-peer/analytics.test.ts'],
    setupFiles: ['scripts/sync-fixtures/setup.ts', 'scripts/hub-fixtures/setup.ts'],
    env: { TZ: 'UTC' },
    testTimeout: 1_800_000,
  },
  'scripts/sync-fixtures/electron-harness.ts',
)
