// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useRef } from 'react'
import type {
  KeyboardDefinition,
  TapDanceEntry,
  ComboEntry,
  KeyOverrideEntry,
  AltRepeatKeyEntry,
  DynamicEntryCounts,
  UnlockStatus,
  VilFile,
} from '../../shared/types/protocol'
import {
  VIAL_PROTOCOL_DYNAMIC,
  VIAL_PROTOCOL_QMK_SETTINGS,
  VIAL_PROTOCOL_KEY_OVERRIDE,
  BUFFER_FETCH_CHUNK,
  QMK_BACKLIGHT_BRIGHTNESS,
  QMK_BACKLIGHT_EFFECT,
  QMK_RGBLIGHT_BRIGHTNESS,
  QMK_RGBLIGHT_EFFECT,
  QMK_RGBLIGHT_EFFECT_SPEED,
  QMK_RGBLIGHT_COLOR,
  ECHO_DETECTED_MSG,
} from '../../shared/constants/protocol'
import { mapToRecord, recordToMap } from '../../shared/vil-file'
import { vilToVialGuiJson } from '../../shared/vil-compat'
import { splitMacroBuffer, deserializeMacro, macroActionsToJson } from '../../preload/macro'
import { parseKle } from '../../shared/kle/kle-parser'
import type { KeyboardLayout } from '../../shared/kle/types'
import { recreateKeyboardKeycodes } from '../../shared/keycodes/keycodes'

export interface BulkKeyEntry {
  layer: number
  row: number
  col: number
  keycode: number
}

export interface KeyboardState {
  loading: boolean
  loadingProgress: string
  connectionWarning: string | null
  isDummy: boolean
  viaProtocol: number
  vialProtocol: number
  uid: string
  definition: KeyboardDefinition | null
  layout: KeyboardLayout | null
  layers: number
  rows: number
  cols: number
  keymap: Map<string, number> // "layer,row,col" -> keycode
  encoderLayout: Map<string, number> // "layer,idx,dir" -> keycode
  encoderCount: number
  layoutOptions: number
  macroCount: number
  macroBufferSize: number
  macroBuffer: number[]
  dynamicCounts: DynamicEntryCounts
  tapDanceEntries: TapDanceEntry[]
  comboEntries: ComboEntry[]
  keyOverrideEntries: KeyOverrideEntry[]
  altRepeatKeyEntries: AltRepeatKeyEntry[]
  unlockStatus: UnlockStatus
  // QMK Backlight
  backlightBrightness: number
  backlightEffect: number
  // QMK RGBlight
  rgblightBrightness: number
  rgblightEffect: number
  rgblightEffectSpeed: number
  rgblightHue: number
  rgblightSat: number
  // VialRGB
  vialRGBVersion: number
  vialRGBMaxBrightness: number
  vialRGBSupported: number[]
  vialRGBMode: number
  vialRGBSpeed: number
  vialRGBHue: number
  vialRGBSat: number
  vialRGBVal: number
  // QMK Settings
  supportedQsids: Set<number>
  // QMK Settings snapshot for .vil serialization
  qmkSettingsValues: Record<string, number[]>
  // Layer names (persisted per-UID, synced)
  layerNames: string[]
}

function emptyState(): KeyboardState {
  return {
    loading: false,
    loadingProgress: '',
    connectionWarning: null,
    isDummy: false,
    viaProtocol: -1,
    vialProtocol: -1,
    uid: '0x0',
    definition: null,
    layout: null,
    layers: 0,
    rows: 0,
    cols: 0,
    keymap: new Map(),
    encoderLayout: new Map(),
    encoderCount: 0,
    layoutOptions: -1,
    macroCount: 0,
    macroBufferSize: 0,
    macroBuffer: [],
    dynamicCounts: { tapDance: 0, combo: 0, keyOverride: 0, altRepeatKey: 0, featureFlags: 0 },
    tapDanceEntries: [],
    comboEntries: [],
    keyOverrideEntries: [],
    altRepeatKeyEntries: [],
    unlockStatus: { unlocked: false, inProgress: false, keys: [] },
    backlightBrightness: 0,
    backlightEffect: 0,
    rgblightBrightness: 0,
    rgblightEffect: 0,
    rgblightEffectSpeed: 0,
    rgblightHue: 0,
    rgblightSat: 0,
    vialRGBVersion: -1,
    vialRGBMaxBrightness: 255,
    vialRGBSupported: [],
    vialRGBMode: 0,
    vialRGBSpeed: 0,
    vialRGBHue: 0,
    vialRGBSat: 0,
    vialRGBVal: 0,
    supportedQsids: new Set(),
    qmkSettingsValues: {},
    layerNames: [],
  }
}

function isEchoDetected(err: unknown): boolean {
  return err instanceof Error && err.message.includes(ECHO_DETECTED_MSG)
}

export function useKeyboard() {
  const [state, setState] = useState<KeyboardState>(emptyState())
  const stateRef = useRef(state)
  stateRef.current = state
  const [activityCount, setActivityCount] = useState(0)
  const bumpActivity = useCallback(() => setActivityCount((c) => c + 1), [])

  const reload = useCallback(async (): Promise<string | null> => {
    const progress = (key: string) =>
      setState((s) => ({ ...s, loading: true, loadingProgress: key }))

    progress('loading.protocol')
    const api = window.vialAPI

    try {
      const newState = emptyState()
      newState.loading = true

      // Phase 1: Protocol + identity
      newState.viaProtocol = await api.getProtocolVersion()
      const kbId = await api.getKeyboardId()
      newState.vialProtocol = kbId.vialProtocol
      newState.uid = kbId.uid

      // Phase 2: Layer count + macros metadata
      progress('loading.definition')
      newState.layers = await api.getLayerCount()
      const prefs = await api.pipetteSettingsGet(newState.uid)
      const storedNames = prefs?.layerNames ?? []
      newState.layerNames = Array.from({ length: newState.layers }, (_, i) =>
        i < storedNames.length && typeof storedNames[i] === 'string' ? storedNames[i] : '',
      )
      newState.macroCount = await api.getMacroCount()
      newState.macroBufferSize = await api.getMacroBufferSize()

      // Phase 2.5: Definition load + KLE parse
      try {
        newState.definition = await api.getDefinition()
        if (newState.definition) {
          newState.rows = newState.definition.matrix.rows
          newState.cols = newState.definition.matrix.cols
          if (newState.definition.layouts?.keymap) {
            newState.layout = parseKle(newState.definition.layouts.keymap)
            const indices = new Set<number>()
            for (const key of newState.layout.keys) {
              if (key.encoderIdx >= 0) indices.add(key.encoderIdx)
            }
            newState.encoderCount = indices.size
          }
        }
      } catch (err) {
        console.error('[KB] definition fetch failed:', err)
      }

      // Phase 2.6: Lighting data load
      const lt = newState.definition?.lighting
      try {
        if (lt === 'vialrgb') {
          const info = await api.getVialRGBInfo()
          newState.vialRGBVersion = info.version
          newState.vialRGBMaxBrightness = info.maxBrightness
          if (info.version === 1) {
            newState.vialRGBSupported = await api.getVialRGBSupported()
            const mode = await api.getVialRGBMode()
            newState.vialRGBMode = mode.mode
            newState.vialRGBSpeed = mode.speed
            newState.vialRGBHue = mode.hue
            newState.vialRGBSat = mode.sat
            newState.vialRGBVal = mode.val
          } else {
            console.warn(
              `[KB] Unsupported VialRGB protocol version ${info.version}, expected 1. VialRGB controls disabled.`,
            )
          }
        }
        if (lt === 'qmk_backlight' || lt === 'qmk_backlight_rgblight') {
          const [br] = await api.getLightingValue(QMK_BACKLIGHT_BRIGHTNESS)
          newState.backlightBrightness = br
          const [fx] = await api.getLightingValue(QMK_BACKLIGHT_EFFECT)
          newState.backlightEffect = fx
        }
        if (lt === 'qmk_rgblight' || lt === 'qmk_backlight_rgblight') {
          const [br] = await api.getLightingValue(QMK_RGBLIGHT_BRIGHTNESS)
          newState.rgblightBrightness = br
          const [fx] = await api.getLightingValue(QMK_RGBLIGHT_EFFECT)
          newState.rgblightEffect = fx
          const [sp] = await api.getLightingValue(QMK_RGBLIGHT_EFFECT_SPEED)
          newState.rgblightEffectSpeed = sp
          const [h, s] = await api.getLightingValue(QMK_RGBLIGHT_COLOR)
          newState.rgblightHue = h
          newState.rgblightSat = s
        }
      } catch (err) {
        console.error('[KB] lighting data load failed:', err)
      }

      // Phase 3: Layout options
      progress('loading.keymap')
      newState.layoutOptions = await api.getLayoutOptions()

      // Phase 3.5: Keymap buffer fetch
      if (newState.rows > 0 && newState.cols > 0 && newState.layers > 0) {
        const totalSize = newState.layers * newState.rows * newState.cols * 2
        const buffer: number[] = []
        let fetchFailed = false
        for (let offset = 0; offset < totalSize; offset += BUFFER_FETCH_CHUNK) {
          const chunkSize = Math.min(BUFFER_FETCH_CHUNK, totalSize - offset)
          try {
            const chunk = await api.getKeymapBuffer(offset, chunkSize)
            buffer.push(...chunk)
          } catch (err) {
            console.error('[KB] keymap buffer fetch failed at offset', offset, err)
            fetchFailed = true
            break
          }
        }
        if (!fetchFailed) {
          for (let layer = 0; layer < newState.layers; layer++) {
            for (let row = 0; row < newState.rows; row++) {
              for (let col = 0; col < newState.cols; col++) {
                const idx =
                  (layer * newState.rows * newState.cols + row * newState.cols + col) * 2
                if (idx + 1 < buffer.length) {
                  newState.keymap.set(
                    `${layer},${row},${col}`,
                    (buffer[idx] << 8) | buffer[idx + 1],
                  )
                }
              }
            }
          }
        }
      }

      // Phase 3.6: Encoder keycode fetch
      if (newState.encoderCount > 0 && newState.layers > 0) {
        for (let layer = 0; layer < newState.layers; layer++) {
          for (let idx = 0; idx < newState.encoderCount; idx++) {
            try {
              const [cw, ccw] = await api.getEncoder(layer, idx)
              newState.encoderLayout.set(`${layer},${idx},0`, cw)
              newState.encoderLayout.set(`${layer},${idx},1`, ccw)
            } catch {
              // skip
            }
          }
        }
      }

      // Phase 4: Dynamic entry counts (Vial protocol >= 4)
      if (newState.vialProtocol >= VIAL_PROTOCOL_DYNAMIC) {
        try {
          newState.dynamicCounts = await api.getDynamicEntryCount()
        } catch (err) {
          if (isEchoDetected(err)) {
            newState.connectionWarning = 'warning.echoDetected'
          } else {
            console.error('[KB] dynamic entry count failed:', err)
          }
        }
      }

      // Phase 5: Macro buffer (non-fatal: empty buffer if fetch fails)
      progress('loading.macros')
      if (newState.macroBufferSize > 0) {
        try {
          newState.macroBuffer = await api.getMacroBuffer(newState.macroBufferSize)
        } catch (err) {
          console.error('[KB] macro buffer fetch failed:', err)
        }
      }

      // Phase 6: Dynamic entries (Vial protocol >= 4)
      progress('loading.dynamicEntries')
      // Each entry is fetched independently; failures skip the entry
      // rather than aborting the entire reload.
      if (newState.vialProtocol >= VIAL_PROTOCOL_DYNAMIC) {
        const { tapDance, combo, keyOverride, altRepeatKey } = newState.dynamicCounts

        for (let i = 0; i < tapDance; i++) {
          try {
            newState.tapDanceEntries.push(await api.getTapDance(i))
          } catch {
            // Skip failed entry
          }
        }
        for (let i = 0; i < combo; i++) {
          try {
            newState.comboEntries.push(await api.getCombo(i))
          } catch {
            // Skip failed entry
          }
        }
        for (let i = 0; i < keyOverride; i++) {
          try {
            newState.keyOverrideEntries.push(await api.getKeyOverride(i))
          } catch {
            // Skip failed entry
          }
        }
        for (let i = 0; i < altRepeatKey; i++) {
          try {
            newState.altRepeatKeyEntries.push(await api.getAltRepeatKey(i))
          } catch {
            // Skip failed entry
          }
        }
      }

      // Phase 7: Recreate keyboard-specific keycodes
      const { featureFlags } = newState.dynamicCounts
      const supportedFeatures = new Set<string>()
      if (featureFlags & 0x01) supportedFeatures.add('caps_word')
      if (featureFlags & 0x02) supportedFeatures.add('layer_lock')
      if (newState.vialProtocol >= VIAL_PROTOCOL_KEY_OVERRIDE) {
        supportedFeatures.add('persistent_default_layer')
      }
      if (newState.dynamicCounts.altRepeatKey > 0) {
        supportedFeatures.add('repeat_key')
      }

      recreateKeyboardKeycodes({
        vialProtocol: newState.vialProtocol,
        layers: newState.layers,
        macroCount: newState.macroCount,
        tapDanceCount: newState.dynamicCounts.tapDance,
        customKeycodes: newState.definition?.customKeycodes ?? null,
        midi: newState.definition?.vial?.midi ?? '',
        supportedFeatures,
      })

      // Phase 8: QMK Settings discovery (matches Python reload_settings)
      progress('loading.settings')
      if (newState.vialProtocol >= VIAL_PROTOCOL_QMK_SETTINGS) {
        try {
          const supported = new Set<number>()
          let cur = 0
          while (cur !== 0xffff) {
            const result = await api.qmkSettingsQuery(cur)
            for (let i = 0; i + 1 < result.length; i += 2) {
              const qsid = result[i] | (result[i + 1] << 8)
              cur = Math.max(cur, qsid)
              if (qsid !== 0xffff) {
                supported.add(qsid)
              }
            }
          }
          newState.supportedQsids = supported
        } catch (err) {
          if (isEchoDetected(err)) {
            newState.connectionWarning = 'warning.echoDetected'
          } else {
            console.error('[KB] QMK settings discovery failed:', err)
          }
        }
      }

      // Phase 9: Unlock status
      if (newState.vialProtocol >= 0) {
        try {
          newState.unlockStatus = await api.getUnlockStatus()
        } catch (err) {
          console.error('[KB] unlock status fetch failed:', err)
        }
      } else {
        // VIA-only keyboards are always unlocked
        newState.unlockStatus = { unlocked: true, inProgress: false, keys: [] }
      }

      newState.loading = false
      setState(newState)
      return newState.uid
    } catch (err) {
      console.error('[KB] reload failed:', err)
      setState((s) => ({ ...s, loading: false }))
      return null
    }
  }, [])

  const loadDummy = useCallback((definition: KeyboardDefinition) => {
    const DUMMY_LAYERS = 4
    const DUMMY_MACRO_COUNT = 16
    const DUMMY_MACRO_BUFFER_SIZE = 900

    const newState = emptyState()
    newState.isDummy = true
    newState.layers = DUMMY_LAYERS
    newState.layerNames = new Array<string>(DUMMY_LAYERS).fill('')
    newState.macroCount = DUMMY_MACRO_COUNT
    newState.macroBufferSize = DUMMY_MACRO_BUFFER_SIZE
    newState.macroBuffer = new Array(DUMMY_MACRO_BUFFER_SIZE).fill(0)
    newState.definition = definition
    newState.rows = definition.matrix.rows
    newState.cols = definition.matrix.cols
    newState.layoutOptions = 0
    newState.unlockStatus = { unlocked: true, inProgress: false, keys: [] }

    // Parse KLE layout
    if (definition.layouts?.keymap) {
      newState.layout = parseKle(definition.layouts.keymap)
      const indices = new Set<number>()
      for (const key of newState.layout.keys) {
        if (key.encoderIdx >= 0) indices.add(key.encoderIdx)
      }
      newState.encoderCount = indices.size
    }

    // Initialize keymap with KC_NO (0x0000)
    for (let layer = 0; layer < DUMMY_LAYERS; layer++) {
      for (let row = 0; row < newState.rows; row++) {
        for (let col = 0; col < newState.cols; col++) {
          newState.keymap.set(`${layer},${row},${col}`, 0x0000)
        }
      }
    }

    // Initialize encoder layout with KC_NO (0x0000)
    for (let layer = 0; layer < DUMMY_LAYERS; layer++) {
      for (let idx = 0; idx < newState.encoderCount; idx++) {
        newState.encoderLayout.set(`${layer},${idx},0`, 0x0000)
        newState.encoderLayout.set(`${layer},${idx},1`, 0x0000)
      }
    }

    // Recreate keycodes for the dummy keyboard
    recreateKeyboardKeycodes({
      vialProtocol: newState.vialProtocol,
      layers: newState.layers,
      macroCount: newState.macroCount,
      tapDanceCount: 0,
      customKeycodes: definition.customKeycodes ?? null,
      midi: definition.vial?.midi ?? '',
      supportedFeatures: new Set(),
    })

    setState(newState)
  }, [])

  const setKey = useCallback(
    async (layer: number, row: number, col: number, keycode: number) => {
      if (!stateRef.current.isDummy) {
        await window.vialAPI.setKeycode(layer, row, col, keycode)
      }
      setState((s) => {
        const newKeymap = new Map(s.keymap)
        newKeymap.set(`${layer},${row},${col}`, keycode)
        return { ...s, keymap: newKeymap }
      })
      bumpActivity()
    },
    [bumpActivity],
  )

  const setKeysBulk = useCallback(
    async (entries: BulkKeyEntry[]) => {
      if (entries.length === 0) return
      if (!stateRef.current.isDummy) {
        for (const { layer, row, col, keycode } of entries) {
          await window.vialAPI.setKeycode(layer, row, col, keycode)
        }
      }
      setState((s) => {
        const newKeymap = new Map(s.keymap)
        for (const { layer, row, col, keycode } of entries) {
          newKeymap.set(`${layer},${row},${col}`, keycode)
        }
        return { ...s, keymap: newKeymap }
      })
      bumpActivity()
    },
    [bumpActivity],
  )

  const setEncoder = useCallback(
    async (
      layer: number,
      idx: number,
      direction: number,
      keycode: number,
    ) => {
      if (!stateRef.current.isDummy) {
        await window.vialAPI.setEncoder(layer, idx, direction, keycode)
      }
      setState((s) => {
        const newLayout = new Map(s.encoderLayout)
        newLayout.set(`${layer},${idx},${direction}`, keycode)
        return { ...s, encoderLayout: newLayout }
      })
      bumpActivity()
    },
    [bumpActivity],
  )

  const setLayoutOptions = useCallback(async (options: number) => {
    if (!stateRef.current.isDummy) {
      await window.vialAPI.setLayoutOptions(options)
    }
    setState((s) => ({ ...s, layoutOptions: options }))
    bumpActivity()
  }, [bumpActivity])

  const setMacroBuffer = useCallback(async (buffer: number[]) => {
    if (!stateRef.current.isDummy) {
      await window.vialAPI.setMacroBuffer(buffer)
    }
    setState((s) => ({ ...s, macroBuffer: buffer }))
    bumpActivity()
  }, [bumpActivity])

  const setTapDanceEntry = useCallback(
    async (index: number, entry: TapDanceEntry) => {
      if (!stateRef.current.isDummy) {
        await window.vialAPI.setTapDance(index, entry)
      }
      setState((s) => {
        const entries = [...s.tapDanceEntries]
        entries[index] = entry
        return { ...s, tapDanceEntries: entries }
      })
      bumpActivity()
    },
    [bumpActivity],
  )

  const setComboEntry = useCallback(
    async (index: number, entry: ComboEntry) => {
      if (!stateRef.current.isDummy) {
        await window.vialAPI.setCombo(index, entry)
      }
      setState((s) => {
        const entries = [...s.comboEntries]
        entries[index] = entry
        return { ...s, comboEntries: entries }
      })
      bumpActivity()
    },
    [bumpActivity],
  )

  const setKeyOverrideEntry = useCallback(
    async (index: number, entry: KeyOverrideEntry) => {
      if (!stateRef.current.isDummy) {
        await window.vialAPI.setKeyOverride(index, entry)
      }
      setState((s) => {
        const entries = [...s.keyOverrideEntries]
        entries[index] = entry
        return { ...s, keyOverrideEntries: entries }
      })
      bumpActivity()
    },
    [bumpActivity],
  )

  const setAltRepeatKeyEntry = useCallback(
    async (index: number, entry: AltRepeatKeyEntry) => {
      if (!stateRef.current.isDummy) {
        await window.vialAPI.setAltRepeatKey(index, entry)
      }
      setState((s) => {
        const entries = [...s.altRepeatKeyEntries]
        entries[index] = entry
        return { ...s, altRepeatKeyEntries: entries }
      })
      bumpActivity()
    },
    [bumpActivity],
  )

  // --- Lighting setters ---

  const setBacklightBrightness = useCallback(async (v: number) => {
    if (!stateRef.current.isDummy) {
      await window.vialAPI.setLightingValue(QMK_BACKLIGHT_BRIGHTNESS, v)
    }
    setState((s) => ({ ...s, backlightBrightness: v }))
    bumpActivity()
  }, [bumpActivity])

  const setBacklightEffect = useCallback(async (v: number) => {
    if (!stateRef.current.isDummy) {
      await window.vialAPI.setLightingValue(QMK_BACKLIGHT_EFFECT, v)
    }
    setState((s) => ({ ...s, backlightEffect: v }))
    bumpActivity()
  }, [bumpActivity])

  const setRgblightBrightness = useCallback(async (v: number) => {
    if (!stateRef.current.isDummy) {
      await window.vialAPI.setLightingValue(QMK_RGBLIGHT_BRIGHTNESS, v)
    }
    setState((s) => ({ ...s, rgblightBrightness: v }))
    bumpActivity()
  }, [bumpActivity])

  const setRgblightEffect = useCallback(async (index: number) => {
    if (!stateRef.current.isDummy) {
      await window.vialAPI.setLightingValue(QMK_RGBLIGHT_EFFECT, index)
    }
    setState((s) => ({ ...s, rgblightEffect: index }))
    bumpActivity()
  }, [bumpActivity])

  const setRgblightEffectSpeed = useCallback(async (v: number) => {
    if (!stateRef.current.isDummy) {
      await window.vialAPI.setLightingValue(QMK_RGBLIGHT_EFFECT_SPEED, v)
    }
    setState((s) => ({ ...s, rgblightEffectSpeed: v }))
    bumpActivity()
  }, [bumpActivity])

  const setRgblightColor = useCallback(async (h: number, s: number) => {
    if (!stateRef.current.isDummy) {
      await window.vialAPI.setLightingValue(QMK_RGBLIGHT_COLOR, h, s)
    }
    setState((prev) => ({ ...prev, rgblightHue: h, rgblightSat: s }))
    bumpActivity()
  }, [bumpActivity])

  const setVialRGBMode = useCallback(async (mode: number) => {
    const s = stateRef.current
    if (!s.isDummy) {
      await window.vialAPI.setVialRGBMode(mode, s.vialRGBSpeed, s.vialRGBHue, s.vialRGBSat, s.vialRGBVal)
    }
    setState((prev) => ({ ...prev, vialRGBMode: mode }))
    bumpActivity()
  }, [bumpActivity])

  const setVialRGBSpeed = useCallback(async (speed: number) => {
    const s = stateRef.current
    if (!s.isDummy) {
      await window.vialAPI.setVialRGBMode(s.vialRGBMode, speed, s.vialRGBHue, s.vialRGBSat, s.vialRGBVal)
    }
    setState((prev) => ({ ...prev, vialRGBSpeed: speed }))
    bumpActivity()
  }, [bumpActivity])

  const setVialRGBColor = useCallback(async (h: number, s: number) => {
    const st = stateRef.current
    if (!st.isDummy) {
      await window.vialAPI.setVialRGBMode(st.vialRGBMode, st.vialRGBSpeed, h, s, st.vialRGBVal)
    }
    setState((prev) => ({ ...prev, vialRGBHue: h, vialRGBSat: s }))
    bumpActivity()
  }, [bumpActivity])

  const setVialRGBBrightness = useCallback(async (v: number) => {
    const s = stateRef.current
    if (!s.isDummy) {
      await window.vialAPI.setVialRGBMode(s.vialRGBMode, s.vialRGBSpeed, s.vialRGBHue, s.vialRGBSat, v)
    }
    setState((prev) => ({ ...prev, vialRGBVal: v }))
    bumpActivity()
  }, [bumpActivity])

  const setVialRGBHSV = useCallback(async (h: number, s: number, v: number) => {
    const st = stateRef.current
    if (!st.isDummy) {
      await window.vialAPI.setVialRGBMode(st.vialRGBMode, st.vialRGBSpeed, h, s, v)
    }
    setState((prev) => ({ ...prev, vialRGBHue: h, vialRGBSat: s, vialRGBVal: v }))
    bumpActivity()
  }, [bumpActivity])

  const updateQmkSettingsValue = useCallback((qsid: number, data: number[]) => {
    setState((s) => ({
      ...s,
      qmkSettingsValues: { ...s.qmkSettingsValues, [String(qsid)]: data },
    }))
    bumpActivity()
  }, [bumpActivity])

  const saveLayerNamesRef = useRef<((names: string[]) => void) | null>(null)

  const setSaveLayerNamesCallback = useCallback((cb: (names: string[]) => void) => {
    saveLayerNamesRef.current = cb
  }, [])

  const setLayerName = useCallback((layer: number, name: string) => {
    const names = [...stateRef.current.layerNames]
    while (names.length <= layer) names.push('')
    names[layer] = name
    saveLayerNamesRef.current?.(names)
    setState((s) => ({ ...s, layerNames: names }))
  }, [])

  const serialize = useCallback((): VilFile => {
    const s = stateRef.current
    return {
      uid: s.uid,
      keymap: mapToRecord(s.keymap),
      encoderLayout: mapToRecord(s.encoderLayout),
      macros: s.macroBuffer,
      layoutOptions: s.layoutOptions,
      tapDance: s.tapDanceEntries,
      combo: s.comboEntries,
      keyOverride: s.keyOverrideEntries,
      altRepeatKey: s.altRepeatKeyEntries,
      qmkSettings: s.qmkSettingsValues,
      layerNames: s.layerNames,
    }
  }, [])

  const serializeVialGui = useCallback((): string => {
    const s = stateRef.current
    const vil = serialize()
    const macroActions = splitMacroBuffer(s.macroBuffer, s.macroCount)
      .map((m) => JSON.parse(macroActionsToJson(deserializeMacro(m, s.vialProtocol))) as unknown[])
    return vilToVialGuiJson(vil, {
      rows: s.rows,
      cols: s.cols,
      layers: s.layers,
      encoderCount: s.encoderCount,
      vialProtocol: s.vialProtocol,
      viaProtocol: s.viaProtocol,
      macroActions,
    })
  }, [serialize])

  const applyDefinition = useCallback((def: KeyboardDefinition) => {
    setState((s) => {
      const newState = { ...s, definition: def }
      newState.rows = def.matrix.rows
      newState.cols = def.matrix.cols
      if (def.layouts?.keymap) {
        newState.layout = parseKle(def.layouts.keymap)
        const indices = new Set<number>()
        for (const key of newState.layout.keys) {
          if (key.encoderIdx >= 0) indices.add(key.encoderIdx)
        }
        newState.encoderCount = indices.size
      }
      return newState
    })
  }, [])

  const applyVilFile = useCallback(async (vil: VilFile) => {
    const isDummy = stateRef.current.isDummy

    const keymap = recordToMap(vil.keymap)
    const encoderLayout = recordToMap(vil.encoderLayout)

    if (!isDummy) {
      const api = window.vialAPI

      // Apply keymap
      for (const [key, keycode] of keymap) {
        const [layer, row, col] = key.split(',').map(Number)
        await api.setKeycode(layer, row, col, keycode)
      }

      // Apply encoder layout
      for (const [key, keycode] of encoderLayout) {
        const [layer, idx, direction] = key.split(',').map(Number)
        await api.setEncoder(layer, idx, direction, keycode)
      }

      // Apply macros
      if (vil.macros.length > 0) {
        await api.setMacroBuffer(vil.macros)
      }

      // Apply layout options
      await api.setLayoutOptions(vil.layoutOptions)

      // Apply tap dance entries
      for (let i = 0; i < vil.tapDance.length; i++) {
        await api.setTapDance(i, vil.tapDance[i])
      }

      // Apply combo entries
      for (let i = 0; i < vil.combo.length; i++) {
        await api.setCombo(i, vil.combo[i])
      }

      // Apply key override entries
      for (let i = 0; i < vil.keyOverride.length; i++) {
        await api.setKeyOverride(i, vil.keyOverride[i])
      }

      // Apply alt repeat key entries
      for (let i = 0; i < vil.altRepeatKey.length; i++) {
        await api.setAltRepeatKey(i, vil.altRepeatKey[i])
      }

      // Apply QMK settings
      for (const [qsid, data] of Object.entries(vil.qmkSettings)) {
        await api.qmkSettingsSet(Number(qsid), data)
      }
    }

    // Update local state
    const currentLayers = stateRef.current.layers
    const layerNames = Array.from({ length: currentLayers }, (_, i) => vil.layerNames?.[i] ?? '')
    saveLayerNamesRef.current?.(layerNames)

    setState((s) => ({
      ...s,
      keymap,
      encoderLayout,
      macroBuffer: vil.macros,
      layoutOptions: vil.layoutOptions,
      tapDanceEntries: vil.tapDance,
      comboEntries: vil.combo,
      keyOverrideEntries: vil.keyOverride,
      altRepeatKeyEntries: vil.altRepeatKey,
      qmkSettingsValues: vil.qmkSettings,
      layerNames,
    }))
  }, [])

  const reset = useCallback(() => {
    setState(emptyState())
  }, [])

  const refreshUnlockStatus = useCallback(async () => {
    try {
      const unlockStatus = await window.vialAPI.getUnlockStatus()
      setState((s) => ({ ...s, unlockStatus }))
    } catch (err) {
      console.error('[KB] unlock status refresh failed:', err)
    }
  }, [])

  return {
    ...state,
    activityCount,
    reload,
    reset,
    refreshUnlockStatus,
    loadDummy,
    setKey,
    setKeysBulk,
    setEncoder,
    setLayoutOptions,
    setMacroBuffer,
    setTapDanceEntry,
    setComboEntry,
    setKeyOverrideEntry,
    setAltRepeatKeyEntry,
    setBacklightBrightness,
    setBacklightEffect,
    setRgblightBrightness,
    setRgblightEffect,
    setRgblightEffectSpeed,
    setRgblightColor,
    setVialRGBMode,
    setVialRGBSpeed,
    setVialRGBColor,
    setVialRGBBrightness,
    setVialRGBHSV,
    serialize,
    serializeVialGui,
    applyDefinition,
    applyVilFile,
    updateQmkSettingsValue,
    setLayerName,
    setSaveLayerNamesCallback,
  }
}
