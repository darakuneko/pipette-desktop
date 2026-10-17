// SPDX-License-Identifier: GPL-2.0-or-later
// Vitest config for the Hub fixture generators and the tests of their
// harness (hub-harness.ts). The sync fixture harness
// (../sync-fixtures/setup.ts) is installed first, then the Hub one
// (setup.ts).
//
// Run: pnpm run generate:hub-fixtures / pnpm run test:hub-fixtures-harness

import { fixtureConfig } from '../fixture-vitest-config'

export default fixtureConfig(
  'hub-fixtures',
  { setupFiles: ['scripts/sync-fixtures/setup.ts', 'scripts/hub-fixtures/setup.ts'] },
  'scripts/sync-fixtures/electron-harness.ts',
)
