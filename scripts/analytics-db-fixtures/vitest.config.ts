// SPDX-License-Identifier: GPL-2.0-or-later
// Vitest config for the typing-analytics DB fixtures shared with the Rust
// crate src-tauri/crates/pipette-typing-analytics-db. Kept separate from the
// root config so `pnpm test` never rewrites the fixtures.
//
// Unlike the root config, `better-sqlite3` is NOT routed to the sql.js
// adapter: the fixtures must come from the real native module the app ships.
// That module is built for Electron's ABI, so this config runs under Electron
// acting as Node (see the `generate:analytics-db-fixtures` script).
//
// Run: pnpm run generate:analytics-db-fixtures

import { fixtureConfig } from '../fixture-vitest-config'

export default fixtureConfig('analytics-db-fixtures', {
  testTimeout: 600_000,
  // The seed lays sessions on local wall-clock hours; UTC keeps the
  // generated JSONL the same on every machine.
  env: { TZ: 'UTC' },
})
