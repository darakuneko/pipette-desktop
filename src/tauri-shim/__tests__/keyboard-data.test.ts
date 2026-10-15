// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// The keyboard data members over the mocked Tauri IPC: the stored list is
// what the backend answers, and names recorded one after another reach the
// backend one at a time, in the order the renderer recorded them.

import { afterEach, describe, expect, it } from 'vitest'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { keyboardDataApi } from '../api/keyboard-data'

afterEach(() => {
  clearMocks()
})

describe('keyboardDataApi', () => {
  it('lists the stored keyboards the backend answers', async () => {
    const list = [{ uid: '0xA', name: 'Board A' }]
    mockIPC((cmd) => (cmd === 'list_stored_keyboards' ? list : undefined))
    await expect(keyboardDataApi.listStoredKeyboards()).resolves.toEqual(list)
  })

  it('sends each name only after the previous one has been written', async () => {
    const log: string[] = []
    const releases: (() => void)[] = []
    mockIPC((cmd, payload) => {
      if (cmd !== 'keyboard_meta_name_if_missing') throw new Error(`unexpected command ${cmd}`)
      const { uid } = payload as { uid: string }
      log.push(`start ${uid}`)
      return new Promise<null>((resolve) => {
        releases.push(() => {
          log.push(`end ${uid}`)
          resolve(null)
        })
      })
    })
    const first = keyboardDataApi.keyboardMetaNameIfMissing('0xA', 'A')
    const second = keyboardDataApi.keyboardMetaNameIfMissing('0xB', 'B')
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(log).toEqual(['start 0xA'])
    releases.shift()?.()
    await expect(first).resolves.toBeUndefined()
    for (let i = 0; i < 10; i++) await Promise.resolve()
    releases.shift()?.()
    await expect(second).resolves.toBeUndefined()
    expect(log).toEqual(['start 0xA', 'end 0xA', 'start 0xB', 'end 0xB'])
  })

  it('rejects with the backend error and still sends the next name', async () => {
    mockIPC((_cmd, payload) => {
      if ((payload as { uid: string }).uid === 'bad') throw 'disk full'
      return null
    })
    await expect(keyboardDataApi.keyboardMetaNameIfMissing('bad', 'x')).rejects.toThrow('disk full')
    await expect(keyboardDataApi.keyboardMetaNameIfMissing('0xA', 'A')).resolves.toBeUndefined()
  })
})
