// SPDX-License-Identifier: GPL-2.0-or-later
// Where the typing-analytics DB fixtures live, shared by the generator in
// this directory and read by the Rust crate's tests and benchmark.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cargoTargetTmpDir } from '../fixture-files'

const here = dirname(fileURLToPath(import.meta.url))
const crateDir = resolve(here, '../../src-tauri/crates/pipette-typing-analytics-db')
const timeCrateDir = resolve(here, '../../src-tauri/crates/pipette-time')
const analyticsCrateDir = resolve(here, '../../src-tauri/crates/pipette-typing-analytics')

/** Committed: the day JSONL and what the TypeScript DB layer made of it. */
export const COMMITTED_FIXTURES_DIR = resolve(crateDir, 'tests/fixtures')

/** Committed: the SQL text the crate includes (src/sql.rs). */
export const GENERATED_SQL_PATH = resolve(crateDir, 'data/sql.rs')

/** The large benchmark input and this machine's timings, never committed.
 *  `bench_dir` in the crate's tests/common/mod.rs resolves the same
 *  directory; the two must change together. */
export const BENCH_DIR = cargoTargetTmpDir('pipette-typing-analytics-db')

/** Committed: one file per time zone of time-zones.ts with the local days
 *  JavaScript gives there (tz-local-days.test.ts). */
export const LOCAL_DAYS_FIXTURES_DIR = resolve(timeCrateDir, 'tests/fixtures/local_days')

/** Committed: what the TypeScript code above the DB layer reads and writes
 *  (the JSONL files, the deleted ranges, the keymap snapshots, …). */
export const ANALYTICS_FIXTURES_DIR = resolve(analyticsCrateDir, 'tests/fixtures')
