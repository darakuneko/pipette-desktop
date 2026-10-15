// SPDX-License-Identifier: GPL-2.0-or-later
// appConfigSet sends one set at a time, in call order, so the backend stores
// and applies the renderer's sets in the order they were made.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { appConfigApi } from '../api/app-config'

interface Pending {
  value: unknown
  resolve: () => void
  reject: (err: unknown) => void
}

let pending: Pending[] = []

beforeEach(() => {
  pending = []
  invoke.mockReset()
  invoke.mockImplementation(
    (_command: string, args: { value: string }) =>
      new Promise<void>((resolve, reject) => {
        pending.push({ value: JSON.parse(args.value), resolve, reject })
      }),
  )
})

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('appConfigApi.appConfigSet', () => {
  it('sends the next set only after the previous one has finished', async () => {
    const first = appConfigApi.appConfigSet('zoomFactor', 110)
    const second = appConfigApi.appConfigSet('zoomFactor', 120)
    await settle()
    expect(pending.map((p) => p.value)).toEqual([110])

    pending[0].resolve()
    await first
    await settle()
    expect(pending.map((p) => p.value)).toEqual([110, 120])

    pending[1].resolve()
    await expect(second).resolves.toBeUndefined()
  })

  it('keeps going after a set fails, and rejects only that call', async () => {
    const failed = appConfigApi.appConfigSet('zoomFactor', 110)
    const next = appConfigApi.appConfigSet('zoomFactor', 120)
    await settle()
    pending[0].reject('write failed')
    await expect(failed).rejects.toThrow('write failed')
    await settle()
    expect(pending.map((p) => p.value)).toEqual([110, 120])
    pending[1].resolve()
    await expect(next).resolves.toBeUndefined()
  })

  it('sends the value as JSON text', async () => {
    const done = appConfigApi.appConfigSet('windowState', { x: 1 })
    await settle()
    expect(invoke).toHaveBeenCalledWith('app_config_set', { key: 'windowState', value: '{"x":1}' })
    pending[0].resolve()
    await done
  })
})
