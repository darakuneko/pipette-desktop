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
import type { SetState, KeyboardRefs, ReloadResult } from './keyboard-types'
import { parseDefinitionLayout } from '../../shared/kle/definition-layout'

export function useKeyboardReload(
  setState: SetState,
  refs: Pick<KeyboardRefs, 'qmkSettingsBaselineRef'>,
): { reload: () => Promise<ReloadResult> } {
  const { qmkSettingsBaselineRef } = refs

  const reload = useCallback(async (): Promise<ReloadResult> => {
    let currentPhase = ''
    const progress = (key: string) => {
      currentPhase = key
      setState((s) => ({ ...s, loading: true, loadingProgress: key }))
    }

    progress('loading.protocol')
    const api = window.vialAPI

    const fail = (reason: 'notVial' | 'loadFailed', err: unknown): ReloadResult => {
      console.error(`[KB] reload failed during ${currentPhase}:`, err)
      setState((s) => ({ ...s, loading: false }))
      return { ok: false, reason }
    }

    // Phase 1: Protocol + identity. getKeyboardId() doesn't validate
    // anything, so a VIA-only board can echo it back and "succeed" —
    // the definition load below is what actually proves Vial support.
    // A failure here, or a null definition, is classified notVial; any
    // other failure past that point is loadFailed.
    let viaProtocol: number
    let vialProtocol: number
    let uid: string
    try {
      viaProtocol = await api.getProtocolVersion()
      const kbId = await api.getKeyboardId()
      vialProtocol = kbId.vialProtocol
      uid = kbId.uid

      // Publish UID early so cloud sync can start in parallel with reload
      setState((s) => ({ ...s, uid, loading: true }))
    } catch (err) {
      return fail('notVial', err)
    }

    try {
      const newState = emptyState()
      newState.loading = true
      qmkSettingsBaselineRef.current = {}
      newState.viaProtocol = viaProtocol
      newState.vialProtocol = vialProtocol
      newState.uid = uid

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

      // Phase 2.5: Definition load + KLE parse. getDefinition() never
      // throws — it swallows transport, LZMA, and JSON failures into a
      // null return — but a null definition means the board never
      // proved it speaks Vial, so this reports notVial directly
      // instead of routing through the loadFailed catch below.
      newState.definition = await api.getDefinition()
      if (!newState.definition) {
        return fail('notVial', new Error('definition load failed'))
      }
      newState.rows = newState.definition.matrix.rows
      newState.cols = newState.definition.matrix.cols
      const { layout, encoderCount } = parseDefinitionLayout(newState.definition)
      newState.layout = layout
      newState.encoderCount = encoderCount

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
        // echo outranks partialLoad: a plain partial-load warning never
        // replaces an earlier echo (see the dynamic-entry-count and QMK
        // discovery catches below, which assign echoDetected unconditionally).
        newState.connectionWarning ??= 'warning.partialLoad'
      }

      // Phase 3: Layout options
      progress('loading.keymap')
      newState.layoutOptions = await api.getLayoutOptions()

      // Phase 3.5: Keymap buffer fetch
      if (newState.rows > 0 && newState.cols > 0 && newState.layers > 0) {
        const totalSize = newState.layers * newState.rows * newState.cols * 2
        const buffer: number[] = []
        for (let offset = 0; offset < totalSize; offset += BUFFER_FETCH_CHUNK) {
          const chunkSize = Math.min(BUFFER_FETCH_CHUNK, totalSize - offset)
          const chunk = await api.getKeymapBuffer(offset, chunkSize)
          buffer.push(...chunk)
        }
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

      // Phase 3.6: Encoder keycode fetch
      if (newState.encoderCount > 0 && newState.layers > 0) {
        for (let layer = 0; layer < newState.layers; layer++) {
          for (let idx = 0; idx < newState.encoderCount; idx++) {
            const [cw, ccw] = await api.getEncoder(layer, idx)
            newState.encoderLayout.set(`${layer},${idx},0`, cw)
            newState.encoderLayout.set(`${layer},${idx},1`, ccw)
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
            throw err
          }
        }
      }

      // Phase 5: Macro buffer
      progress('loading.macros')
      if (newState.macroBufferSize > 0) {
        newState.macroBuffer = await api.getMacroBuffer(newState.macroBufferSize)
      }

      // Phase 6: Dynamic entries (Vial protocol >= 4)
      progress('loading.dynamicEntries')
      if (newState.vialProtocol >= VIAL_PROTOCOL_DYNAMIC) {
        const { tapDance, combo, keyOverride, altRepeatKey } = newState.dynamicCounts

        for (let i = 0; i < tapDance; i++) {
          newState.tapDanceEntries.push(await api.getTapDance(i))
        }
        for (let i = 0; i < combo; i++) {
          newState.comboEntries.push(await api.getCombo(i))
        }
        for (let i = 0; i < keyOverride; i++) {
          newState.keyOverrideEntries.push(await api.getKeyOverride(i))
        }
        for (let i = 0; i < altRepeatKey; i++) {
          newState.altRepeatKeyEntries.push(await api.getAltRepeatKey(i))
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
        let discoveryCancelled = false
        let discoveryTimer: ReturnType<typeof setTimeout> | undefined
        try {
          const supported = new Set<number>()
          await Promise.race([
            (async () => {
              let cur = 0
              while (cur !== 0xffff) {
                if (discoveryCancelled) break
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
            new Promise<void>((_, reject) => {
              discoveryTimer = setTimeout(
                () => reject(new Error('QMK settings discovery timeout')),
                5000,
              )
            }),
          ])
          newState.supportedQsids = supported
        } catch (err) {
          // Stop the detached loop above from querying further pages
          // after a timeout — it keeps running otherwise since nothing
          // else cancels it.
          discoveryCancelled = true
          if (isEchoDetected(err)) {
            newState.connectionWarning = 'warning.echoDetected'
          } else {
            console.error('[KB] QMK settings discovery failed:', err)
            newState.connectionWarning ??= 'warning.partialLoad'
          }
        } finally {
          clearTimeout(discoveryTimer)
        }

        // Phase 8b: Fetch current values for each supported QSID. A qsid
        // that fails to read, or a timeout that cuts the fetch off early,
        // discards the whole batch rather than keeping a partial record —
        // backfillQmkSettings() copies these values into a snapshot only
        // while the snapshot has none, and never touches it again once
        // it has any, so a partial record here would freeze the missing
        // qsids out of that snapshot for good.
        if (newState.supportedQsids.size > 0) {
          const values: Record<string, number[]> = {}
          let cancelled = false
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            await Promise.race([
              (async () => {
                for (const qsid of newState.supportedQsids) {
                  if (cancelled) break
                  const data = await api.qmkSettingsGet(qsid)
                  // A read that resolves after the 5s timeout already fired
                  // still lands here, but that's harmless — the catch below
                  // never copies `values` into newState.qmkSettingsValues,
                  // so this write is simply discarded.
                  values[String(qsid)] = normalizeQmkSettingData(qsid, data)
                }
              })(),
              new Promise<void>((_, reject) => {
                timer = setTimeout(() => reject(new Error('QMK settings value fetch timeout')), 5000)
              }),
            ])
            newState.qmkSettingsValues = values
            qmkSettingsBaselineRef.current = Object.fromEntries(
              Object.entries(values).map(([k, v]) => [k, [...v]]),
            )
          } catch {
            // Stop the detached loop above from reading further qsids
            // after a timeout — it keeps running otherwise since nothing
            // else cancels it.
            cancelled = true
            console.warn('[KB] QMK settings value fetch failed or timed out, discarding partial data')
            newState.connectionWarning ??= 'warning.partialLoad'
          } finally {
            clearTimeout(timer)
          }
        }
      }

      // Phase 9: Unlock status
      if (newState.vialProtocol >= 0) {
        try {
          newState.unlockStatus = await api.getUnlockStatus()
          newState.unlockStatusKnown = true
        } catch (err) {
          console.error('[KB] unlock status fetch failed:', err)
          newState.connectionWarning ??= 'warning.partialLoad'
        }
      } else {
        // VIA-only keyboards are always unlocked
        newState.unlockStatus = { unlocked: true, inProgress: false, keys: [] }
        newState.unlockStatusKnown = true
      }

      newState.loading = false
      setState(newState)
      return { ok: true, uid: newState.uid }
    } catch (err) {
      return fail('loadFailed', err)
    }
  }, [setState, qmkSettingsBaselineRef])

  return { reload }
}
