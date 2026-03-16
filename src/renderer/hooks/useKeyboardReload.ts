// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback } from 'react'
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
} from '../../shared/constants/protocol'
import { recreateKeyboardKeycodes } from '../../shared/keycodes/keycodes'
import { normalizeQmkSettingData } from '../../shared/qmk-settings-normalize'
import { emptyState, isEchoDetected } from './keyboard-types'
import type { SetState, KeyboardRefs } from './keyboard-types'
import { parseDefinitionLayout } from './keyboard-state-helpers'

export function useKeyboardReload(
  setState: SetState,
  refs: Pick<KeyboardRefs, 'stateRef' | 'qmkSettingsBaselineRef'>,
): { reload: () => Promise<string | null> } {
  const { qmkSettingsBaselineRef } = refs

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

      // Publish UID early so cloud sync can start in parallel with reload
      setState((s) => ({ ...s, uid: newState.uid, loading: true }))

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
          const { layout, encoderCount } = parseDefinitionLayout(newState.definition)
          newState.layout = layout
          newState.encoderCount = encoderCount
        }
      } catch (err) {
        console.error('[KB] definition fetch failed:', err)
      }

      // Phase 2.5 guard: definition is required to continue
      if (!newState.definition) {
        console.error('[KB] definition load failed — aborting reload')
        setState((s) => ({ ...s, loading: false }))
        return null
      }

      // Phase 2.6: Lighting data load
      const lt = newState.definition.lighting
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
        customKeycodes: newState.definition.customKeycodes ?? null,
        midi: newState.definition.vial?.midi ?? '',
        supportedFeatures,
      })

      // Phase 8a: QMK Settings discovery (matches Python reload_settings)
      progress('loading.settings')
      if (newState.vialProtocol >= VIAL_PROTOCOL_QMK_SETTINGS) {
        try {
          const supported = new Set<number>()
          await Promise.race([
            (async () => {
              let cur = 0
              while (cur !== 0xffff) {
                const result = await api.qmkSettingsQuery(cur)
                const prevCur = cur
                for (let i = 0; i + 1 < result.length; i += 2) {
                  const qsid = result[i] | (result[i + 1] << 8)
                  cur = Math.max(cur, qsid)
                  if (qsid !== 0xffff) {
                    supported.add(qsid)
                  }
                }
                if (cur === prevCur) break
              }
            })(),
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error('QMK settings discovery timeout')), 5000),
            ),
          ])
          newState.supportedQsids = supported
        } catch (err) {
          if (isEchoDetected(err)) {
            newState.connectionWarning = 'warning.echoDetected'
          } else {
            console.error('[KB] QMK settings discovery failed:', err)
          }
        }

        // Phase 8b: Fetch current values for each supported QSID.
        if (newState.supportedQsids.size > 0) {
          const values: Record<string, number[]> = {}
          let cancelled = false
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            await Promise.race([
              (async () => {
                for (const qsid of newState.supportedQsids) {
                  if (cancelled) break
                  try {
                    const data = await api.qmkSettingsGet(qsid)
                    if (!cancelled) {
                      values[String(qsid)] = normalizeQmkSettingData(qsid, data)
                    }
                  } catch {
                    console.warn(`[KB] Failed to read QMK setting ${qsid}, skipping`)
                  }
                }
              })(),
              new Promise<void>((_, reject) => {
                timer = setTimeout(() => reject(new Error('QMK settings value fetch timeout')), 5000)
              }),
            ])
          } catch {
            cancelled = true
            console.warn('[KB] QMK settings value fetch timed out, using partial data')
          } finally {
            clearTimeout(timer)
          }
          newState.qmkSettingsValues = values
          qmkSettingsBaselineRef.current = Object.fromEntries(
            Object.entries(values).map(([k, v]) => [k, [...v]]),
          )
        } else {
          // No supported QSIDs — clear stale baseline from prior reload
          newState.qmkSettingsValues = {}
          qmkSettingsBaselineRef.current = {}
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
  }, [setState, qmkSettingsBaselineRef])

  return { reload }
}
