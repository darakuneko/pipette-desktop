// SPDX-License-Identifier: GPL-2.0-or-later
// Where the sync-format vectors live, shared by the generator and the
// verifier in this directory.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cargoTargetTmpDir } from '../fixture-files'

const here = dirname(fileURLToPath(import.meta.url))
const crateDir = resolve(here, '../../src-tauri/crates/pipette-sync-format')

/** Committed vectors whose content is the same on every run. */
export const TS_VECTORS_PATH = resolve(crateDir, 'tests/fixtures/ts_vectors.json')

/** Committed envelopes from the real random `encrypt`; different on every run. */
export const TS_RANDOM_ENVELOPES_PATH = resolve(crateDir, 'tests/fixtures/ts_random_envelopes.json')

const cargoTmpDir = cargoTargetTmpDir('pipette-sync-format')

/** This machine's `machineId(true)`, read by the Rust test that compares it. */
export const NODE_MACHINE_ID_PATH = resolve(cargoTmpDir, 'node_machine_id.json')

/** Envelopes the Rust tests write for the TypeScript verifier, one JSON
 *  file per case. */
export const RUST_ENVELOPES_DIR = resolve(cargoTmpDir, 'rust_envelopes')
