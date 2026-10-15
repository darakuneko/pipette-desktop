// SPDX-License-Identifier: GPL-2.0-or-later
// Vitest config for the fixture generator of the pipette-app-config crate.
// electron-store is inlined so that its own `electron` import gets the
// generator's mock; conf, which it extends, runs as is.
//
// Run: pnpm run generate:app-config-fixtures

import { fixtureConfig } from '../fixture-vitest-config'

export default fixtureConfig('app-config-fixtures', { server: { deps: { inline: ['electron-store'] } } })
