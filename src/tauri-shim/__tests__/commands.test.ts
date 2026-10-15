// SPDX-License-Identifier: GPL-2.0-or-later
// The shim's command table names exactly the backend's app commands, as the
// Rust tests export them (src-tauri/src/ipc_contract.rs).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COMMANDS } from '../commands'

function backendCommands(): string[] {
  const text = readFileSync(resolve(__dirname, '../generated/app-command-names.json'), 'utf8')
  return JSON.parse(text) as string[]
}

describe('COMMANDS', () => {
  it('names exactly the app commands of the backend', () => {
    expect(Object.values(COMMANDS).sort()).toEqual(backendCommands().sort())
  })
})
