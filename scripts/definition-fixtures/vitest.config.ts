// SPDX-License-Identifier: GPL-2.0-or-later
// Vitest config for the keyboard definition decompression fixture generator.
//
// Run: pnpm run generate:definition-fixtures

import { fixtureConfig } from '../fixture-vitest-config'

// Decompressing the inputs at the 10 MiB output limit with lzma-js takes a
// while.
export default fixtureConfig('definition-fixtures', { testTimeout: 300_000 })
