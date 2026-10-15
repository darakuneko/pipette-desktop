// SPDX-License-Identifier: GPL-2.0-or-later
// The Tauri build names the Electron build's userData directory in
// ELECTRON_USER_DATA_NAME (src-tauri/crates/pipette-fs/src/user_data.rs).
// Electron derives that directory from the package name, so the two must
// stay equal for the Tauri build to find the Electron data.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import packageJson from '../../../package.json'

const USER_DATA_RS = resolve(__dirname, '../../../src-tauri/crates/pipette-fs/src/user_data.rs')

describe('Electron userData directory name', () => {
  it('matches the package name', () => {
    const source = readFileSync(USER_DATA_RS, 'utf-8')
    const match = /pub const ELECTRON_USER_DATA_NAME: &str = "([^"]+)";/.exec(source)
    expect(match?.[1]).toBe(packageJson.name)
  })
})
