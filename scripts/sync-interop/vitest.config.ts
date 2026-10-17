// SPDX-License-Identifier: GPL-2.0-or-later
// Vitest config for the interoperability test of the two sync engines
// (interop.test.ts). It runs the Electron main process's sync code in the
// harness of the sync fixture generators (scripts/sync-fixtures/harness.ts),
// which keeps it off the network and the real userData.
//
// Run: pnpm run test:sync-interop (after building the Rust peer:
// cargo build -p pipette-sync --example sync_peer, from src-tauri)

import { fixtureConfig } from '../fixture-vitest-config'

export default fixtureConfig(
  'sync-interop',
  { setupFiles: ['scripts/sync-fixtures/setup.ts'], testTimeout: 600_000, hookTimeout: 60_000 },
  'scripts/sync-fixtures/electron-harness.ts',
)
