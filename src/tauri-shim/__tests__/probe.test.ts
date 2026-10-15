// SPDX-License-Identifier: GPL-2.0-or-later
// probeDevice runs the shared probe sequence over the backend's probe
// handle: it opens one, sends every request over it, has the backend
// decompress the definition, and closes the handle whatever happens.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { deviceApi } from '../api/device'

const DEFINITION = { name: 'Probe KB', matrix: { rows: 1, cols: 1 }, layouts: { keymap: [['0,0']] } }
const COMPRESSED = [1, 2, 3]

function report(bytes: number[]): number[] {
  return [...bytes, ...new Array<number>(32 - bytes.length).fill(0)]
}

/** Answers the probe requests of a 1x1, one-layer keyboard. */
function answer(data: number[]): number[] {
  const [cmd, sub] = data
  if (cmd === 0xfe && sub === 0x00) return report([6, 0, 0, 0, 0xef, 0xcd, 0xab, 0x89, 0x67, 0x45, 0x23, 0x01])
  if (cmd === 0xfe && sub === 0x01) return report([COMPRESSED.length])
  if (cmd === 0xfe && sub === 0x02) return report(COMPRESSED)
  if (cmd === 0x11) return report([0x11, 1])
  if (cmd === 0x12) return report([0x12, 0, 0, 2, 0x00, 0x04])
  if (cmd === 0x02) return report([0x02, 0x02, 0, 0, 0, 1])
  throw new Error(`unexpected request ${data.join(',')}`)
}

type Handler = (args: Record<string, unknown>) => unknown

function backend(overrides: Record<string, Handler> = {}): void {
  const handlers: Record<string, Handler> = {
    hid_probe_open: () => 7,
    hid_probe_send_receive: (args) => answer(args.data as number[]),
    decompress_definition: () => JSON.stringify(DEFINITION),
    hid_probe_close: () => null,
    ...overrides,
  }
  invoke.mockImplementation((cmd: string, args: Record<string, unknown>) => {
    const handler = handlers[cmd]
    if (!handler) return Promise.reject(new Error(`unexpected command ${cmd}`))
    try {
      return Promise.resolve(handler(args))
    } catch (err) {
      return Promise.reject(err)
    }
  })
}

function commands(): string[] {
  return invoke.mock.calls.map((call) => call[0] as string)
}

beforeEach(() => {
  invoke.mockReset()
})

describe('deviceApi.probeDevice', () => {
  it('runs the probe sequence over a probe handle and closes it', async () => {
    backend()

    const result = await deviceApi.probeDevice(0x1234, 0x5678, 'vial:f64c2b3c:x')

    expect(result).toMatchObject({
      uid: '0x0123456789abcdef',
      name: 'Probe KB',
      vialProtocol: 6,
      layers: 1,
      keymap: { '0,0,0': 0x0004 },
      layoutOptions: 1,
      encoderCount: 0,
    })
    expect(invoke).toHaveBeenNthCalledWith(1, 'hid_probe_open', {
      vendorId: 0x1234,
      productId: 0x5678,
      serialNumber: 'vial:f64c2b3c:x',
    })
    expect(invoke).toHaveBeenCalledWith('hid_probe_send_receive', { id: 7, data: [0xfe, 0x00] })
    expect(invoke).toHaveBeenCalledWith('decompress_definition', { data: COMPRESSED })
    expect(invoke).toHaveBeenLastCalledWith('hid_probe_close', { id: 7 })
    const sends = invoke.mock.calls.filter((call) => call[0] === 'hid_probe_send_receive')
    expect(sends.every((call) => (call[1] as { id: number }).id === 7)).toBe(true)
  })

  it('opens without a serial number when none is given', async () => {
    backend()
    await deviceApi.probeDevice(0x1234, 0x5678)
    expect(invoke).toHaveBeenNthCalledWith(1, 'hid_probe_open', {
      vendorId: 0x1234,
      productId: 0x5678,
      serialNumber: undefined,
    })
  })

  it('closes the handle and rejects with the error when a request fails', async () => {
    backend({
      hid_probe_send_receive: () => {
        throw 'HID read timeout during probe'
      },
    })

    await expect(deviceApi.probeDevice(0x1234, 0x5678)).rejects.toThrow('HID read timeout during probe')
    expect(commands()).toEqual(['hid_probe_open', 'hid_probe_send_receive', 'hid_probe_close'])
    expect(invoke).toHaveBeenLastCalledWith('hid_probe_close', { id: 7 })
  })

  it('rejects when the definition does not decompress', async () => {
    backend({ decompress_definition: () => null })
    await expect(deviceApi.probeDevice(0x1234, 0x5678)).rejects.toThrow('Failed to decompress keyboard definition')
    expect(commands().at(-1)).toBe('hid_probe_close')
  })

  it('rejects without closing anything when no handle opens', async () => {
    backend({
      hid_probe_open: () => {
        throw 'Probe target device not found'
      },
    })
    await expect(deviceApi.probeDevice(0x1234, 0x5678)).rejects.toThrow('Probe target device not found')
    expect(commands()).toEqual(['hid_probe_open'])
  })

  it('keeps the result when closing the handle fails', async () => {
    backend({
      hid_probe_close: () => {
        throw 'join error'
      },
    })
    await expect(deviceApi.probeDevice(0x1234, 0x5678)).resolves.toMatchObject({ name: 'Probe KB' })
  })
})
