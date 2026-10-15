// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// call() and subscribe() over the mocked Tauri IPC.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { emit } from '@tauri-apps/api/event'
import { call, subscribe } from '../ipc'

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** The callback table mockIPC installs, as the Tauri runtime keeps it. */
interface TauriInternals {
  runCallback: (id: number, data: unknown) => void
}

/** Lets every pending promise callback run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

afterEach(() => {
  clearMocks()
})

describe('call', () => {
  it('invokes the command with the arguments and resolves with the response', async () => {
    const handler = vi.fn(() => true)
    mockIPC(handler)
    await expect(call('open_device', { vendorId: 1, productId: 2 })).resolves.toBe(true)
    expect(handler).toHaveBeenCalledWith('open_device', { vendorId: 1, productId: 2 })
  })

  it('rejects with an Error carrying the message of a command error', async () => {
    mockIPC(() => Promise.reject('HID read timeout'))
    const err: unknown = await call('send_receive', { data: [1] }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('HID read timeout')
  })

  it('passes an Error rejection through as it is', async () => {
    const original = new Error('boom')
    mockIPC(() => Promise.reject(original))
    await expect(call('list_devices')).rejects.toBe(original)
  })
})

describe('subscribe', () => {
  it('passes each payload of the event to the callback', async () => {
    mockIPC(() => {}, { shouldMockEvents: true })
    const callback = vi.fn()
    subscribe<{ n: number }>('sync:progress', callback)
    await settle()
    await emit('sync:progress', { n: 1 })
    await emit('sync:progress', { n: 2 })
    await emit('other', { n: 3 })
    expect(callback.mock.calls).toEqual([[{ n: 1 }], [{ n: 2 }]])
  })

  it('stops the callback and unlistens once unsubscribed', async () => {
    const unlistened = vi.fn()
    mockIPC((cmd, args) => {
      if (cmd === 'plugin:event|listen') return 7
      if (cmd === 'plugin:event|unlisten') unlistened(args)
    })
    const unsubscribe = subscribe('sync:progress', vi.fn())
    await settle()
    unsubscribe()
    await settle()
    expect(unlistened).toHaveBeenCalledWith({ event: 'sync:progress', eventId: 7 })
  })

  it('unlistens when unsubscribed before listening has finished, without calling back', async () => {
    const listening = deferred<number>()
    const unlistened = vi.fn()
    let handlerId: number | undefined
    mockIPC((cmd, args) => {
      if (cmd === 'plugin:event|listen') {
        handlerId = (args as { handler: number }).handler
        return listening.promise
      }
      if (cmd === 'plugin:event|unlisten') unlistened(args)
    })
    const callback = vi.fn()
    const unsubscribe = subscribe('sync:progress', callback)
    await settle()
    unsubscribe()
    // An event delivered between the unsubscribe and the end of listening.
    const internals = (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__
    internals.runCallback(handlerId as number, { event: 'sync:progress', payload: 1 })
    expect(unlistened).not.toHaveBeenCalled()

    listening.resolve(9)
    await settle()
    expect(unlistened).toHaveBeenCalledWith({ event: 'sync:progress', eventId: 9 })
    expect(callback).not.toHaveBeenCalled()
  })

  it('unlistens once however many times it is unsubscribed', async () => {
    const unlistened = vi.fn()
    mockIPC((cmd, args) => {
      if (cmd === 'plugin:event|listen') return 7
      if (cmd === 'plugin:event|unlisten') unlistened(args)
    })
    const unsubscribe = subscribe('sync:progress', vi.fn())
    unsubscribe()
    unsubscribe()
    await settle()
    unsubscribe()
    await settle()
    expect(unlistened).toHaveBeenCalledTimes(1)
  })

  it('logs a failure to listen instead of leaving the rejection unhandled', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockIPC((cmd) => {
      if (cmd === 'plugin:event|listen') return Promise.reject('not allowed')
    })
    const unsubscribe = subscribe('sync:progress', vi.fn())
    await settle()
    expect(error).toHaveBeenCalledWith('[vialAPI shim] failed to listen to sync:progress:', 'not allowed')
    expect(() => unsubscribe()).not.toThrow()
    await settle()
  })
})
