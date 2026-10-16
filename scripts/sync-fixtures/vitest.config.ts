// SPDX-License-Identifier: GPL-2.0-or-later
// Vitest config for the sync fixture generators and the tests of their
// harness (harness.ts), which setup.ts installs before every test file.
//
// Run: pnpm run test:sync-fixtures-harness

import { fixtureConfig } from '../fixture-vitest-config'

export default fixtureConfig(
  'sync-fixtures',
  { setupFiles: ['scripts/sync-fixtures/setup.ts'] },
  'scripts/sync-fixtures/electron-harness.ts',
)
