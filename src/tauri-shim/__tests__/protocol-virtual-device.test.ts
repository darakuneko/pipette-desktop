// SPDX-License-Identifier: GPL-2.0-or-later
// The protocol parsers of ../protocol.ts against the virtual GPK60-63R's
// recorded reports: the transport replays the report events of the
// pipette-virtual-device golden transcript in order, so each call must send
// the recorded request and parse the recorded response.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, vi } from 'vitest'

interface TranscriptEvent {
  op: string
  request?: string
  response?: string
}

const TRANSCRIPT = resolve(__dirname, '../../../src-tauri/crates/pipette-virtual-device/tests/fixtures/transcript.json')

const replay = vi.hoisted(() => ({ reports: [] as { request: string; response: string }[], next: 0 }))

vi.mock('../hid-transport', () => {
  function answer(data: Uint8Array): Uint8Array {
    const padded = new Uint8Array(32)
    padded.set(data)
    const request = Buffer.from(padded).toString('hex')
    const report = replay.reports[replay.next]
    if (!report) throw new Error(`no recorded report left for ${request}`)
    if (report.request !== request) {
      throw new Error(`report ${replay.next}: sent ${request}, recorded ${report.request}`)
    }
    replay.next++
    return Uint8Array.from(Buffer.from(report.response, 'hex'))
  }
  return {
    sendReceive: async (data: Uint8Array): Promise<Uint8Array> => answer(data),
    send: async (data: Uint8Array): Promise<void> => {
      answer(data)
    },
  }
})

import {
  getProtocolVersion,
  getKeyboardId,
  getLayerCount,
  getKeymapBuffer,
  getUnlockStatus,
  unlockStart,
  unlockPoll,
  getDefinitionSize,
  getDefinitionRaw,
  getDynamicEntryCount,
  getTapDance,
  getCombo,
  getKeyOverride,
  getAltRepeatKey,
  qmkSettingsQuery,
  qmkSettingsGet,
  qmkSettingsSet,
  qmkSettingsReset,
  getVialRGBInfo,
  getVialRGBMode,
  getVialRGBSupported,
} from '../protocol'
import { MSG_LEN } from '../../shared/constants/protocol'

const events = (JSON.parse(readFileSync(TRANSCRIPT, 'utf8')) as { events: TranscriptEvent[] }).events
replay.reports = events.flatMap((event) =>
  event.op === 'report' && event.request && event.response ? [{ request: event.request, response: event.response }] : [],
)

/** The recorded response of the next report, read before the call that sends it. */
function nextResponse(): number[] {
  return Array.from(Buffer.from(replay.reports[replay.next].response, 'hex'))
}

// The cases run in the transcript's order and share its cursor.
describe('protocol against the recorded virtual device', () => {
  it('getProtocolVersion resolves to VIA protocol 9', async () => {
    await expect(getProtocolVersion()).resolves.toBe(9)
  })

  it('getKeyboardId resolves to vial protocol 6 and the VIRTGPK uid', async () => {
    const id = await getKeyboardId()
    expect(id.vialProtocol).toBe(6)
    // "VIRTGPK\0" read as a little-endian 64-bit number.
    expect(id.uid).toBe('0x004b504754524956')
  })

  it('getLayerCount resolves to 4 layers', async () => {
    await expect(getLayerCount()).resolves.toBe(4)
  })

  it('getKeymapBuffer returns the payload of the first chunk', async () => {
    const expected = nextResponse().slice(4, 4 + 28)
    await expect(getKeymapBuffer(0, 28)).resolves.toEqual(expected)
  })

  it('getUnlockStatus reports locked with the two-key unlock combo', async () => {
    const status = await getUnlockStatus()
    expect(status.unlocked).toBe(false)
    expect(status.keys).toEqual([
      [0, 0],
      [0, 1],
    ])
  })

  it('getDefinitionSize/getDefinitionRaw read the whole LZMA stream', async () => {
    const size = await getDefinitionSize()
    expect(size).toBe(0x18d)
    const raw = await getDefinitionRaw(size)
    expect(raw).toHaveLength(size)
    // LZMA-alone header: properties byte 0x5d.
    expect(raw[0]).toBe(0x5d)
  })

  it('getDynamicEntryCount reports the 32-entry tier and caps-word/layer-lock feature flags', async () => {
    await expect(getDynamicEntryCount()).resolves.toEqual({
      tapDance: 32,
      combo: 32,
      keyOverride: 32,
      altRepeatKey: 32,
      featureFlags: 0x03,
    })
  })

  it('getTapDance/getCombo/getKeyOverride/getAltRepeatKey parse the seeded sample at index 0', async () => {
    const tapDance = await getTapDance(0)
    expect(tapDance.onTap).not.toBe(0)
    expect(tapDance.onHold).not.toBe(0)

    const combo = await getCombo(0)
    expect(combo.key1).not.toBe(0)
    expect(combo.key2).not.toBe(0)
    expect(combo.output).not.toBe(0)

    const keyOverride = await getKeyOverride(0)
    expect(keyOverride.enabled).toBe(true)
    expect(keyOverride.triggerKey).not.toBe(0)
    expect(keyOverride.replacementKey).not.toBe(0)

    const altRepeatKey = await getAltRepeatKey(0)
    expect(altRepeatKey.enabled).toBe(true)
    expect(altRepeatKey.lastKey).not.toBe(0)
    expect(altRepeatKey.altKey).not.toBe(0)
  })

  it('qmkSettingsQuery yields a non-empty ascending qsid list (not the all-0xFF placeholder)', async () => {
    const result = await qmkSettingsQuery(0)
    expect(result).toHaveLength(MSG_LEN)
    expect(result.every((b) => b === 0xff)).toBe(false)
    // First entry (LE16) should be qsid 1 (grave_esc_override).
    expect(result[0] | (result[1] << 8)).toBe(1)
  })

  it('qmkSettingsGet/qmkSettingsSet/qmkSettingsReset round-trip a known default (qsid 7 = tapping_term)', async () => {
    const before = await qmkSettingsGet(7)
    expect(before[0] | (before[1] << 8)).toBe(200)

    await qmkSettingsSet(7, [44, 1]) // 300 LE16
    const after = await qmkSettingsGet(7)
    expect(after[0] | (after[1] << 8)).toBe(300)

    await qmkSettingsReset()
    const reset = await qmkSettingsGet(7)
    expect(reset[0] | (reset[1] << 8)).toBe(200)
  })

  it('getVialRGBInfo/getVialRGBMode/getVialRGBSupported parse cleanly', async () => {
    const info = await getVialRGBInfo()
    expect(info.version).toBe(1)
    expect(info.maxBrightness).toBe(255)

    const mode = await getVialRGBMode()
    expect(typeof mode.mode).toBe('number')
    expect(typeof mode.speed).toBe('number')
    expect(typeof mode.hue).toBe('number')
    expect(typeof mode.sat).toBe('number')
    expect(typeof mode.val).toBe('number')

    // Effect 0 (off) and the recorded pages: 2..16, then 17..26.
    const supported = await getVialRGBSupported()
    expect([...supported].sort((a, b) => a - b)).toEqual([0, ...Array.from({ length: 25 }, (_, i) => i + 2)])
  })

  it('unlocks via unlockStart + unlockPoll while the combo is held', async () => {
    await unlockStart()

    let result: number[] = []
    for (let attempt = 0; attempt < 3 && result[0] !== 1; attempt++) {
      result = await unlockPoll()
    }
    expect(result[0]).toBe(1)

    const status = await getUnlockStatus()
    expect(status.unlocked).toBe(true)
  })

  it('sent exactly the recorded reports up to the unlock', () => {
    const unlocked = events.findIndex((event) => event.op === 'state' && (event as { expected?: { unlocked?: boolean } }).expected?.unlocked === true)
    const reportsBefore = events.slice(0, unlocked).filter((event) => event.op === 'report').length
    expect(replay.next).toBe(reportsBefore)
  })
})
