// SPDX-License-Identifier: GPL-2.0-or-later
// Vitest config for the Analyze post export golden (record-analytics-
// export.test.ts): the Hub fixture harness of ../vitest.config.ts, with
// the real better-sqlite3 the app ships. That module is built for
// Electron's ABI, so this config runs under Electron acting as Node (see
// the `generate:hub-fixtures` script). The local days the cache groups by
// are UTC's whatever zone the generator is started in.
//
// Run: pnpm run generate:hub-fixtures

import { fixtureConfig } from '../../fixture-vitest-config'

export default fixtureConfig(
  'hub-fixtures/analytics-export',
  {
    setupFiles: ['scripts/sync-fixtures/setup.ts', 'scripts/hub-fixtures/setup.ts'],
    env: { TZ: 'UTC' },
  },
  'scripts/sync-fixtures/electron-harness.ts',
)
