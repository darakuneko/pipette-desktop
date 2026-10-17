// SPDX-License-Identifier: GPL-2.0-or-later
// Where the Hub fixture generators write: the golden files of the Rust
// crate src-tauri/crates/pipette-hub.

import { resolve } from 'node:path'
import { REPO_ROOT } from '../fixture-vitest-config'

export const HUB_FIXTURES_DIR = resolve(REPO_ROOT, 'src-tauri/crates/pipette-hub/tests/fixtures')

export function hubFixturePath(name: string): string {
  return resolve(HUB_FIXTURES_DIR, name)
}
