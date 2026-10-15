// SPDX-License-Identifier: GPL-2.0-or-later
// Where the typing-analytics DB fixtures live, shared by the generator in
// this directory and read by the Rust crate's tests and benchmark.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const crateDir = resolve(here, '../../src-tauri/crates/pipette-typing-analytics-db')

/** Committed: the day JSONL and what the TypeScript DB layer made of it. */
export const COMMITTED_FIXTURES_DIR = resolve(crateDir, 'tests/fixtures')

/** Cargo's CARGO_TARGET_TMPDIR for the crate. Holds the large benchmark
 *  input and this machine's timings, never committed. */
export const BENCH_DIR = resolve(here, '../../src-tauri/target/tmp/pipette-typing-analytics-db')
