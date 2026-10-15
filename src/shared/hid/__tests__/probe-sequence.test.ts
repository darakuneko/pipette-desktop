// SPDX-License-Identifier: GPL-2.0-or-later
// The probe sequence over a scripted device: the requests it sends, in
// order, and the ProbeResult it builds from the answers.

import { describe, expect, it, vi } from 'vitest'
import { runProbeSequence, type ProbeDecompress } from '../probe-sequence'
import { encoderLabel } from '../../kle/__tests__/encoder-label'
import { MSG_LEN } from '../../constants/protocol'

interface FakeKeyboard {
  protocol: number
  uid: bigint
  compressed: number[]
  layers: number
  /** Big-endian keycode bytes, layer-major then row then column. */
  keymap: number[]
  layoutOptions: number
  /** `"layer,idx"` → [cw, ccw]. */
  encoders: Record<string, [number, number]>
}

function report(bytes: number[]): number[] {
  const out = new Array<number>(MSG_LEN).fill(0)
  bytes.slice(0, MSG_LEN).forEach((b, i) => {
    out[i] = b
  })
  return out
}

function le32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff]
}

/** Answers each request as Vial firmware would, recording the requests. */
function fakeDevice(kb: FakeKeyboard): { sendReceive: (data: number[]) => Promise<number[]>; sent: number[][] } {
  const sent: number[][] = []
  const sendReceive = (data: number[]): Promise<number[]> => {
    sent.push([...data])
    const [cmd, sub] = data
    if (cmd === 0xfe && sub === 0x00) {
      const uidBytes: number[] = []
      for (let i = 0; i < 8; i++) uidBytes.push(Number((kb.uid >> BigInt(8 * i)) & 0xffn))
      return Promise.resolve(report([...le32(kb.protocol), ...uidBytes]))
    }
    if (cmd === 0xfe && sub === 0x01) return Promise.resolve(report(le32(kb.compressed.length)))
    if (cmd === 0xfe && sub === 0x02) {
      const block = data[2] | (data[3] << 8) | (data[4] << 16) | (data[5] << 24)
      return Promise.resolve(report(kb.compressed.slice(block * MSG_LEN, (block + 1) * MSG_LEN)))
    }
    if (cmd === 0x11) return Promise.resolve(report([0x11, kb.layers]))
    if (cmd === 0x12) {
      const offset = (data[1] << 8) | data[2]
      const size = data[3]
      return Promise.resolve(report([0x12, data[1], data[2], size, ...kb.keymap.slice(offset, offset + size)]))
    }
    if (cmd === 0x02 && sub === 0x02) {
      const v = kb.layoutOptions
      return Promise.resolve(report([0x02, 0x02, (v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]))
    }
    if (cmd === 0xfe && sub === 0x03) {
      const [cw, ccw] = kb.encoders[`${data[2]},${data[3]}`] ?? [0, 0]
      return Promise.resolve(report([cw >> 8, cw & 0xff, ccw >> 8, ccw & 0xff]))
    }
    return Promise.reject(new Error(`unexpected request ${data.join(',')}`))
  }
  return { sendReceive, sent }
}

/** A "decompressor" that reads the bytes as UTF-8 text. */
const identity: ProbeDecompress = (bytes) => Promise.resolve(new TextDecoder().decode(Uint8Array.from(bytes)))

function bytesOf(text: string): number[] {
  return Array.from(new TextEncoder().encode(text))
}

describe('runProbeSequence', () => {
  it('reads the id, definition, keymap, layout options and encoders in order', async () => {
    const definition = {
      name: 'Probe KB',
      matrix: { rows: 1, cols: 2 },
      layouts: { keymap: [['0,0', '0,1', encoderLabel(0, 0), encoderLabel(0, 1)]] },
    }
    const compressed = bytesOf(JSON.stringify(definition))
    const kb: FakeKeyboard = {
      protocol: 6,
      uid: 0x0123456789abcdefn,
      compressed,
      layers: 2,
      keymap: [0x00, 0x04, 0x00, 0x05, 0x7e, 0x40, 0x00, 0x29],
      layoutOptions: 0x01020304,
      encoders: { '0,0': [0x1111, 0x2222], '1,0': [0x3333, 0x4444] },
    }
    const { sendReceive, sent } = fakeDevice(kb)
    const decompress = vi.fn(identity)

    const result = await runProbeSequence(sendReceive, decompress)

    expect(decompress).toHaveBeenCalledWith(compressed)
    expect(result).toEqual({
      uid: '0x0123456789abcdef',
      name: 'Probe KB',
      vialProtocol: 6,
      definition,
      layers: 2,
      rows: 1,
      cols: 2,
      keymap: { '0,0,0': 0x0004, '0,0,1': 0x0005, '1,0,0': 0x7e40, '1,0,1': 0x0029 },
      encoderLayout: { '0,0,0': 0x1111, '0,0,1': 0x2222, '1,0,0': 0x3333, '1,0,1': 0x4444 },
      encoderCount: 1,
      layoutOptions: 0x01020304,
    })

    const blocks = Math.ceil(compressed.length / MSG_LEN)
    const definitionRequests = Array.from({ length: blocks }, (_, block) => report([0xfe, 0x02, ...le32(block)]))
    expect(sent).toEqual([
      [0xfe, 0x00],
      [0xfe, 0x01],
      ...definitionRequests,
      [0x11],
      report([0x12, 0x00, 0x00, 8]),
      [0x02, 0x02],
      [0xfe, 0x03, 0, 0],
      [0xfe, 0x03, 1, 0],
    ])
  })

  it('reads the keymap in chunks of BUFFER_FETCH_CHUNK bytes', async () => {
    const definition = { name: 'Big', matrix: { rows: 2, cols: 10 }, layouts: { keymap: [['0,0']] } }
    const keymap = Array.from({ length: 40 }, (_, i) => i)
    const { sendReceive, sent } = fakeDevice({
      protocol: 6,
      uid: 1n,
      compressed: bytesOf(JSON.stringify(definition)),
      layers: 1,
      keymap,
      layoutOptions: 0,
      encoders: {},
    })

    const result = await runProbeSequence(sendReceive, identity)

    const keymapRequests = sent.filter((p) => p[0] === 0x12)
    expect(keymapRequests).toEqual([report([0x12, 0, 0, 28]), report([0x12, 0, 28, 12])])
    expect(result.keymap['0,0,0']).toBe(0x0001)
    expect(result.keymap['0,1,9']).toBe((38 << 8) | 39)
  })

  it('names a definition without a name Unknown', async () => {
    const definition = { matrix: { rows: 1, cols: 1 }, layouts: { keymap: [['0,0']] } }
    const { sendReceive } = fakeDevice({
      protocol: 6,
      uid: 1n,
      compressed: bytesOf(JSON.stringify(definition)),
      layers: 1,
      keymap: [0, 0],
      layoutOptions: 0,
      encoders: {},
    })

    const result = await runProbeSequence(sendReceive, identity)

    expect(result.name).toBe('Unknown')
    expect(result.encoderCount).toBe(0)
    expect(result.encoderLayout).toEqual({})
  })

  it('fails when the definition does not decompress', async () => {
    const { sendReceive, sent } = fakeDevice({
      protocol: 6,
      uid: 1n,
      compressed: [1, 2, 3],
      layers: 1,
      keymap: [],
      layoutOptions: 0,
      encoders: {},
    })

    await expect(runProbeSequence(sendReceive, () => Promise.resolve(null))).rejects.toThrow(
      'Failed to decompress keyboard definition',
    )
    expect(sent.some((p) => p[0] === 0x11)).toBe(false)
  })

  it('stops at the first failed request', async () => {
    const sendReceive = vi.fn().mockRejectedValue(new Error('HID read timeout during probe'))
    const decompress = vi.fn(identity)

    await expect(runProbeSequence(sendReceive, decompress)).rejects.toThrow('HID read timeout during probe')
    expect(sendReceive).toHaveBeenCalledTimes(1)
    expect(decompress).not.toHaveBeenCalled()
  })
})
