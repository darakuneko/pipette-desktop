// SPDX-License-Identifier: GPL-2.0-or-later

import { vi, describe, it, expect, beforeEach } from 'vitest'
import type { Mock } from 'vitest'

// Mock protocol module
vi.mock('../protocol', () => ({
  getProtocolVersion: vi.fn(),
  getKeyboardId: vi.fn(),
  getDefinitionSize: vi.fn(),
  getDefinitionRaw: vi.fn(),
  getLayerCount: vi.fn(),
  getMacroCount: vi.fn(),
  getMacroBufferSize: vi.fn(),
  getLayoutOptions: vi.fn(),
  getDynamicEntryCount: vi.fn(),
  getKeymapBuffer: vi.fn(),
  getEncoder: vi.fn(),
  getMacroBuffer: vi.fn(),
  getUnlockStatus: vi.fn(),
  getTapDance: vi.fn(),
  getCombo: vi.fn(),
  getKeyOverride: vi.fn(),
  getAltRepeatKey: vi.fn(),
  setKeycode: vi.fn(),
  setEncoder: vi.fn(),
  setMacroBuffer: vi.fn(),
  setLayoutOptions: vi.fn(),
  setTapDance: vi.fn(),
  setCombo: vi.fn(),
  setKeyOverride: vi.fn(),
  setAltRepeatKey: vi.fn(),
}))

// Mock LZMA
vi.mock('lzma', () => ({
  default: {
    decompress: vi.fn(),
  },
}))

import * as protocol from '../protocol'
import LZMA from 'lzma'
import { Keyboard } from '../keyboard'
import type {
  TapDanceEntry,
  ComboEntry,
  KeyOverrideEntry,
  AltRepeatKeyEntry,
} from '../../shared/types/protocol'
import { BUFFER_FETCH_CHUNK } from '../../shared/constants/protocol'

// Helper: build a mock definition JSON string for LZMA decompression
function mockDefinitionJson(opts?: {
  rows?: number
  cols?: number
  encoderKeys?: number
  name?: string
}): string {
  const rows = opts?.rows ?? 2
  const cols = opts?.cols ?? 2
  const name = opts?.name ?? 'Test KB'
  // Build a keymap layout. If encoderKeys > 0, add encoder objects (e property).
  // Each encoder takes 2 entries (CW + CCW) in the KLE format.
  const keymapRow: unknown[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      keymapRow.push(`${r},${c}`)
    }
  }
  // Add encoder entries if requested
  const encoderCount = opts?.encoderKeys ?? 0
  for (let i = 0; i < encoderCount * 2; i++) {
    keymapRow.push({ e: Math.floor(i / 2) })
  }
  return JSON.stringify({
    name,
    matrix: { rows, cols },
    layouts: { keymap: [keymapRow] },
  })
}

// Helper: set up all protocol mocks for a standard reload sequence
function setupReloadMocks(opts?: {
  vialProtocol?: number
  viaProtocol?: number
  layers?: number
  rows?: number
  cols?: number
  macroCount?: number
  macroBufferSize?: number
  encoderCount?: number
  uid?: string
  tapDanceCount?: number
  comboCount?: number
  keyOverrideCount?: number
  altRepeatKeyCount?: number
}): void {
  const vialProtocol = opts?.vialProtocol ?? 5
  const viaProtocol = opts?.viaProtocol ?? 9
  const layers = opts?.layers ?? 2
  const rows = opts?.rows ?? 2
  const cols = opts?.cols ?? 2
  const macroCount = opts?.macroCount ?? 2
  const macroBufferSize = opts?.macroBufferSize ?? 64
  const encoderCount = opts?.encoderCount ?? 0
  const uid = opts?.uid ?? '0xabcdef1234567890'
  const tapDanceCount = opts?.tapDanceCount ?? 0
  const comboCount = opts?.comboCount ?? 0
  const keyOverrideCount = opts?.keyOverrideCount ?? 0
  const altRepeatKeyCount = opts?.altRepeatKeyCount ?? 0

  ;(protocol.getProtocolVersion as Mock).mockResolvedValue(viaProtocol)
  ;(protocol.getKeyboardId as Mock).mockResolvedValue({
    vialProtocol,
    uid,
  })
  ;(protocol.getDefinitionSize as Mock).mockResolvedValue(100)
  ;(protocol.getDefinitionRaw as Mock).mockResolvedValue(new Uint8Array(100))
  ;(protocol.getLayerCount as Mock).mockResolvedValue(layers)
  ;(protocol.getMacroCount as Mock).mockResolvedValue(macroCount)
  ;(protocol.getMacroBufferSize as Mock).mockResolvedValue(macroBufferSize)
  ;(protocol.getLayoutOptions as Mock).mockResolvedValue(0)

  // LZMA decompress mock
  ;(LZMA.decompress as Mock).mockImplementation(
    (_input: number[], callback: (result: string | null) => void) => {
      callback(
        mockDefinitionJson({
          rows,
          cols,
          encoderKeys: encoderCount,
        }),
      )
    },
  )

  // Dynamic entry counts (only relevant for vialProtocol >= 4)
  ;(protocol.getDynamicEntryCount as Mock).mockResolvedValue({
    tapDance: tapDanceCount,
    combo: comboCount,
    keyOverride: keyOverrideCount,
    altRepeatKey: altRepeatKeyCount,
    featureFlags: 0,
  })

  // Keymap buffer mock: returns big-endian u16 keycodes
  // We generate keycodes as (layer * 100 + row * 10 + col) for deterministic testing
  ;(protocol.getKeymapBuffer as Mock).mockImplementation(
    (offset: number, size: number) => {
      const totalCells = layers * rows * cols
      const result: number[] = []
      for (let i = 0; i < size; i++) {
        const byteIndex = offset + i
        const cellIndex = Math.floor(byteIndex / 2)
        if (cellIndex < totalCells) {
          const layer = Math.floor(cellIndex / (rows * cols))
          const remainder = cellIndex % (rows * cols)
          const row = Math.floor(remainder / cols)
          const col = remainder % cols
          const keycode = layer * 100 + row * 10 + col
          if (byteIndex % 2 === 0) {
            // High byte (big-endian)
            result.push((keycode >> 8) & 0xff)
          } else {
            // Low byte (big-endian)
            result.push(keycode & 0xff)
          }
        } else {
          result.push(0)
        }
      }
      return Promise.resolve(result)
    },
  )

  // Encoder mock: returns [cw, ccw] pair
  ;(protocol.getEncoder as Mock).mockImplementation(
    (layer: number, idx: number) => {
      const cw = layer * 1000 + idx * 10 + 1
      const ccw = layer * 1000 + idx * 10 + 2
      return Promise.resolve([cw, ccw])
    },
  )

  // Macro buffer mock: simple buffer with NUL-separated empty macros
  const macroBuffer = new Array(macroBufferSize).fill(0)
  ;(protocol.getMacroBuffer as Mock).mockResolvedValue(macroBuffer)

  // Unlock status mock
  ;(protocol.getUnlockStatus as Mock).mockResolvedValue({
    unlocked: true,
    inProgress: false,
    keys: [],
  })

  // Dynamic entry mocks
  ;(protocol.getTapDance as Mock).mockImplementation((index: number) =>
    Promise.resolve({
      onTap: index + 1,
      onHold: index + 2,
      onDoubleTap: index + 3,
      onTapHold: index + 4,
      tappingTerm: 200,
    }),
  )
  ;(protocol.getCombo as Mock).mockImplementation((index: number) =>
    Promise.resolve({
      key1: index + 10,
      key2: index + 20,
      key3: 0,
      key4: 0,
      output: index + 30,
    }),
  )
  ;(protocol.getKeyOverride as Mock).mockImplementation((index: number) =>
    Promise.resolve({
      triggerKey: index + 100,
      replacementKey: index + 200,
      layers: 0xffff,
      triggerMods: 0x01,
      negativeMods: 0,
      suppressedMods: 0,
      options: 0x03,
      enabled: true,
    }),
  )
  ;(protocol.getAltRepeatKey as Mock).mockImplementation((index: number) =>
    Promise.resolve({
      lastKey: index + 50,
      altKey: index + 60,
      allowedMods: 0xff,
      options: 0x01,
      enabled: true,
    }),
  )

  // Set* protocol mocks resolve immediately
  ;(protocol.setKeycode as Mock).mockResolvedValue(undefined)
  ;(protocol.setEncoder as Mock).mockResolvedValue(undefined)
  ;(protocol.setMacroBuffer as Mock).mockResolvedValue(undefined)
  ;(protocol.setLayoutOptions as Mock).mockResolvedValue(undefined)
  ;(protocol.setTapDance as Mock).mockResolvedValue(undefined)
  ;(protocol.setCombo as Mock).mockResolvedValue(undefined)
  ;(protocol.setKeyOverride as Mock).mockResolvedValue(undefined)
  ;(protocol.setAltRepeatKey as Mock).mockResolvedValue(undefined)
}

describe('Keyboard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ----------------------------------------------------------------
  // 1. Default state
  // ----------------------------------------------------------------
  describe('default state', () => {
    it('has correct initial values on construction', () => {
      const kb = new Keyboard()
      expect(kb.state.viaProtocol).toBe(-1)
      expect(kb.state.vialProtocol).toBe(-1)
      expect(kb.state.layers).toBe(0)
      expect(kb.state.rows).toBe(0)
      expect(kb.state.cols).toBe(0)
      expect(kb.state.keymap).toBeInstanceOf(Map)
      expect(kb.state.keymap.size).toBe(0)
      expect(kb.state.encoderLayout).toBeInstanceOf(Map)
      expect(kb.state.encoderLayout.size).toBe(0)
      expect(kb.state.encoderCount).toBe(0)
      expect(kb.state.layoutOptions).toBe(-1)
      expect(kb.state.macroCount).toBe(0)
      expect(kb.state.macroBufferSize).toBe(0)
      expect(kb.state.macros).toEqual([])
      expect(kb.state.definition).toBeNull()
      expect(kb.state.definitionRaw).toBeNull()
      expect(kb.state.dynamicCounts).toEqual({
        tapDance: 0,
        combo: 0,
        keyOverride: 0,
        altRepeatKey: 0,
        featureFlags: 0,
      })
      expect(kb.state.tapDanceEntries).toEqual([])
      expect(kb.state.comboEntries).toEqual([])
      expect(kb.state.keyOverrideEntries).toEqual([])
      expect(kb.state.altRepeatKeyEntries).toEqual([])
      expect(kb.state.unlockStatus).toEqual({
        unlocked: false,
        inProgress: false,
        keys: [],
      })
      expect(kb.state.supportedFeatures).toBeInstanceOf(Set)
      expect(kb.state.supportedFeatures.size).toBe(0)
      expect(kb.state.keyboardId).toEqual({ vialProtocol: -1, uid: '0x0' })
    })
  })

  // ----------------------------------------------------------------
  // 2. getKey / getEncoderKeycode (sync, no mocks needed)
  // ----------------------------------------------------------------
  describe('getKey', () => {
    it('returns value from keymap Map when set', () => {
      const kb = new Keyboard()
      kb.state.keymap.set('1,2,3', 0x0041)
      expect(kb.getKey(1, 2, 3)).toBe(0x0041)
    })

    it('returns 0 for unset key', () => {
      const kb = new Keyboard()
      expect(kb.getKey(0, 0, 0)).toBe(0)
    })

    it('returns 0 when different key is set', () => {
      const kb = new Keyboard()
      kb.state.keymap.set('0,0,0', 0x0041)
      expect(kb.getKey(0, 0, 1)).toBe(0)
    })
  })

  describe('getEncoderKeycode', () => {
    it('returns value from encoderLayout Map when set', () => {
      const kb = new Keyboard()
      kb.state.encoderLayout.set('0,1,0', 0x1234)
      expect(kb.getEncoderKeycode(0, 1, 0)).toBe(0x1234)
    })

    it('returns 0 for unset encoder keycode', () => {
      const kb = new Keyboard()
      expect(kb.getEncoderKeycode(0, 0, 0)).toBe(0)
    })

    it('distinguishes between CW (dir=0) and CCW (dir=1)', () => {
      const kb = new Keyboard()
      kb.state.encoderLayout.set('0,0,0', 0xaaaa)
      kb.state.encoderLayout.set('0,0,1', 0xbbbb)
      expect(kb.getEncoderKeycode(0, 0, 0)).toBe(0xaaaa)
      expect(kb.getEncoderKeycode(0, 0, 1)).toBe(0xbbbb)
    })
  })

  // ----------------------------------------------------------------
  // 3. saveLayout
  // ----------------------------------------------------------------
  describe('saveLayout', () => {
    it('exports current layout as a serializable object with all fields', () => {
      const kb = new Keyboard()
      kb.state.layers = 2
      kb.state.rows = 2
      kb.state.cols = 2
      kb.state.encoderCount = 1
      kb.state.vialProtocol = 5
      kb.state.viaProtocol = 9
      kb.state.layoutOptions = 3
      kb.state.keyboardId = { vialProtocol: 5, uid: '0xdeadbeef' }
      kb.state.macros = [[{ type: 'text', text: 'hello' }]]
      kb.state.tapDanceEntries = [
        { onTap: 1, onHold: 2, onDoubleTap: 3, onTapHold: 4, tappingTerm: 200 },
      ]
      kb.state.comboEntries = [{ key1: 10, key2: 20, key3: 0, key4: 0, output: 30 }]
      kb.state.keyOverrideEntries = []
      kb.state.altRepeatKeyEntries = []

      // Set some keymap entries
      kb.state.keymap.set('0,0,0', 0x0004) // layer 0, row 0, col 0
      kb.state.keymap.set('0,0,1', 0x0005) // layer 0, row 0, col 1
      kb.state.keymap.set('0,1,0', 0x0006) // layer 0, row 1, col 0
      // Leave 0,1,1 unset -> should be -1

      // Layer 1 all unset
      // Set encoder layout
      kb.state.encoderLayout.set('0,0,0', 0x00e0) // layer 0, encoder 0, CW
      kb.state.encoderLayout.set('0,0,1', 0x00e1) // layer 0, encoder 0, CCW

      const saved = kb.saveLayout()

      expect(saved.version).toBe(1)
      expect(saved.uid).toBe('0xdeadbeef')
      expect(saved.vial_protocol).toBe(5)
      expect(saved.via_protocol).toBe(9)
      expect(saved.layout_options).toBe(3)
      expect(saved.macro).toEqual([[{ type: 'text', text: 'hello' }]])
      expect(saved.tap_dance).toEqual([
        { onTap: 1, onHold: 2, onDoubleTap: 3, onTapHold: 4, tappingTerm: 200 },
      ])
      expect(saved.combo).toEqual([{ key1: 10, key2: 20, key3: 0, key4: 0, output: 30 }])
      expect(saved.key_override).toEqual([])
      expect(saved.alt_repeat_key).toEqual([])

      // Verify layout array shape: [layers][rows][cols]
      const layout = saved.layout as number[][][]
      expect(layout).toHaveLength(2) // 2 layers
      expect(layout[0]).toHaveLength(2) // 2 rows
      expect(layout[0][0]).toHaveLength(2) // 2 cols
      expect(layout[0][0][0]).toBe(0x0004)
      expect(layout[0][0][1]).toBe(0x0005)
      expect(layout[0][1][0]).toBe(0x0006)
      expect(layout[0][1][1]).toBe(-1) // unset

      // Layer 1 all unset
      expect(layout[1][0][0]).toBe(-1)
      expect(layout[1][0][1]).toBe(-1)
      expect(layout[1][1][0]).toBe(-1)
      expect(layout[1][1][1]).toBe(-1)

      // Verify encoder layout: [layers][encoders][2]
      const encoderLayout = saved.encoder_layout as number[][][]
      expect(encoderLayout).toHaveLength(2) // 2 layers
      expect(encoderLayout[0]).toHaveLength(1) // 1 encoder
      expect(encoderLayout[0][0]).toEqual([0x00e0, 0x00e1])
      // Layer 1 encoder unset -> defaults to 0
      expect(encoderLayout[1][0]).toEqual([0, 0])
    })

    it('produces -1 for all unset keymap entries', () => {
      const kb = new Keyboard()
      kb.state.layers = 1
      kb.state.rows = 1
      kb.state.cols = 1
      kb.state.keyboardId = { vialProtocol: 5, uid: '0x0' }

      const saved = kb.saveLayout()
      const layout = saved.layout as number[][][]
      expect(layout[0][0][0]).toBe(-1)
    })

    it('exports empty arrays when no dynamic entries exist', () => {
      const kb = new Keyboard()
      kb.state.layers = 1
      kb.state.rows = 1
      kb.state.cols = 1
      kb.state.keyboardId = { vialProtocol: 5, uid: '0x0' }

      const saved = kb.saveLayout()
      expect(saved.tap_dance).toEqual([])
      expect(saved.combo).toEqual([])
      expect(saved.key_override).toEqual([])
      expect(saved.alt_repeat_key).toEqual([])
    })
  })

  // ----------------------------------------------------------------
  // 4. reload — full sequence
  // ----------------------------------------------------------------
  describe('reload', () => {
    it('performs full reload with vialProtocol >= VIAL_PROTOCOL_DYNAMIC', async () => {
      setupReloadMocks({
        vialProtocol: 5,
        layers: 2,
        rows: 2,
        cols: 2,
        tapDanceCount: 1,
        comboCount: 1,
        keyOverrideCount: 1,
        altRepeatKeyCount: 1,
      })

      const kb = new Keyboard()
      await kb.reload()

      // Protocol calls made
      expect(protocol.getProtocolVersion).toHaveBeenCalledTimes(1)
      expect(protocol.getKeyboardId).toHaveBeenCalledTimes(1)
      expect(protocol.getDefinitionSize).toHaveBeenCalledTimes(1)
      expect(protocol.getDefinitionRaw).toHaveBeenCalledTimes(1)
      expect(protocol.getLayerCount).toHaveBeenCalledTimes(1)
      expect(protocol.getMacroCount).toHaveBeenCalledTimes(1)
      expect(protocol.getMacroBufferSize).toHaveBeenCalledTimes(1)
      expect(protocol.getLayoutOptions).toHaveBeenCalledTimes(1)
      expect(protocol.getDynamicEntryCount).toHaveBeenCalledTimes(1)
      expect(protocol.getUnlockStatus).toHaveBeenCalledTimes(1)

      // Dynamic entries loaded
      expect(protocol.getTapDance).toHaveBeenCalledTimes(1)
      expect(protocol.getCombo).toHaveBeenCalledTimes(1)
      expect(protocol.getKeyOverride).toHaveBeenCalledTimes(1)
      expect(protocol.getAltRepeatKey).toHaveBeenCalledTimes(1)

      // State populated
      expect(kb.state.viaProtocol).toBe(9)
      expect(kb.state.vialProtocol).toBe(5)
      expect(kb.state.layers).toBe(2)
      expect(kb.state.rows).toBe(2)
      expect(kb.state.cols).toBe(2)
      expect(kb.state.definition).not.toBeNull()
      expect(kb.state.definition?.name).toBe('Test KB')
    })

    it('does not call getDynamicEntryCount when vialProtocol < VIAL_PROTOCOL_DYNAMIC', async () => {
      setupReloadMocks({
        vialProtocol: 3,
        layers: 1,
        rows: 1,
        cols: 1,
      })

      const kb = new Keyboard()
      await kb.reload()

      expect(protocol.getDynamicEntryCount).not.toHaveBeenCalled()
      expect(protocol.getTapDance).not.toHaveBeenCalled()
      expect(protocol.getCombo).not.toHaveBeenCalled()
      expect(protocol.getKeyOverride).not.toHaveBeenCalled()
      expect(protocol.getAltRepeatKey).not.toHaveBeenCalled()
      expect(kb.state.dynamicCounts).toEqual({
        tapDance: 0,
        combo: 0,
        keyOverride: 0,
        altRepeatKey: 0,
        featureFlags: 0,
      })
    })

    it('sets unlockStatus to always-unlocked for VIA-only (vialProtocol < 0)', async () => {
      setupReloadMocks({
        vialProtocol: -1,
        layers: 1,
        rows: 1,
        cols: 1,
      })

      const kb = new Keyboard()
      await kb.reload()

      expect(protocol.getUnlockStatus).not.toHaveBeenCalled()
      expect(kb.state.unlockStatus).toEqual({
        unlocked: true,
        inProgress: false,
        keys: [],
      })
    })

    it('sets rows and cols from definition after decompression', async () => {
      setupReloadMocks({
        vialProtocol: 5,
        layers: 1,
        rows: 4,
        cols: 6,
      })

      const kb = new Keyboard()
      await kb.reload()

      expect(kb.state.rows).toBe(4)
      expect(kb.state.cols).toBe(6)
    })

    it('populates keymap from buffer with correct big-endian parsing', async () => {
      setupReloadMocks({
        vialProtocol: 5,
        layers: 2,
        rows: 2,
        cols: 2,
      })

      const kb = new Keyboard()
      await kb.reload()

      // Keycode = layer * 100 + row * 10 + col (from our mock)
      expect(kb.getKey(0, 0, 0)).toBe(0) // 0*100 + 0*10 + 0 = 0
      expect(kb.getKey(0, 0, 1)).toBe(1) // 0*100 + 0*10 + 1 = 1
      expect(kb.getKey(0, 1, 0)).toBe(10) // 0*100 + 1*10 + 0 = 10
      expect(kb.getKey(0, 1, 1)).toBe(11) // 0*100 + 1*10 + 1 = 11
      expect(kb.getKey(1, 0, 0)).toBe(100) // 1*100 + 0*10 + 0 = 100
      expect(kb.getKey(1, 0, 1)).toBe(101) // 1*100 + 0*10 + 1 = 101
      expect(kb.getKey(1, 1, 0)).toBe(110) // 1*100 + 1*10 + 0 = 110
      expect(kb.getKey(1, 1, 1)).toBe(111) // 1*100 + 1*10 + 1 = 111
    })

    it('fetches keymap in BUFFER_FETCH_CHUNK-sized chunks', async () => {
      // 2 layers * 3 rows * 5 cols * 2 bytes = 60 bytes
      // Should need ceil(60/28) = 3 chunk fetches
      setupReloadMocks({
        vialProtocol: 5,
        layers: 2,
        rows: 3,
        cols: 5,
      })

      const kb = new Keyboard()
      await kb.reload()

      const totalBytes = 2 * 3 * 5 * 2 // 60
      const expectedChunks = Math.ceil(totalBytes / BUFFER_FETCH_CHUNK) // 3
      expect(protocol.getKeymapBuffer).toHaveBeenCalledTimes(expectedChunks)

      // Verify chunk offsets and sizes
      expect(protocol.getKeymapBuffer).toHaveBeenNthCalledWith(1, 0, 28)
      expect(protocol.getKeymapBuffer).toHaveBeenNthCalledWith(2, 28, 28)
      expect(protocol.getKeymapBuffer).toHaveBeenNthCalledWith(3, 56, 4) // remaining 4 bytes
    })

    it('loads encoders for each layer and encoder index', async () => {
      setupReloadMocks({
        vialProtocol: 5,
        layers: 2,
        rows: 2,
        cols: 2,
        encoderCount: 2,
      })

      const kb = new Keyboard()
      await kb.reload()

      // 2 layers * 2 encoders = 4 calls
      expect(protocol.getEncoder).toHaveBeenCalledTimes(4)
      expect(protocol.getEncoder).toHaveBeenCalledWith(0, 0)
      expect(protocol.getEncoder).toHaveBeenCalledWith(0, 1)
      expect(protocol.getEncoder).toHaveBeenCalledWith(1, 0)
      expect(protocol.getEncoder).toHaveBeenCalledWith(1, 1)

      // Verify encoder keycodes from mock: cw = layer*1000 + idx*10 + 1, ccw = +2
      expect(kb.getEncoderKeycode(0, 0, 0)).toBe(1) // 0*1000 + 0*10 + 1
      expect(kb.getEncoderKeycode(0, 0, 1)).toBe(2) // 0*1000 + 0*10 + 2
      expect(kb.getEncoderKeycode(1, 1, 0)).toBe(1011) // 1*1000 + 1*10 + 1
      expect(kb.getEncoderKeycode(1, 1, 1)).toBe(1012) // 1*1000 + 1*10 + 2
    })

    it('skips macro loading when macroBufferSize is 0', async () => {
      setupReloadMocks({
        vialProtocol: 5,
        layers: 1,
        rows: 1,
        cols: 1,
        macroCount: 2,
        macroBufferSize: 0,
      })

      const kb = new Keyboard()
      await kb.reload()

      expect(protocol.getMacroBuffer).not.toHaveBeenCalled()
      expect(kb.state.macros).toEqual([])
    })

    it('skips macro loading when macroCount is 0', async () => {
      setupReloadMocks({
        vialProtocol: 5,
        layers: 1,
        rows: 1,
        cols: 1,
        macroCount: 0,
        macroBufferSize: 64,
      })

      const kb = new Keyboard()
      await kb.reload()

      expect(protocol.getMacroBuffer).not.toHaveBeenCalled()
      expect(kb.state.macros).toEqual([])
    })

    it('loads macros from buffer when both macroCount and macroBufferSize > 0', async () => {
      setupReloadMocks({
        vialProtocol: 5,
        layers: 1,
        rows: 1,
        cols: 1,
        macroCount: 2,
        macroBufferSize: 64,
      })

      const kb = new Keyboard()
      await kb.reload()

      expect(protocol.getMacroBuffer).toHaveBeenCalledWith(64)
      // Our mock returns all zeros, which produces 2 empty macros
      expect(kb.state.macros).toHaveLength(2)
    })

    it('resets state before reloading', async () => {
      setupReloadMocks({
        vialProtocol: 5,
        layers: 1,
        rows: 1,
        cols: 1,
      })

      const kb = new Keyboard()

      // Set some state that should be cleared
      kb.state.keymap.set('99,99,99', 0xffff)
      kb.state.layers = 99

      await kb.reload()

      // Old state should be cleared
      expect(kb.getKey(99, 99, 99)).toBe(0)
      expect(kb.state.layers).toBe(1)
    })

    it('loads dynamic entries when vialProtocol >= VIAL_PROTOCOL_DYNAMIC', async () => {
      setupReloadMocks({
        vialProtocol: 4,
        layers: 1,
        rows: 1,
        cols: 1,
        tapDanceCount: 2,
        comboCount: 1,
        keyOverrideCount: 1,
        altRepeatKeyCount: 1,
      })

      const kb = new Keyboard()
      await kb.reload()

      expect(kb.state.tapDanceEntries).toHaveLength(2)
      expect(kb.state.comboEntries).toHaveLength(1)
      expect(kb.state.keyOverrideEntries).toHaveLength(1)
      expect(kb.state.altRepeatKeyEntries).toHaveLength(1)

      // Verify values from mock
      expect(kb.state.tapDanceEntries[0].onTap).toBe(1)
      expect(kb.state.tapDanceEntries[1].onTap).toBe(2)
      expect(kb.state.comboEntries[0].key1).toBe(10)
      expect(kb.state.keyOverrideEntries[0].triggerKey).toBe(100)
      expect(kb.state.altRepeatKeyEntries[0].lastKey).toBe(50)
    })

    it('counts encoders from definition layout', async () => {
      setupReloadMocks({
        vialProtocol: 5,
        layers: 1,
        rows: 1,
        cols: 1,
        encoderCount: 3,
      })

      const kb = new Keyboard()
      await kb.reload()

      // Our mock generates 3 * 2 = 6 encoder entries, countEncoders divides by 2 -> 3
      expect(kb.state.encoderCount).toBe(3)
    })

    it('handles LZMA decompression failure (null result)', async () => {
      setupReloadMocks({ vialProtocol: 5, layers: 1, rows: 2, cols: 2 })

      // Override LZMA to return null (decompression failure)
      ;(LZMA.decompress as Mock).mockImplementation(
        (_input: number[], callback: (result: string | null) => void) => {
          callback(null)
        },
      )

      const kb = new Keyboard()
      await kb.reload()

      // definition should remain null
      expect(kb.state.definition).toBeNull()
      // rows/cols should stay 0 (not set from definition)
      expect(kb.state.rows).toBe(0)
      expect(kb.state.cols).toBe(0)
      expect(kb.state.encoderCount).toBe(0)
      // keymap should be empty since rows*cols*layers = 0
      expect(kb.state.keymap.size).toBe(0)
    })

    it('handles LZMA decompression returning invalid JSON', async () => {
      setupReloadMocks({ vialProtocol: 5, layers: 1, rows: 2, cols: 2 })

      // Override LZMA to return invalid JSON
      ;(LZMA.decompress as Mock).mockImplementation(
        (_input: number[], callback: (result: string | null) => void) => {
          callback('not valid json {{{')
        },
      )

      const kb = new Keyboard()
      await kb.reload()

      expect(kb.state.definition).toBeNull()
      expect(kb.state.rows).toBe(0)
      expect(kb.state.cols).toBe(0)
    })
  })

  // ----------------------------------------------------------------
  // 5. setKey
  // ----------------------------------------------------------------
  describe('setKey', () => {
    it('calls protocol.setKeycode with correct arguments', async () => {
      const kb = new Keyboard()
      await kb.setKey(1, 2, 3, 0x0041)

      expect(protocol.setKeycode).toHaveBeenCalledWith(1, 2, 3, 0x0041)
    })

    it('updates state.keymap after setting', async () => {
      const kb = new Keyboard()
      ;(protocol.setKeycode as Mock).mockResolvedValue(undefined)

      await kb.setKey(0, 0, 0, 0x0004)

      expect(kb.getKey(0, 0, 0)).toBe(0x0004)
    })

    it('overwrites previous keymap value', async () => {
      const kb = new Keyboard()
      ;(protocol.setKeycode as Mock).mockResolvedValue(undefined)

      await kb.setKey(0, 0, 0, 0x0004)
      await kb.setKey(0, 0, 0, 0x0005)

      expect(kb.getKey(0, 0, 0)).toBe(0x0005)
    })
  })

  // ----------------------------------------------------------------
  // 6. setEncoderKeycode
  // ----------------------------------------------------------------
  describe('setEncoderKeycode', () => {
    it('calls protocol.setEncoder with correct arguments', async () => {
      const kb = new Keyboard()
      ;(protocol.setEncoder as Mock).mockResolvedValue(undefined)

      await kb.setEncoderKeycode(1, 0, 0, 0x00e0)

      expect(protocol.setEncoder).toHaveBeenCalledWith(1, 0, 0, 0x00e0)
    })

    it('updates state.encoderLayout after setting', async () => {
      const kb = new Keyboard()
      ;(protocol.setEncoder as Mock).mockResolvedValue(undefined)

      await kb.setEncoderKeycode(0, 1, 0, 0x1234)

      expect(kb.getEncoderKeycode(0, 1, 0)).toBe(0x1234)
    })

    it('sets CW and CCW independently', async () => {
      const kb = new Keyboard()
      ;(protocol.setEncoder as Mock).mockResolvedValue(undefined)

      await kb.setEncoderKeycode(0, 0, 0, 0xaaaa) // CW
      await kb.setEncoderKeycode(0, 0, 1, 0xbbbb) // CCW

      expect(kb.getEncoderKeycode(0, 0, 0)).toBe(0xaaaa)
      expect(kb.getEncoderKeycode(0, 0, 1)).toBe(0xbbbb)
    })
  })

  // ----------------------------------------------------------------
  // 7. setMacros
  // ----------------------------------------------------------------
  describe('setMacros', () => {
    it('serializes macros and zero-pads to macroBufferSize', async () => {
      const kb = new Keyboard()
      kb.state.vialProtocol = 5
      kb.state.macroBufferSize = 100
      ;(protocol.setMacroBuffer as Mock).mockResolvedValue(undefined)

      const macros = [[{ type: 'text' as const, text: 'AB' }]]
      await kb.setMacros(macros)

      expect(protocol.setMacroBuffer).toHaveBeenCalledTimes(1)
      const sentBuffer = (protocol.setMacroBuffer as Mock).mock.calls[0][0] as number[]
      expect(sentBuffer).toHaveLength(100)

      // "AB" = [0x41, 0x42], NUL terminator = [0x00]
      expect(sentBuffer[0]).toBe(0x41)
      expect(sentBuffer[1]).toBe(0x42)
      expect(sentBuffer[2]).toBe(0x00) // NUL terminator

      // Rest should be zero-padded
      for (let i = 3; i < 100; i++) {
        expect(sentBuffer[i]).toBe(0)
      }
    })

    it('updates state.macros after setting', async () => {
      const kb = new Keyboard()
      kb.state.vialProtocol = 5
      kb.state.macroBufferSize = 64
      ;(protocol.setMacroBuffer as Mock).mockResolvedValue(undefined)

      const macros = [[{ type: 'text' as const, text: 'test' }]]
      await kb.setMacros(macros)

      expect(kb.state.macros).toEqual(macros)
    })

    it('truncates serialized data when it exceeds macroBufferSize', async () => {
      const kb = new Keyboard()
      kb.state.vialProtocol = 5
      kb.state.macroBufferSize = 5 // Very small
      ;(protocol.setMacroBuffer as Mock).mockResolvedValue(undefined)

      // "ABCDEFGH" serializes to 8 bytes + NUL = 9 bytes, exceeds buffer of 5
      const macros = [[{ type: 'text' as const, text: 'ABCDEFGH' }]]
      await kb.setMacros(macros)

      const sentBuffer = (protocol.setMacroBuffer as Mock).mock.calls[0][0] as number[]
      expect(sentBuffer).toHaveLength(5)
      // Only first 5 bytes copied
      expect(sentBuffer[0]).toBe(0x41) // A
      expect(sentBuffer[1]).toBe(0x42) // B
      expect(sentBuffer[2]).toBe(0x43) // C
      expect(sentBuffer[3]).toBe(0x44) // D
      expect(sentBuffer[4]).toBe(0x45) // E
    })
  })

  // ----------------------------------------------------------------
  // 8. setLayoutOptions
  // ----------------------------------------------------------------
  describe('setLayoutOptions', () => {
    it('calls protocol when value differs from current state', async () => {
      const kb = new Keyboard()
      kb.state.layoutOptions = 0
      ;(protocol.setLayoutOptions as Mock).mockResolvedValue(undefined)

      await kb.setLayoutOptions(5)

      expect(protocol.setLayoutOptions).toHaveBeenCalledWith(5)
      expect(kb.state.layoutOptions).toBe(5)
    })

    it('does NOT call protocol when value is the same', async () => {
      const kb = new Keyboard()
      kb.state.layoutOptions = 5

      await kb.setLayoutOptions(5)

      expect(protocol.setLayoutOptions).not.toHaveBeenCalled()
      expect(kb.state.layoutOptions).toBe(5)
    })

    it('updates state even when changing from -1 (initial)', async () => {
      const kb = new Keyboard()
      // Default layoutOptions is -1
      expect(kb.state.layoutOptions).toBe(-1)
      ;(protocol.setLayoutOptions as Mock).mockResolvedValue(undefined)

      await kb.setLayoutOptions(0)

      expect(protocol.setLayoutOptions).toHaveBeenCalledWith(0)
      expect(kb.state.layoutOptions).toBe(0)
    })
  })

  // ----------------------------------------------------------------
  // 9. refreshUnlockStatus
  // ----------------------------------------------------------------
  describe('refreshUnlockStatus', () => {
    it('calls protocol.getUnlockStatus when vialProtocol >= 0', async () => {
      const kb = new Keyboard()
      kb.state.vialProtocol = 0
      const mockStatus = { unlocked: false, inProgress: true, keys: [[1, 2] as [number, number]] }
      ;(protocol.getUnlockStatus as Mock).mockResolvedValue(mockStatus)

      const result = await kb.refreshUnlockStatus()

      expect(protocol.getUnlockStatus).toHaveBeenCalledTimes(1)
      expect(result).toEqual(mockStatus)
      expect(kb.state.unlockStatus).toEqual(mockStatus)
    })

    it('returns always-unlocked for VIA-only (vialProtocol < 0) without protocol call', async () => {
      const kb = new Keyboard()
      kb.state.vialProtocol = -1

      const result = await kb.refreshUnlockStatus()

      expect(protocol.getUnlockStatus).not.toHaveBeenCalled()
      expect(result).toEqual({
        unlocked: true,
        inProgress: false,
        keys: [],
      })
      expect(kb.state.unlockStatus).toEqual({
        unlocked: true,
        inProgress: false,
        keys: [],
      })
    })

    it('updates state.unlockStatus on subsequent calls', async () => {
      const kb = new Keyboard()
      kb.state.vialProtocol = 5

      ;(protocol.getUnlockStatus as Mock).mockResolvedValueOnce({
        unlocked: false,
        inProgress: true,
        keys: [],
      })
      await kb.refreshUnlockStatus()
      expect(kb.state.unlockStatus.unlocked).toBe(false)

      ;(protocol.getUnlockStatus as Mock).mockResolvedValueOnce({
        unlocked: true,
        inProgress: false,
        keys: [],
      })
      await kb.refreshUnlockStatus()
      expect(kb.state.unlockStatus.unlocked).toBe(true)
    })
  })

  // ----------------------------------------------------------------
  // 10. restoreLayout
  // ----------------------------------------------------------------
  describe('restoreLayout', () => {
    beforeEach(() => {
      ;(protocol.setKeycode as Mock).mockResolvedValue(undefined)
      ;(protocol.setEncoder as Mock).mockResolvedValue(undefined)
      ;(protocol.setMacroBuffer as Mock).mockResolvedValue(undefined)
      ;(protocol.setLayoutOptions as Mock).mockResolvedValue(undefined)
      ;(protocol.setTapDance as Mock).mockResolvedValue(undefined)
      ;(protocol.setCombo as Mock).mockResolvedValue(undefined)
      ;(protocol.setKeyOverride as Mock).mockResolvedValue(undefined)
      ;(protocol.setAltRepeatKey as Mock).mockResolvedValue(undefined)
    })

    it('restores keymap by calling setKey for each valid entry', async () => {
      const kb = new Keyboard()
      kb.state.layers = 2
      kb.state.rows = 2
      kb.state.cols = 2
      kb.state.layoutOptions = 0
      kb.state.macroBufferSize = 64
      kb.state.vialProtocol = 5

      const data = {
        layout: [
          [
            [0x0004, 0x0005],
            [0x0006, 0x0007],
          ],
          [
            [0x0008, 0x0009],
            [0x000a, 0x000b],
          ],
        ],
      }

      await kb.restoreLayout(data)

      // 2 layers * 2 rows * 2 cols = 8 setKey calls
      expect(protocol.setKeycode).toHaveBeenCalledTimes(8)
      expect(kb.getKey(0, 0, 0)).toBe(0x0004)
      expect(kb.getKey(1, 1, 1)).toBe(0x000b)
    })

    it('restores encoders by calling setEncoderKeycode', async () => {
      const kb = new Keyboard()
      kb.state.layers = 1
      kb.state.rows = 1
      kb.state.cols = 1
      kb.state.encoderCount = 1
      kb.state.layoutOptions = 0
      kb.state.vialProtocol = 5
      kb.state.macroBufferSize = 64

      const data = {
        encoder_layout: [[[0x00e0, 0x00e1]]],
      }

      await kb.restoreLayout(data)

      // 1 encoder * 1 layer * 2 directions = 2 calls
      expect(protocol.setEncoder).toHaveBeenCalledTimes(2)
      expect(protocol.setEncoder).toHaveBeenCalledWith(0, 0, 0, 0x00e0)
      expect(protocol.setEncoder).toHaveBeenCalledWith(0, 0, 1, 0x00e1)
    })

    it('restores layout options', async () => {
      const kb = new Keyboard()
      kb.state.layers = 1
      kb.state.rows = 1
      kb.state.cols = 1
      kb.state.layoutOptions = 0
      kb.state.vialProtocol = 5
      kb.state.macroBufferSize = 64

      await kb.restoreLayout({ layout_options: 7 })

      expect(protocol.setLayoutOptions).toHaveBeenCalledWith(7)
      expect(kb.state.layoutOptions).toBe(7)
    })

    it('restores macros', async () => {
      const kb = new Keyboard()
      kb.state.layers = 1
      kb.state.rows = 1
      kb.state.cols = 1
      kb.state.layoutOptions = 0
      kb.state.vialProtocol = 5
      kb.state.macroBufferSize = 64

      const macros = [[{ type: 'text' as const, text: 'hello' }]]
      await kb.restoreLayout({ macro: macros })

      expect(protocol.setMacroBuffer).toHaveBeenCalledTimes(1)
      expect(kb.state.macros).toEqual(macros)
    })

    it('restores tap dance entries', async () => {
      const kb = new Keyboard()
      kb.state.layers = 1
      kb.state.rows = 1
      kb.state.cols = 1
      kb.state.layoutOptions = 0
      kb.state.vialProtocol = 5
      kb.state.dynamicCounts = { tapDance: 2, combo: 0, keyOverride: 0, altRepeatKey: 0, featureFlags: 0 }

      const tapDance: TapDanceEntry[] = [
        { onTap: 1, onHold: 2, onDoubleTap: 3, onTapHold: 4, tappingTerm: 200 },
        { onTap: 5, onHold: 6, onDoubleTap: 7, onTapHold: 8, tappingTerm: 250 },
      ]
      await kb.restoreLayout({ tap_dance: tapDance })

      expect(protocol.setTapDance).toHaveBeenCalledTimes(2)
      expect(protocol.setTapDance).toHaveBeenCalledWith(0, tapDance[0])
      expect(protocol.setTapDance).toHaveBeenCalledWith(1, tapDance[1])
      expect(kb.state.tapDanceEntries[0]).toEqual(tapDance[0])
      expect(kb.state.tapDanceEntries[1]).toEqual(tapDance[1])
    })

    it('restores combo entries', async () => {
      const kb = new Keyboard()
      kb.state.dynamicCounts = { tapDance: 0, combo: 1, keyOverride: 0, altRepeatKey: 0, featureFlags: 0 }

      const combo: ComboEntry[] = [{ key1: 10, key2: 20, key3: 0, key4: 0, output: 30 }]
      await kb.restoreLayout({ combo })

      expect(protocol.setCombo).toHaveBeenCalledWith(0, combo[0])
      expect(kb.state.comboEntries[0]).toEqual(combo[0])
    })

    it('restores key override entries', async () => {
      const kb = new Keyboard()
      kb.state.dynamicCounts = { tapDance: 0, combo: 0, keyOverride: 1, altRepeatKey: 0, featureFlags: 0 }

      const keyOverride: KeyOverrideEntry[] = [
        {
          triggerKey: 100,
          replacementKey: 200,
          layers: 0xffff,
          triggerMods: 0x01,
          negativeMods: 0,
          suppressedMods: 0,
          options: 0x03,
          enabled: true,
        },
      ]
      await kb.restoreLayout({ key_override: keyOverride })

      expect(protocol.setKeyOverride).toHaveBeenCalledWith(0, keyOverride[0])
      expect(kb.state.keyOverrideEntries[0]).toEqual(keyOverride[0])
    })

    it('restores alt repeat key entries', async () => {
      const kb = new Keyboard()
      kb.state.dynamicCounts = { tapDance: 0, combo: 0, keyOverride: 0, altRepeatKey: 1, featureFlags: 0 }

      const altRepeatKey: AltRepeatKeyEntry[] = [
        { lastKey: 50, altKey: 60, allowedMods: 0xff, options: 0x01, enabled: true },
      ]
      await kb.restoreLayout({ alt_repeat_key: altRepeatKey })

      expect(protocol.setAltRepeatKey).toHaveBeenCalledWith(0, altRepeatKey[0])
      expect(kb.state.altRepeatKeyEntries[0]).toEqual(altRepeatKey[0])
    })

    it('clamps saved layout to current state dimensions (boundary safety)', async () => {
      const kb = new Keyboard()
      kb.state.layers = 1
      kb.state.rows = 1
      kb.state.cols = 1
      kb.state.layoutOptions = 0
      kb.state.vialProtocol = 5
      kb.state.macroBufferSize = 64

      // Saved layout has 2 layers, 3 rows, 4 cols — larger than state
      const data = {
        layout: [
          [
            [0x01, 0x02, 0x03, 0x04],
            [0x05, 0x06, 0x07, 0x08],
            [0x09, 0x0a, 0x0b, 0x0c],
          ],
          [
            [0x11, 0x12, 0x13, 0x14],
            [0x15, 0x16, 0x17, 0x18],
            [0x19, 0x1a, 0x1b, 0x1c],
          ],
        ],
      }

      await kb.restoreLayout(data)

      // Only 1 layer * 1 row * 1 col = 1 key should be restored
      expect(protocol.setKeycode).toHaveBeenCalledTimes(1)
      expect(protocol.setKeycode).toHaveBeenCalledWith(0, 0, 0, 0x01)
    })

    it('clamps encoder restore to current encoder count', async () => {
      const kb = new Keyboard()
      kb.state.layers = 1
      kb.state.rows = 1
      kb.state.cols = 1
      kb.state.encoderCount = 1 // Only 1 encoder
      kb.state.layoutOptions = 0
      kb.state.vialProtocol = 5
      kb.state.macroBufferSize = 64

      // Saved layout has 2 encoders per layer
      const data = {
        encoder_layout: [
          [
            [0x00e0, 0x00e1],
            [0x00e2, 0x00e3],
          ],
        ],
      }

      await kb.restoreLayout(data)

      // Only encoder 0 should be restored (2 calls for CW + CCW)
      expect(protocol.setEncoder).toHaveBeenCalledTimes(2)
      expect(protocol.setEncoder).toHaveBeenCalledWith(0, 0, 0, 0x00e0)
      expect(protocol.setEncoder).toHaveBeenCalledWith(0, 0, 1, 0x00e1)
    })

    it('clamps dynamic entry restore to current dynamic counts', async () => {
      const kb = new Keyboard()
      kb.state.dynamicCounts = { tapDance: 1, combo: 0, keyOverride: 0, altRepeatKey: 0, featureFlags: 0 }

      // Saved data has 3 tap dance entries, but state only allows 1
      const tapDance: TapDanceEntry[] = [
        { onTap: 1, onHold: 2, onDoubleTap: 3, onTapHold: 4, tappingTerm: 200 },
        { onTap: 5, onHold: 6, onDoubleTap: 7, onTapHold: 8, tappingTerm: 250 },
        { onTap: 9, onHold: 10, onDoubleTap: 11, onTapHold: 12, tappingTerm: 300 },
      ]
      await kb.restoreLayout({ tap_dance: tapDance })

      expect(protocol.setTapDance).toHaveBeenCalledTimes(1) // Only 1 allowed
      expect(protocol.setTapDance).toHaveBeenCalledWith(0, tapDance[0])
    })

    it('skips negative keycode values (kc >= 0 check)', async () => {
      const kb = new Keyboard()
      kb.state.layers = 1
      kb.state.rows = 1
      kb.state.cols = 2
      kb.state.layoutOptions = 0
      kb.state.vialProtocol = 5
      kb.state.macroBufferSize = 64

      const data = {
        layout: [[[0x0004, -1]]], // second key is -1 (unset)
      }

      await kb.restoreLayout(data)

      // Only the first key should be restored
      expect(protocol.setKeycode).toHaveBeenCalledTimes(1)
      expect(protocol.setKeycode).toHaveBeenCalledWith(0, 0, 0, 0x0004)
    })

    it('does not call setLayoutOptions for negative layout_options', async () => {
      const kb = new Keyboard()
      kb.state.layoutOptions = 0

      await kb.restoreLayout({ layout_options: -1 })

      expect(protocol.setLayoutOptions).not.toHaveBeenCalled()
    })

    it('does not call setLayoutOptions when layout_options is undefined', async () => {
      const kb = new Keyboard()
      kb.state.layoutOptions = 0

      await kb.restoreLayout({})

      expect(protocol.setLayoutOptions).not.toHaveBeenCalled()
    })

    it('does not restore macros when macro field is not an array', async () => {
      const kb = new Keyboard()
      kb.state.vialProtocol = 5
      kb.state.macroBufferSize = 64

      await kb.restoreLayout({ macro: 'not an array' })

      expect(protocol.setMacroBuffer).not.toHaveBeenCalled()
    })

    it('handles empty restore data gracefully', async () => {
      const kb = new Keyboard()
      kb.state.layers = 2
      kb.state.rows = 2
      kb.state.cols = 2

      await kb.restoreLayout({})

      expect(protocol.setKeycode).not.toHaveBeenCalled()
      expect(protocol.setEncoder).not.toHaveBeenCalled()
      expect(protocol.setLayoutOptions).not.toHaveBeenCalled()
      expect(protocol.setMacroBuffer).not.toHaveBeenCalled()
    })

    it('handles malformed layout with missing inner arrays', async () => {
      const kb = new Keyboard()
      kb.state.layers = 2
      kb.state.rows = 2
      kb.state.cols = 2
      ;(protocol.setKeycode as Mock).mockResolvedValue(undefined)

      // layout has a layer that is not a proper 2D array
      // This should not throw — Math.min with undefined.length would fail
      // but the code guards with optional chaining on array access
      const malformedLayout = [
        [[1, 2], [3, 4]], // layer 0: valid
        // layer 1: missing entirely — loop simply doesn't iterate
      ]

      await expect(
        kb.restoreLayout({ layout: malformedLayout }),
      ).resolves.toBeUndefined()

      // Only layer 0 keys should be set (4 keys)
      expect(protocol.setKeycode).toHaveBeenCalledTimes(4)
    })

    it('handles malformed encoder_layout with missing inner arrays', async () => {
      const kb = new Keyboard()
      kb.state.layers = 2
      kb.state.encoderCount = 2
      ;(protocol.setEncoder as Mock).mockResolvedValue(undefined)

      // encoder_layout with only 1 layer instead of 2
      const malformedEncoderLayout = [
        [[10, 20]], // layer 0, encoder 0 only (encoder 1 missing)
      ]

      await expect(
        kb.restoreLayout({ encoder_layout: malformedEncoderLayout }),
      ).resolves.toBeUndefined()

      // Only 1 encoder in 1 layer = 2 calls (CW + CCW)
      expect(protocol.setEncoder).toHaveBeenCalledTimes(2)
    })
  })
})
