// SPDX-License-Identifier: GPL-2.0-or-later
// File output shared by the fixture generators under scripts/, and where
// the never-committed outputs for the Rust tests go.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Cargo's target directory as `cargo test` run from src-tauri resolves it:
 *  `CARGO_TARGET_DIR` when set (a relative value is taken from the current
 *  directory, as Cargo does), otherwise the workspace's `target`. */
export const cargoTargetDir = process.env.CARGO_TARGET_DIR
  ? resolve(process.cwd(), process.env.CARGO_TARGET_DIR)
  : resolve(repoRoot, 'src-tauri/target')

/** `<CARGO_TARGET_TMPDIR>/<crate>`: files for a crate's Rust tests that are
 *  specific to this machine or to a run, never committed. */
export function cargoTargetTmpDir(crate: string): string {
  return resolve(cargoTargetDir, 'tmp', crate)
}

/** Writes `content` to `path`, creating the parent directories. */
export function writeFixture(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

/** Writes `value` as two-space indented JSON with a trailing newline. */
export function writeJsonFixture(path: string, value: unknown): void {
  writeFixture(path, JSON.stringify(value, null, 2) + '\n')
}
