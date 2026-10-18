// SPDX-License-Identifier: GPL-2.0-or-later
// Every session checks that the app binary is a build with the development
// tools before anything starts: no userData directory, no tauri-driver.

import { describe, expect, it, vi } from 'vitest'

const spawn = vi.hoisted(() => vi.fn())
const mkdtempSync = vi.hoisted(() => vi.fn())
const assertDevToolsBinary = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('not a build with the development tools')
  }),
)

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn,
}))
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  mkdtempSync,
}))
vi.mock('../hub-env', () => ({ assertDevToolsBinary }))

import { APP_BINARY, startDriver } from '../driver'

describe('startDriver', () => {
  it('starts nothing for a binary without the development tools', async () => {
    await expect(startDriver({})).rejects.toThrow(/development tools/)
    expect(assertDevToolsBinary).toHaveBeenCalledWith(APP_BINARY)
    expect(mkdtempSync).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })
})
