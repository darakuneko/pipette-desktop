// SPDX-License-Identifier: GPL-2.0-or-later
// Records what Node reports on this machine for the typing-analytics
// identity: node-machine-id's `machineId(true)` and `os.platform()`,
// `os.release()` and `os.arch()`. The test tests/node_identity.rs of
// src-tauri/crates/pipette-typing-analytics compares its own values with
// these. Written under Cargo's temp directory and never committed: the
// values belong to the machine.
//
// Run: pnpm run generate:node-identity

import { mkdirSync, writeFileSync } from 'node:fs'
import { arch, platform, release } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import nodeMachineId from 'node-machine-id'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// Cargo's target directory as `cargo test` run from src-tauri resolves it:
// `CARGO_TARGET_DIR` when set (a relative value is taken from the current
// directory, as Cargo does), otherwise the workspace's `target`.
const cargoTargetDir = process.env.CARGO_TARGET_DIR
  ? resolve(process.cwd(), process.env.CARGO_TARGET_DIR)
  : resolve(repoRoot, 'src-tauri/target')

const output = join(cargoTargetDir, 'tmp', 'pipette-typing-analytics', 'node_identity.json')
const machineId = await nodeMachineId.machineId(true)
mkdirSync(dirname(output), { recursive: true })
writeFileSync(
  output,
  JSON.stringify({ machineId, platform: platform(), release: release(), arch: arch() }, null, 2) + '\n',
)
