// SPDX-License-Identifier: GPL-2.0-or-later
// Vitest config for the resident fixture generators (tray, autostart,
// startup notice, window operations, X11 active window) and the tests of
// their harness (harness.ts).
//
// Run: pnpm run generate:resident-fixtures / pnpm run test:resident-fixtures-harness

import { fixtureConfig } from '../fixture-vitest-config'

export default fixtureConfig(
  'resident-fixtures',
  { setupFiles: ['scripts/resident-fixtures/setup.ts'] },
  'scripts/resident-fixtures/electron-mock.ts',
)
