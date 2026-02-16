/**
 * High-level Keyboard class.
 * Orchestrates protocol calls into a coherent initialization sequence
 * and maintains keyboard state.
 *
 * Reload sequence mirrors vial-gui's keyboard_comm.py:
 *   1. Protocol version negotiation
 *   2. Keyboard ID + definition (LZMA-compressed JSON)
 *   3. Layer count + macro metadata
 *   4. Lighting + QMK settings
 *   5. Dynamic entry counts
 *   6. Keymap + encoders + macro buffer + dynamic entries
 */

import LZMA from 'lzma'
import * as protocol from './protocol'
import { deserializeAllMacros, serializeAllMacros, type MacroAction } from './macro'
import type {
  KeyboardId,
  KeyboardDefinition,
  TapDanceEntry,
  ComboEntry,
  KeyOverrideEntry,
  AltRepeatKeyEntry,
  DynamicEntryCounts,
  UnlockStatus,
} from '../shared/types/protocol'
import {
  BUFFER_FETCH_CHUNK,
  VIAL_PROTOCOL_DYNAMIC,
} from '../shared/constants/protocol'

export interface KeyboardState {
  // Protocol
  viaProtocol: number
  vialProtocol: number
  keyboardId: KeyboardId

  // Definition
  definition: KeyboardDefinition | null
  definitionRaw: Uint8Array | null

  // Layout
  layers: number
  rows: number
  cols: number
  keymap: Map<string, number> // "layer,row,col" → keycode
  encoderLayout: Map<string, number> // "layer,idx,dir" → keycode
  encoderCount: number
  layoutOptions: number

  // Macro
  macroCount: number
  macroBufferSize: number
  macros: MacroAction[][]

  // Dynamic entries
  dynamicCounts: DynamicEntryCounts
  tapDanceEntries: TapDanceEntry[]
  comboEntries: ComboEntry[]
  keyOverrideEntries: KeyOverrideEntry[]
  altRepeatKeyEntries: AltRepeatKeyEntry[]

  // Unlock
  unlockStatus: UnlockStatus

  // Features
  supportedFeatures: Set<string>
}

function keymapKey(layer: number, row: number, col: number): string {
  return `${layer},${row},${col}`
}

function encoderKey(layer: number, idx: number, dir: number): string {
  return `${layer},${idx},${dir}`
}

/** Create an empty keyboard state. */
function emptyState(): KeyboardState {
  return {
    viaProtocol: -1,
    vialProtocol: -1,
    keyboardId: { vialProtocol: -1, uid: '0x0' },
    definition: null,
    definitionRaw: null,
    layers: 0,
    rows: 0,
    cols: 0,
    keymap: new Map(),
    encoderLayout: new Map(),
    encoderCount: 0,
    layoutOptions: -1,
    macroCount: 0,
    macroBufferSize: 0,
    macros: [],
    dynamicCounts: { tapDance: 0, combo: 0, keyOverride: 0, altRepeatKey: 0, featureFlags: 0 },
    tapDanceEntries: [],
    comboEntries: [],
    keyOverrideEntries: [],
    altRepeatKeyEntries: [],
    unlockStatus: { unlocked: false, inProgress: false, keys: [] },
    supportedFeatures: new Set(),
  }
}

export class Keyboard {
  state: KeyboardState = emptyState()

  /** Full reload sequence. Call after opening a device. */
  async reload(): Promise<void> {
    this.state = emptyState()

    // Phase 1: Protocol versions + definition
    this.state.viaProtocol = await protocol.getProtocolVersion()
    this.state.keyboardId = await protocol.getKeyboardId()
    this.state.vialProtocol = this.state.keyboardId.vialProtocol

    // Fetch and decompress definition
    const defSize = await protocol.getDefinitionSize()
    this.state.definitionRaw = await protocol.getDefinitionRaw(defSize)
    this.state.definition = await this.decompressDefinition(this.state.definitionRaw)

    if (this.state.definition) {
      this.state.rows = this.state.definition.matrix.rows
      this.state.cols = this.state.definition.matrix.cols
      this.state.encoderCount = this.countEncoders(this.state.definition)
    }

    // Phase 2: Layer count + macro metadata
    this.state.layers = await protocol.getLayerCount()
    this.state.macroCount = await protocol.getMacroCount()
    this.state.macroBufferSize = await protocol.getMacroBufferSize()

    // Phase 3: Layout options
    this.state.layoutOptions = await protocol.getLayoutOptions()

    // Phase 4: Dynamic entry counts (gated by protocol version)
    if (this.state.vialProtocol >= VIAL_PROTOCOL_DYNAMIC) {
      this.state.dynamicCounts = await protocol.getDynamicEntryCount()
    }

    // Phase 5: Keymap
    await this.reloadKeymap()

    // Phase 6: Encoders
    await this.reloadEncoders()

    // Phase 7: Macro buffer
    if (this.state.macroBufferSize > 0 && this.state.macroCount > 0) {
      const buffer = await protocol.getMacroBuffer(this.state.macroBufferSize)
      this.state.macros = deserializeAllMacros(buffer, this.state.vialProtocol, this.state.macroCount)
    }

    // Phase 8: Dynamic entries
    await this.reloadDynamicEntries()

    // Phase 9: Unlock status
    if (this.state.vialProtocol >= 0) {
      this.state.unlockStatus = await protocol.getUnlockStatus()
    } else {
      // VIA-only keyboards are always unlocked
      this.state.unlockStatus = { unlocked: true, inProgress: false, keys: [] }
    }
  }

  // --- Keymap ---

  private async reloadKeymap(): Promise<void> {
    const { layers, rows, cols } = this.state
    const totalSize = layers * rows * cols * 2 // 2 bytes per keycode (big-endian u16)
    const buffer: number[] = []

    for (let offset = 0; offset < totalSize; offset += BUFFER_FETCH_CHUNK) {
      const chunkSize = Math.min(BUFFER_FETCH_CHUNK, totalSize - offset)
      const chunk = await protocol.getKeymapBuffer(offset, chunkSize)
      buffer.push(...chunk)
    }

    // Parse keycodes (big-endian u16)
    for (let layer = 0; layer < layers; layer++) {
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const idx = (layer * rows * cols + row * cols + col) * 2
          const keycode = (buffer[idx] << 8) | buffer[idx + 1]
          this.state.keymap.set(keymapKey(layer, row, col), keycode)
        }
      }
    }
  }

  async setKey(layer: number, row: number, col: number, keycode: number): Promise<void> {
    await protocol.setKeycode(layer, row, col, keycode)
    this.state.keymap.set(keymapKey(layer, row, col), keycode)
  }

  getKey(layer: number, row: number, col: number): number {
    return this.state.keymap.get(keymapKey(layer, row, col)) ?? 0
  }

  // --- Encoders ---

  private async reloadEncoders(): Promise<void> {
    const { layers, encoderCount } = this.state
    for (let layer = 0; layer < layers; layer++) {
      for (let idx = 0; idx < encoderCount; idx++) {
        const [cw, ccw] = await protocol.getEncoder(layer, idx)
        this.state.encoderLayout.set(encoderKey(layer, idx, 0), cw)
        this.state.encoderLayout.set(encoderKey(layer, idx, 1), ccw)
      }
    }
  }

  async setEncoderKeycode(
    layer: number,
    idx: number,
    direction: number,
    keycode: number,
  ): Promise<void> {
    await protocol.setEncoder(layer, idx, direction, keycode)
    this.state.encoderLayout.set(encoderKey(layer, idx, direction), keycode)
  }

  getEncoderKeycode(layer: number, idx: number, direction: number): number {
    return this.state.encoderLayout.get(encoderKey(layer, idx, direction)) ?? 0
  }

  // --- Dynamic Entries ---

  private async reloadDynamicEntries(): Promise<void> {
    const { dynamicCounts, vialProtocol } = this.state
    if (vialProtocol < VIAL_PROTOCOL_DYNAMIC) return

    // Tap Dance
    this.state.tapDanceEntries = []
    for (let i = 0; i < dynamicCounts.tapDance; i++) {
      this.state.tapDanceEntries.push(await protocol.getTapDance(i))
    }

    // Combo
    this.state.comboEntries = []
    for (let i = 0; i < dynamicCounts.combo; i++) {
      this.state.comboEntries.push(await protocol.getCombo(i))
    }

    // Key Override
    this.state.keyOverrideEntries = []
    for (let i = 0; i < dynamicCounts.keyOverride; i++) {
      this.state.keyOverrideEntries.push(await protocol.getKeyOverride(i))
    }

    // Alt Repeat Key
    this.state.altRepeatKeyEntries = []
    for (let i = 0; i < dynamicCounts.altRepeatKey; i++) {
      this.state.altRepeatKeyEntries.push(await protocol.getAltRepeatKey(i))
    }
  }

  // --- Macros ---

  async setMacros(macros: MacroAction[][]): Promise<void> {
    const serialized = serializeAllMacros(macros, this.state.vialProtocol)
    // Zero-pad to macroBufferSize to clear stale data on device
    const buffer = new Array<number>(this.state.macroBufferSize).fill(0)
    for (let i = 0; i < Math.min(serialized.length, buffer.length); i++) {
      buffer[i] = serialized[i]
    }
    await protocol.setMacroBuffer(buffer)
    this.state.macros = macros
  }

  // --- Layout Options ---

  async setLayoutOptions(options: number): Promise<void> {
    if (this.state.layoutOptions !== options) {
      await protocol.setLayoutOptions(options)
      this.state.layoutOptions = options
    }
  }

  // --- Unlock ---

  async refreshUnlockStatus(): Promise<UnlockStatus> {
    if (this.state.vialProtocol < 0) {
      this.state.unlockStatus = { unlocked: true, inProgress: false, keys: [] }
    } else {
      this.state.unlockStatus = await protocol.getUnlockStatus()
    }
    return this.state.unlockStatus
  }

  // --- Helpers ---

  /** Decompress LZMA-compressed definition JSON. */
  private decompressDefinition(compressed: Uint8Array): Promise<KeyboardDefinition | null> {
    return new Promise((resolve) => {
      // Convert Uint8Array to number array for lzma library
      const input = Array.from(compressed)
      LZMA.decompress(input, (result: string | null) => {
        if (result === null) {
          console.warn('LZMA decompression failed')
          resolve(null)
          return
        }
        try {
          resolve(JSON.parse(result) as KeyboardDefinition)
        } catch {
          console.warn('Failed to parse definition JSON')
          resolve(null)
        }
      })
    })
  }

  /** Count encoders from the keyboard definition. */
  private countEncoders(def: KeyboardDefinition): number {
    // Encoders are represented as special keys in the KLE layout with "e" property
    let count = 0
    if (def.layouts?.keymap) {
      for (const row of def.layouts.keymap) {
        for (const item of row) {
          if (typeof item === 'object' && item !== null && 'e' in item) {
            count++
          }
        }
      }
    }
    // Divide by 2 because each encoder has CW and CCW entries
    return Math.ceil(count / 2)
  }

  // --- Save/Restore Layout ---

  /** Export current layout as a serializable object. */
  saveLayout(): Record<string, unknown> {
    const { layers, rows, cols, keymap, encoderLayout, encoderCount } = this.state

    // Convert keymap to nested arrays
    const layoutArray: number[][][] = []
    for (let l = 0; l < layers; l++) {
      const layerArr: number[][] = []
      for (let r = 0; r < rows; r++) {
        const rowArr: number[] = []
        for (let c = 0; c < cols; c++) {
          rowArr.push(keymap.get(keymapKey(l, r, c)) ?? -1)
        }
        layerArr.push(rowArr)
      }
      layoutArray.push(layerArr)
    }

    // Convert encoder layout
    const encoderArray: number[][][] = []
    for (let l = 0; l < layers; l++) {
      const layerEnc: number[][] = []
      for (let e = 0; e < encoderCount; e++) {
        layerEnc.push([
          encoderLayout.get(encoderKey(l, e, 0)) ?? 0,
          encoderLayout.get(encoderKey(l, e, 1)) ?? 0,
        ])
      }
      encoderArray.push(layerEnc)
    }

    return {
      version: 1,
      uid: this.state.keyboardId.uid,
      layout: layoutArray,
      encoder_layout: encoderArray,
      layout_options: this.state.layoutOptions,
      macro: this.state.macros,
      vial_protocol: this.state.vialProtocol,
      via_protocol: this.state.viaProtocol,
      tap_dance: this.state.tapDanceEntries,
      combo: this.state.comboEntries,
      key_override: this.state.keyOverrideEntries,
      alt_repeat_key: this.state.altRepeatKeyEntries,
    }
  }

  /** Restore layout from a saved object. Writes changes to device. */
  async restoreLayout(data: Record<string, unknown>): Promise<void> {
    const layout = data.layout as number[][][] | undefined
    const encoderLayoutData = data.encoder_layout as number[][][] | undefined
    const layoutOptions = data.layout_options as number | undefined

    // Restore keymap
    if (layout) {
      for (let l = 0; l < Math.min(layout.length, this.state.layers); l++) {
        for (let r = 0; r < Math.min(layout[l].length, this.state.rows); r++) {
          for (let c = 0; c < Math.min(layout[l][r].length, this.state.cols); c++) {
            const kc = layout[l][r][c]
            if (kc >= 0) {
              await this.setKey(l, r, c, kc)
            }
          }
        }
      }
    }

    // Restore encoders
    if (encoderLayoutData) {
      for (let l = 0; l < Math.min(encoderLayoutData.length, this.state.layers); l++) {
        for (let e = 0; e < Math.min(encoderLayoutData[l].length, this.state.encoderCount); e++) {
          await this.setEncoderKeycode(l, e, 0, encoderLayoutData[l][e][0])
          await this.setEncoderKeycode(l, e, 1, encoderLayoutData[l][e][1])
        }
      }
    }

    // Restore layout options
    if (layoutOptions !== undefined && layoutOptions >= 0) {
      await this.setLayoutOptions(layoutOptions)
    }

    // Restore macros
    if (data.macro && Array.isArray(data.macro)) {
      await this.setMacros(data.macro as MacroAction[][])
    }

    // Restore dynamic entries
    const tapDance = data.tap_dance as TapDanceEntry[] | undefined
    if (tapDance) {
      for (let i = 0; i < Math.min(tapDance.length, this.state.dynamicCounts.tapDance); i++) {
        await protocol.setTapDance(i, tapDance[i])
        this.state.tapDanceEntries[i] = tapDance[i]
      }
    }

    const combo = data.combo as ComboEntry[] | undefined
    if (combo) {
      for (let i = 0; i < Math.min(combo.length, this.state.dynamicCounts.combo); i++) {
        await protocol.setCombo(i, combo[i])
        this.state.comboEntries[i] = combo[i]
      }
    }

    const keyOverride = data.key_override as KeyOverrideEntry[] | undefined
    if (keyOverride) {
      for (let i = 0; i < Math.min(keyOverride.length, this.state.dynamicCounts.keyOverride); i++) {
        await protocol.setKeyOverride(i, keyOverride[i])
        this.state.keyOverrideEntries[i] = keyOverride[i]
      }
    }

    const altRepeatKey = data.alt_repeat_key as AltRepeatKeyEntry[] | undefined
    if (altRepeatKey) {
      for (let i = 0; i < Math.min(altRepeatKey.length, this.state.dynamicCounts.altRepeatKey); i++) {
        await protocol.setAltRepeatKey(i, altRepeatKey[i])
        this.state.altRepeatKeyEntries[i] = altRepeatKey[i]
      }
    }
  }
}
