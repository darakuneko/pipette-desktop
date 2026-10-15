// SPDX-License-Identifier: GPL-2.0-or-later
// The Tauri transport maps each export to its backend command
// (src-tauri/src/hid_commands.rs) and keeps reports in call order.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ElectronTransport from '../../preload/hid-transport'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

type Transport = typeof import('../hid-transport')

/** A fresh module per test: the transport keeps the open flag and the queue. */
async function load(): Promise<Transport> {
  vi.resetModules()
  return import('../hid-transport')
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  invoke.mockReset()
})

describe('Tauri hid-transport', () => {
  it('has the exports of the Electron transport', async () => {
    const transport = await load()
    const asElectron: typeof ElectronTransport = transport
    expect(Object.keys(asElectron).sort()).toEqual(
      ['closeHidDevice', 'isDeviceOpen', 'listDevices', 'openHidDevice', 'probeDevice', 'send', 'sendReceive'],
    )
  })

  it('lists devices with list_devices', async () => {
    const devices = [{ vendorId: 1, productId: 2, productName: 'K', serialNumber: 's', type: 'vial' }]
    invoke.mockResolvedValueOnce(devices)
    const transport = await load()
    await expect(transport.listDevices()).resolves.toEqual(devices)
    expect(invoke).toHaveBeenCalledWith('list_devices', undefined)
  })

  it('opens with open_device and tracks the open state', async () => {
    const transport = await load()
    await expect(transport.isDeviceOpen()).resolves.toBe(false)
    expect(invoke).not.toHaveBeenCalled()

    invoke.mockResolvedValueOnce(true)
    await expect(transport.openHidDevice(0x7a79, 0xf063)).resolves.toBe(true)
    expect(invoke).toHaveBeenLastCalledWith('open_device', { vendorId: 0x7a79, productId: 0xf063 })

    invoke.mockResolvedValueOnce(true)
    await expect(transport.isDeviceOpen()).resolves.toBe(true)
    expect(invoke).toHaveBeenLastCalledWith('is_device_open', undefined)

    invoke.mockResolvedValueOnce(undefined)
    await transport.closeHidDevice()
    expect(invoke).toHaveBeenLastCalledWith('close_device', undefined)
    invoke.mockClear()
    await expect(transport.isDeviceOpen()).resolves.toBe(false)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('forgets the open state when the backend reports the device gone', async () => {
    const transport = await load()
    invoke.mockResolvedValueOnce(true)
    await transport.openHidDevice(1, 2)
    invoke.mockResolvedValueOnce(false)
    await expect(transport.isDeviceOpen()).resolves.toBe(false)
    invoke.mockClear()
    await expect(transport.isDeviceOpen()).resolves.toBe(false)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('sends reports as number arrays and returns the response as bytes', async () => {
    const transport = await load()
    invoke.mockResolvedValueOnce([1, 2, 3])
    const response = await transport.sendReceive(new Uint8Array([0x12, 0xff]))
    expect(invoke).toHaveBeenCalledWith('send_receive', { data: [0x12, 0xff] })
    expect(response).toBeInstanceOf(Uint8Array)
    expect(Array.from(response)).toEqual([1, 2, 3])

    invoke.mockResolvedValueOnce(undefined)
    await transport.send(new Uint8Array([7]))
    expect(invoke).toHaveBeenLastCalledWith('send', { data: [7] })
  })

  it('invokes each report only after the previous one has settled', async () => {
    const transport = await load()
    const first = deferred<number[]>()
    invoke.mockReturnValueOnce(first.promise).mockResolvedValueOnce(undefined).mockResolvedValueOnce([9])

    const a = transport.sendReceive(new Uint8Array([1]))
    const b = transport.send(new Uint8Array([2]))
    const c = transport.sendReceive(new Uint8Array([3]))
    await Promise.resolve()
    await Promise.resolve()
    expect(invoke).toHaveBeenCalledTimes(1)

    first.resolve([8])
    await expect(a).resolves.toEqual(new Uint8Array([8]))
    await b
    await expect(c).resolves.toEqual(new Uint8Array([9]))
    expect(invoke.mock.calls.map(([, args]) => (args as { data: number[] }).data)).toEqual([[1], [2], [3]])
  })

  it('rejects with an Error carrying the command error and keeps the queue going', async () => {
    const transport = await load()
    invoke.mockRejectedValueOnce('HID read timeout').mockResolvedValueOnce([5])
    const failed = transport.sendReceive(new Uint8Array([1]))
    const next = transport.sendReceive(new Uint8Array([2]))
    await expect(failed).rejects.toThrow(new Error('HID read timeout'))
    await expect(next).resolves.toEqual(new Uint8Array([5]))
  })

  it('rejects probeDevice, which has no backend command', async () => {
    const transport = await load()
    await expect(transport.probeDevice(1, 2)).rejects.toThrow('probeDevice is not implemented')
    expect(invoke).not.toHaveBeenCalled()
  })
})
