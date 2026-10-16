// SPDX-License-Identifier: GPL-2.0-or-later
// Vitest config for the fixture generators of the pipette-typing-text crate
// and of the Aozora Bunko import of pipette-typing-datasets. Runs under
// Electron acting as Node (see the generate:typing-text-fixtures script),
// whose TextDecoder('shift_jis') the Rust decoder must match.
//
// Run: pnpm run generate:typing-text-fixtures

import { fixtureConfig } from '../fixture-vitest-config'

export default fixtureConfig('typing-text-fixtures', {
  // fflate writes the zip entries' modification time in local time.
  env: { TZ: 'UTC' },
})
