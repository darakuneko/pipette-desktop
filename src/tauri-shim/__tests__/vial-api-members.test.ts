// SPDX-License-Identifier: GPL-2.0-or-later
// Checks the member table against the Electron preload's vialAPI, the
// implementation the renderer runs against today: same member names, and a
// member is a listener exactly when calling it returns a function
// synchronously. The `satisfies` clause in vial-api-members.ts checks the
// same against the VialAPI type at compile time.

import { describe, expect, it, vi } from 'vitest'
import { VIAL_API_MEMBER_KINDS, VIAL_API_MEMBER_NAMES } from '../vial-api-members'

const exposed = vi.hoisted(() => ({ api: {} as Record<string, unknown> }))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_key: string, api: Record<string, unknown>) => {
      exposed.api = api
    },
  },
  ipcRenderer: {
    invoke: vi.fn(() => new Promise(() => {})),
    send: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}))

async function loadPreloadApi(): Promise<Record<string, unknown>> {
  await import('../../preload/index')
  return exposed.api
}

describe('VIAL_API_MEMBER_KINDS', () => {
  it('lists exactly the members the preload exposes', async () => {
    const preload = await loadPreloadApi()
    expect([...VIAL_API_MEMBER_NAMES].sort()).toEqual(Object.keys(preload).sort())
  })

  it('marks a member as a listener exactly when it returns an unsubscribe function', async () => {
    const preload = await loadPreloadApi()
    const listeners: string[] = []
    for (const [name, member] of Object.entries(preload)) {
      if (typeof member !== 'function') continue
      let result: unknown
      try {
        result = (member as (callback: () => void) => unknown)(() => {})
      } catch {
        continue
      }
      if (typeof result === 'function') {
        listeners.push(name)
      } else if (result instanceof Promise) {
        // Called with a callback in place of real arguments, a request may
        // reject; only its synchronous return value matters here.
        result.catch(() => {})
      }
    }
    const tableListeners = VIAL_API_MEMBER_NAMES.filter(
      (name) => VIAL_API_MEMBER_KINDS[name] === 'listener',
    )
    expect(tableListeners.sort()).toEqual(listeners.sort())
  })
})
