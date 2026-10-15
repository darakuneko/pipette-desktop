// SPDX-License-Identifier: GPL-2.0-or-later
// Vitest config for the Cloud Sync format vectors shared with the Rust crate
// src-tauri/crates/pipette-sync-format. Separate from the root config, so
// `pnpm test` never needs the Rust output.
//
// Run:
//   pnpm run generate:sync-format-fixtures   (TypeScript → Rust vectors)
//   pnpm run verify:sync-format-rust-vectors (Rust → TypeScript, after
//                                             `cargo test -p pipette-sync-format`)

import { fixtureConfig } from '../fixture-vitest-config'

export default fixtureConfig('sync-format-fixtures', {
  // PBKDF2 with 600,000 iterations runs for every envelope.
  testTimeout: 120_000,
})
