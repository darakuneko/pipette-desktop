// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the Rust port of the virtual keyboard
// (src-tauri/crates/pipette-virtual-device). Writes three files:
//
// - data/default_dataset.rs  — the default keymap, sample macros and sample
//   dynamic entries as resolved by the TypeScript keycode tables, plus the
//   few named keycodes the Rust side and its tests need. The Rust crate has
//   no keycode table of its own.
// - data/definition.lzma     — the LZMA-alone compressed keyboard definition
//   exactly as the TypeScript device serves it.
// - tests/fixtures/transcript.json — a golden transcript: every report the
//   real preload protocol parsers (src/preload/protocol.ts) send to the
//   TypeScript virtual device, with the response and the injected clock, plus
//   the controller operations (open/close/reset/key presses) in between.
//
// The clock is fixed and only advanced explicitly, so every run produces
// byte-identical output.
//
// Run: pnpm run generate:virtual-device-fixtures

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as lzmaModule from 'lzma'

const rec = vi.hoisted(() => ({
  events: [] as Record<string, unknown>[],
  clock: 0,
}))

function toHex(bytes: ArrayLike<number>): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

// Every report the protocol layer sends goes through here: the clock is
// pinned for the duration of the call so the device's Date.now() is
// deterministic, and the request/response pair is recorded.
vi.mock('../../src/preload/hid-transport', () => ({
  sendReceive: async (data: Uint8Array): Promise<Uint8Array> => {
    const { handleVirtualReport } = await import('../../src/main/virtual-device')
    vi.setSystemTime(rec.clock)
    const request = Array.from(data)
    const response = handleVirtualReport(request)
    rec.events.push({ op: 'report', now: rec.clock, request: toHex(request), response: toHex(response) })
    return Uint8Array.from(response)
  },
  send: async (): Promise<void> => {
    throw new Error('send() is not used by the recorded flow')
  },
}))

import { MSG_LEN, BUFFER_FETCH_CHUNK } from '../../src/shared/constants/protocol'
import { sendReceive } from '../../src/preload/hid-transport'
import * as protocol from '../../src/preload/protocol'
import {
  openVirtualDevice,
  closeVirtualDevice,
  getVirtualDeviceController,
} from '../../src/main/virtual-device'
import {
  LAYERS,
  ROWS,
  COLS,
  MACRO_BUFFER_SIZE,
  VIALRGB_SUPPORTED_EFFECTS,
  VIRTUAL_DEVICE_UNLOCK_COMBO,
  buildDefaultKeymap,
  buildDefaultMacroBuffer,
  buildSampleTapDance,
  buildSampleCombo,
  buildSampleKeyOverride,
  buildSampleAltRepeatKey,
  getCompressedDefinition,
} from '../../src/main/virtual-device/gpk60-63r'
import { SUPPORTED_QSIDS } from '../../src/main/virtual-device/qmk-settings'
import { setProtocolValue } from '../../src/shared/keycodes/keycodes'
import { resolve as resolveKeycode } from '../../src/shared/keycodes/keycodes-utils'

const here = dirname(fileURLToPath(import.meta.url))
const crateDir = resolve(here, '../../src-tauri/crates/pipette-virtual-device')

/** Arbitrary fixed epoch (ms) the transcript clock starts from. */
const CLOCK_START = 1_700_000_000_000

/** Named keycodes exported to Rust, resolved at Vial protocol 6. */
const EXPORTED_KEYCODES = [
  'QK_BOOT',
  'QK_LAYER_TAP',
  'USER00',
  'KC_A',
  'KC_C',
  'KC_V',
  'KC_J',
  'KC_K',
  'KC_ESCAPE',
  'KC_SPACE',
  'KC_BSPACE',
  'KC_DELETE',
  'KC_LCTRL',
  'MOD_LSFT',
] as const

// --- Controller wrapper: every operation is recorded before it runs. ---

const controller = getVirtualDeviceController()

const ctl = {
  open: async (): Promise<void> => {
    rec.events.push({ op: 'open' })
    await openVirtualDevice()
  },
  close: (): void => {
    rec.events.push({ op: 'close' })
    closeVirtualDevice()
  },
  reset: (): void => {
    rec.events.push({ op: 'reset' })
    controller.reset()
  },
  pressKey: (row: number, col: number): void => {
    rec.events.push({ op: 'pressKey', row, col })
    controller.pressKey(row, col)
  },
  releaseKey: (row: number, col: number): void => {
    rec.events.push({ op: 'releaseKey', row, col })
    controller.releaseKey(row, col)
  },
  releaseAll: (): void => {
    rec.events.push({ op: 'releaseAll' })
    controller.releaseAll()
  },
  holdKeys: (pairs: [number, number][]): void => {
    rec.events.push({ op: 'holdKeys', pairs })
    controller.holdKeys(pairs)
  },
  setUnlockCounterMax: (n: number): void => {
    rec.events.push({ op: 'setUnlockCounterMax', value: n })
    controller.setUnlockCounterMax(n)
  },
  /** Record the controller-visible state so the replay can assert it too. */
  checkState: (): void => {
    rec.events.push({ op: 'state', expected: controller.getState() })
  },
  advance: (ms: number): void => {
    rec.clock += ms
  },
}

/** Send a raw request (zero-padded) through the recorded transport. */
async function raw(...bytes: number[]): Promise<Uint8Array> {
  const pkt = new Uint8Array(MSG_LEN)
  pkt.set(bytes.slice(0, MSG_LEN))
  return sendReceive(pkt)
}

function decompressLzma(bytes: Uint8Array): Promise<string> {
  return new Promise((done, fail) => {
    lzmaModule.decompress(Array.from(bytes), (result: string | number[] | null, error?: unknown) => {
      if (error || typeof result !== 'string') fail(error ?? new Error('LZMA decompression failed'))
      else done(result)
    })
  })
}

// --- Flows ---

/** The flow of src/preload/__tests__/protocol-virtual-device.test.ts, in order. */
async function recordProtocolTestFlow(): Promise<void> {
  expect(await protocol.getProtocolVersion()).toBe(9)
  expect((await protocol.getKeyboardId()).vialProtocol).toBe(6)
  expect(await protocol.getLayerCount()).toBe(LAYERS)
  await protocol.getKeymapBuffer(0, 28)
  expect((await protocol.getUnlockStatus()).keys).toEqual(VIRTUAL_DEVICE_UNLOCK_COMBO)

  const size = await protocol.getDefinitionSize()
  const definition = await protocol.getDefinitionRaw(size)
  expect(JSON.parse(await decompressLzma(definition)).name).toBe('Virtual Keyboard')

  expect(await protocol.getDynamicEntryCount()).toEqual({
    tapDance: 32,
    combo: 32,
    keyOverride: 32,
    altRepeatKey: 32,
    featureFlags: 0x03,
  })
  await protocol.getTapDance(0)
  await protocol.getCombo(0)
  await protocol.getKeyOverride(0)
  await protocol.getAltRepeatKey(0)

  await protocol.qmkSettingsQuery(0)
  await protocol.qmkSettingsGet(7)
  await protocol.qmkSettingsSet(7, [44, 1])
  await protocol.qmkSettingsGet(7)
  await protocol.qmkSettingsReset()
  await protocol.qmkSettingsGet(7)

  await protocol.getVialRGBInfo()
  await protocol.getVialRGBMode()
  expect((await protocol.getVialRGBSupported()).size).toBe(VIALRGB_SUPPORTED_EFFECTS.length)

  ctl.reset()
  ctl.holdKeys(VIRTUAL_DEVICE_UNLOCK_COMBO as [number, number][])
  ctl.setUnlockCounterMax(2)
  await protocol.unlockStart()
  let result: number[] = []
  for (let attempt = 0; attempt < 3 && result[0] !== 1; attempt++) {
    ctl.advance(120)
    result = await protocol.unlockPoll()
  }
  expect(result[0]).toBe(1)
  expect((await protocol.getUnlockStatus()).unlocked).toBe(true)
  ctl.releaseAll()
  ctl.checkState()
}

/** Full reads of every buffer plus writes and read-backs of every store. */
async function recordReadWriteFlow(): Promise<void> {
  const keymapBytes = LAYERS * ROWS * COLS * 2
  for (let offset = 0; offset < keymapBytes; offset += BUFFER_FETCH_CHUNK) {
    await protocol.getKeymapBuffer(offset, Math.min(BUFFER_FETCH_CHUNK, keymapBytes - offset))
  }
  // Odd offset and a range running past the end of the keymap.
  await protocol.getKeymapBuffer(5, 10)
  await protocol.getKeymapBuffer(keymapBytes - 6, 20)

  expect(await protocol.getMacroCount()).toBe(16)
  expect(await protocol.getMacroBufferSize()).toBe(MACRO_BUFFER_SIZE)
  await protocol.getMacroBuffer(MACRO_BUFFER_SIZE)

  // Keymap writes (unlocked from the previous flow): QK_BOOT is stored as is.
  const qkBoot = resolveKeycode('QK_BOOT')
  await protocol.setKeycode(0, 1, 2, 0x1234)
  await raw(0x04, 0, 1, 2)
  await protocol.setKeycode(2, 0, 0, qkBoot)
  await raw(0x04, 2, 0, 0)
  // Out-of-range position: write ignored, read yields KC_NO.
  await protocol.setKeycode(LAYERS, 0, 0, 0x0004)
  await raw(0x04, LAYERS, 0, 0)
  await raw(0x04, 0, ROWS, COLS)

  await protocol.getLayoutOptions()
  await protocol.setLayoutOptions(0xabcd1234)
  expect(await protocol.getLayoutOptions()).toBe(0xabcd1234)

  // Matrix tester while unlocked.
  ctl.pressKey(0, 0)
  ctl.pressKey(0, 13)
  ctl.pressKey(4, 11)
  await protocol.getMatrixState()
  ctl.releaseKey(0, 13)
  await protocol.getMatrixState()
  ctl.releaseAll()

  // Macro buffer write (two chunks) and read-back.
  const macro = Array.from({ length: 40 }, (_, i) => (i * 7 + 3) & 0xff)
  await protocol.setMacroBuffer(macro)
  await protocol.getMacroBuffer(MACRO_BUFFER_SIZE)
  // Write past the end of the buffer is clipped.
  await raw(0x0f, (MACRO_BUFFER_SIZE - 2) >> 8, (MACRO_BUFFER_SIZE - 2) & 0xff, 4, 1, 2, 3, 4)
  await raw(0x0e, (MACRO_BUFFER_SIZE - 4) >> 8, (MACRO_BUFFER_SIZE - 4) & 0xff, 8)

  // Dynamic entries: write, read back, out-of-range get/set.
  await protocol.setTapDance(1, { onTap: 4, onHold: 0xe0, onDoubleTap: 0x1234, onTapHold: qkBoot, tappingTerm: 175 })
  await protocol.getTapDance(1)
  await protocol.setCombo(1, { key1: 0x0d, key2: 0x0e, key3: 0, key4: 0, output: qkBoot })
  await protocol.getCombo(1)
  await protocol.setKeyOverride(1, {
    triggerKey: 0x2a,
    replacementKey: qkBoot,
    layers: 0x00f0,
    triggerMods: 0x02,
    negativeMods: 0x10,
    suppressedMods: 0x02,
    options: 0x05,
    enabled: true,
  })
  await protocol.getKeyOverride(1)
  await protocol.setAltRepeatKey(1, { lastKey: qkBoot, altKey: 0x19, allowedMods: 0x04, options: 0x03, enabled: true })
  await protocol.getAltRepeatKey(1)
  for (const sub of [0x01, 0x03, 0x05, 0x07]) {
    await raw(0xfe, 0x0d, sub, 32)
    await raw(0xfe, 0x0d, sub + 1, 32, 1, 2, 3, 4)
  }
  await raw(0xfe, 0x0d, 0x09, 0) // unknown dynamic-entry sub-op: echo

  // QMK settings: both query pages, every supported qsid, one unsupported.
  await protocol.qmkSettingsQuery(0)
  await protocol.qmkSettingsQuery(SUPPORTED_QSIDS[15])
  await raw(0xfe, 0x09, 0xff, 0xff)
  for (const qsid of SUPPORTED_QSIDS) {
    await protocol.qmkSettingsGet(qsid)
  }
  await raw(0xfe, 0x0a, 0x08, 0x00)
  await raw(0xfe, 0x0b, 0x08, 0x00, 1, 2, 3, 4)
  await protocol.qmkSettingsSet(1, [0x0f])
  await protocol.qmkSettingsSet(21, [0x81, 0x00, 0x01, 0x80])
  await protocol.qmkSettingsSet(22, [1])
  await protocol.qmkSettingsSet(26, [1])
  await protocol.qmkSettingsSet(22, [0])
  for (const qsid of [1, 21, 22, 23, 24, 26]) {
    await protocol.qmkSettingsGet(qsid)
  }

  // Lighting.
  await protocol.setVialRGBMode(9, 111, 22, 33, 44)
  await protocol.getVialRGBMode()
  await protocol.saveLighting()
  await raw(0x08, 0x99) // unknown lighting sub-command: echo
  await raw(0x07, 0x99, 1, 2, 3)
  await raw(0x08, 0x42, 0x0a, 0x00) // VialRGB get-supported starting past effect 10

  // Unsupported commands echo.
  await protocol.getEncoder(0, 1)
  await raw(0xfe, 0x04, 0, 1, 0, 0x12, 0x34)
  await raw(0x99, 1, 2, 3)
  await raw(0xfe, 0x7f)

  // Definition blocks past the end of the compressed bytes are zero.
  await raw(0xfe, 0x02, 0xff, 0x00, 0x00, 0x00)
  await raw(0xfe, 0x02, 0xff, 0xff, 0xff, 0xff)
}

/** Lock, QK_BOOT firewall while locked, and the unlock poll edge cases. */
async function recordLockFlow(): Promise<void> {
  const qkBoot = resolveKeycode('QK_BOOT')
  await protocol.lock()
  await protocol.getUnlockStatus()
  // Matrix request while locked echoes the request.
  ctl.pressKey(1, 1)
  await protocol.getMatrixState()
  ctl.releaseAll()

  await protocol.setKeycode(2, 2, 12, qkBoot)
  await raw(0x04, 2, 2, 12)
  await protocol.setTapDance(2, { onTap: qkBoot, onHold: qkBoot, onDoubleTap: qkBoot, onTapHold: qkBoot, tappingTerm: 200 })
  await protocol.getTapDance(2)
  await protocol.setCombo(2, { key1: qkBoot, key2: 2, key3: 0, key4: 0, output: qkBoot })
  await protocol.getCombo(2)
  await protocol.setKeyOverride(2, {
    triggerKey: qkBoot,
    replacementKey: qkBoot,
    layers: 0,
    triggerMods: 0,
    negativeMods: 0,
    suppressedMods: 0,
    options: 0,
    enabled: true,
  })
  await protocol.getKeyOverride(2)
  await protocol.setAltRepeatKey(2, { lastKey: qkBoot, altKey: qkBoot, allowedMods: 0, options: 0, enabled: true })
  await protocol.getAltRepeatKey(2)

  // Poll without a sequence in progress: no change.
  ctl.holdKeys([[0, 0], [0, 1]])
  ctl.advance(500)
  await protocol.unlockPoll()

  // Start with counter max 3; one qualifying tick, then a too-fast poll resets.
  ctl.setUnlockCounterMax(3)
  await protocol.unlockStart()
  ctl.advance(150)
  await protocol.unlockPoll()
  ctl.advance(40)
  await protocol.unlockPoll()
  // Release mid-sequence resets; re-press must not reuse stale progress.
  ctl.advance(150)
  await protocol.unlockPoll()
  ctl.releaseKey(0, 1)
  ctl.advance(150)
  await protocol.unlockPoll()
  ctl.pressKey(0, 1)
  ctl.advance(50)
  await protocol.unlockPoll()
  ctl.checkState()
  // Clamp an in-progress countdown.
  ctl.setUnlockCounterMax(1)
  ctl.checkState()
  ctl.advance(150)
  await protocol.unlockPoll()
  await protocol.getUnlockStatus()
  ctl.checkState()

  // The 100 ms gate boundary: 99 ms resets, exactly 100 ms counts.
  await protocol.lock()
  ctl.setUnlockCounterMax(3)
  await protocol.unlockStart()
  ctl.advance(99)
  await protocol.unlockPoll()
  ctl.advance(1)
  await protocol.unlockPoll()
  ctl.advance(100)
  await protocol.unlockPoll()
  ctl.advance(100)
  await protocol.unlockPoll()
  ctl.advance(100)
  await protocol.unlockPoll()
  ctl.checkState()
  ctl.releaseAll()
}

/** State survives close/open; reset() restores factory defaults. */
async function recordPersistenceFlow(): Promise<void> {
  await protocol.setKeycode(1, 2, 3, 0x0029)
  await protocol.setLayoutOptions(0x00000005)
  await protocol.setVialRGBMode(4, 1, 2, 3, 4)
  await protocol.qmkSettingsSet(7, [0x2c, 0x01])
  ctl.close()
  ctl.checkState()
  await ctl.open()
  ctl.checkState()
  await raw(0x04, 1, 2, 3)
  await protocol.getKeymapBuffer(((1 * ROWS + 2) * COLS + 3) * 2, 2)
  await protocol.getLayoutOptions()
  await protocol.getVialRGBMode()
  await protocol.qmkSettingsGet(7)
  await protocol.getUnlockStatus()
  await protocol.getTapDance(1)
  await protocol.getMacroBuffer(56)

  ctl.reset()
  ctl.checkState()
  await raw(0x04, 1, 2, 3)
  await raw(0x04, 0, 1, 2)
  await protocol.getLayoutOptions()
  await protocol.getVialRGBMode()
  await protocol.qmkSettingsGet(7)
  await protocol.getUnlockStatus()
  await protocol.getTapDance(1)
  await protocol.getMacroBuffer(56)
  ctl.close()
}

// --- Output ---

function hex16(v: number): string {
  return `0x${v.toString(16).padStart(4, '0')}`
}

function hex8(v: number): string {
  return `0x${v.toString(16).padStart(2, '0')}`
}

function rustArray(values: number[], fmt: (v: number) => string, perLine: number): string {
  const lines: string[] = []
  for (let i = 0; i < values.length; i += perLine) {
    lines.push(`    ${values.slice(i, i + perLine).map(fmt).join(', ')},`)
  }
  return lines.join('\n')
}

function buildDatasetSource(): string {
  setProtocolValue(6)
  const keymap = Array.from(buildDefaultKeymap())
  const macro = Array.from(buildDefaultMacroBuffer())
  let macroLen = macro.length
  while (macroLen > 0 && macro[macroLen - 1] === 0) macroLen--
  // Keep the last terminator: the head ends with macro 1's NUL.
  const macroHead = macro.slice(0, macroLen + 1)
  const td = buildSampleTapDance()
  const combo = buildSampleCombo()
  const ko = buildSampleKeyOverride()
  const ar = buildSampleAltRepeatKey()
  setProtocolValue(6)
  const keycodes = EXPORTED_KEYCODES.map((name) => `    pub const ${name}: u16 = ${hex16(resolveKeycode(name))};`)

  return `// SPDX-License-Identifier: GPL-2.0-or-later
// Generated by scripts/virtual-device-fixtures/record-virtual-device-fixtures.test.ts
// (pnpm run generate:virtual-device-fixtures). Do not edit by hand.
//
// Default dataset of the virtual keyboard, resolved by the TypeScript keycode
// tables at Vial protocol 6. Included by src/dataset.rs.

/// Flat keymap, layer-major then row-major then column (${LAYERS} x ${ROWS} x ${COLS}).
pub const DEFAULT_KEYMAP: [u16; ${keymap.length}] = [
${rustArray(keymap, hex16, 14)}
];

/// Leading bytes of the default macro buffer; the rest of the buffer is zero.
pub const DEFAULT_MACRO_BUFFER_HEAD: [u8; ${macroHead.length}] = [
${rustArray(macroHead, hex8, 16)}
];

pub const SAMPLE_TAP_DANCE: TapDanceEntry = TapDanceEntry {
    on_tap: ${hex16(td.onTap)},
    on_hold: ${hex16(td.onHold)},
    on_double_tap: ${hex16(td.onDoubleTap)},
    on_tap_hold: ${hex16(td.onTapHold)},
    tapping_term: ${td.tappingTerm},
};

pub const SAMPLE_COMBO: ComboEntry = ComboEntry {
    key1: ${hex16(combo.key1)},
    key2: ${hex16(combo.key2)},
    key3: ${hex16(combo.key3)},
    key4: ${hex16(combo.key4)},
    output: ${hex16(combo.output)},
};

pub const SAMPLE_KEY_OVERRIDE: KeyOverrideEntry = KeyOverrideEntry {
    trigger_key: ${hex16(ko.triggerKey)},
    replacement_key: ${hex16(ko.replacementKey)},
    layers: ${hex16(ko.layers)},
    trigger_mods: ${hex8(ko.triggerMods)},
    negative_mods: ${hex8(ko.negativeMods)},
    suppressed_mods: ${hex8(ko.suppressedMods)},
    options: ${hex8(ko.options)},
    enabled: ${ko.enabled},
};

pub const SAMPLE_ALT_REPEAT_KEY: AltRepeatKeyEntry = AltRepeatKeyEntry {
    last_key: ${hex16(ar.lastKey)},
    alt_key: ${hex16(ar.altKey)},
    allowed_mods: ${hex8(ar.allowedMods)},
    options: ${hex8(ar.options)},
    enabled: ${ar.enabled},
};

/// Named keycode values (Vial protocol 6) used by the device and its tests.
pub mod keycodes {
${keycodes.join('\n')}
}
`
}

function buildTranscriptJson(): string {
  const body = rec.events.map((e) => `    ${JSON.stringify(e)}`).join(',\n')
  return `{\n  "clockStart": ${CLOCK_START},\n  "events": [\n${body}\n  ]\n}\n`
}

function writeOut(relPath: string, content: string | Uint8Array): void {
  const path = resolve(crateDir, relPath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  rec.clock = CLOCK_START
  rec.events.length = 0
})

afterAll(() => {
  closeVirtualDevice()
  vi.useRealTimers()
})

describe('virtual device fixtures', () => {
  it('records the golden transcript and dumps the dataset', async () => {
    ctl.reset()
    await ctl.open()
    ctl.checkState()

    await recordProtocolTestFlow()
    await recordReadWriteFlow()
    await recordLockFlow()
    await recordPersistenceFlow()

    const reports = rec.events.filter((e) => e.op === 'report').length
    expect(reports).toBeGreaterThan(100)

    writeOut('data/default_dataset.rs', buildDatasetSource())
    writeOut('data/definition.lzma', await getCompressedDefinition())
    writeOut('tests/fixtures/transcript.json', buildTranscriptJson())
  })
})
