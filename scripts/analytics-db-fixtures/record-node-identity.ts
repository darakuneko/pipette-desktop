// SPDX-License-Identifier: GPL-2.0-or-later
// Records what Node reports on this machine for the typing-analytics
// identity: node-machine-id's `machineId(true)` (machine-hash.ts) and
// `os.platform()`, `os.release()` and `os.arch()` (fingerprint.ts). The
// test tests/node_identity.rs of src-tauri/crates/pipette-typing-analytics
// compares its own values with these. Written under Cargo's temp directory
// and never committed: the values belong to the machine.
//
// Run: pnpm run generate:node-identity

import { arch, platform, release } from 'node:os'
import { join } from 'node:path'
import nodeMachineId from 'node-machine-id'
import { cargoTargetTmpDir, writeJsonFixture } from '../fixture-files'

const machineId = await nodeMachineId.machineId(true)
writeJsonFixture(join(cargoTargetTmpDir('pipette-typing-analytics'), 'node_identity.json'), {
  machineId,
  platform: platform(),
  release: release(),
  arch: arch(),
})
