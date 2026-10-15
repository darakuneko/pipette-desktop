// SPDX-License-Identifier: GPL-2.0-or-later
// Vitest config for the fixture generators of the pipette-keyboard-stores
// crate. TZ is UTC so a date-time without an offset, which Date reads as
// local time, gives the same milliseconds as the crate (which reads it as
// UTC) on every machine.
//
// Run: pnpm run generate:keyboard-store-fixtures

import { fixtureConfig } from '../fixture-vitest-config'

export default fixtureConfig('keyboard-store-fixtures', { env: { TZ: 'UTC' } })
