// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback } from 'react'
import type { KeyboardDefinition, VilFile } from '../../shared/types/protocol'
import { mapToRecord, recordToMap, VILFILE_CURRENT_VERSION } from '../../shared/vil-file'
import { vilToVialGuiJson } from '../../shared/vil-compat'
import { splitMacroBuffer, deserializeMacro, macroActionsToJson, jsonToMacroActions } from '../../preload/macro'
import { parseKle } from '../../shared/kle/kle-parser'
import type { SetState, KeyboardRefs } from './keyboard-types'
import { emptyState } from './keyboard-types'

export function useKeyboardPersistence(
  setState: SetState,
  refs: KeyboardRefs,
  bumpActivity: () => void,
) {
  const { stateRef, qmkSettingsBaselineRef, saveLayerNamesRef } = refs

  const serialize = useCallback((): VilFile => {
    const s = stateRef.current
    const macrosSrc = s.parsedMacros
      ?? splitMacroBuffer(s.macroBuffer, s.macroCount).map((m) => deserializeMacro(m, s.vialProtocol))
    return {
      version: VILFILE_CURRENT_VERSION,
      uid: s.uid,
      keymap: mapToRecord(s.keymap),
      encoderLayout: mapToRecord(s.encoderLayout),
      macros: s.macroBuffer,
      macroJson: macrosSrc.map((m) => JSON.parse(macroActionsToJson(m)) as unknown[]),
      layoutOptions: s.layoutOptions,
      tapDance: s.tapDanceEntries,
      combo: s.comboEntries,
      keyOverride: s.keyOverrideEntries,
      altRepeatKey: s.altRepeatKeyEntries,
      qmkSettings: s.qmkSettingsValues,
      layerNames: s.layerNames,
      viaProtocol: s.viaProtocol,
      vialProtocol: s.vialProtocol,
      featureFlags: s.dynamicCounts.featureFlags,
      definition: s.definition ?? undefined,
    }
  }, [stateRef])

  const serializeVialGui = useCallback((): string => {
    const s = stateRef.current
    const vil = serialize()
    const macrosSrc = s.parsedMacros
      ?? splitMacroBuffer(s.macroBuffer, s.macroCount).map((m) => deserializeMacro(m, s.vialProtocol))
    const macroActions = macrosSrc.map((m) => JSON.parse(macroActionsToJson(m)) as unknown[])
    return vilToVialGuiJson(vil, {
      rows: s.rows,
      cols: s.cols,
      layers: s.layers,
      encoderCount: s.encoderCount,
      vialProtocol: s.vialProtocol,
      viaProtocol: s.viaProtocol,
      macroActions,
    })
  }, [stateRef, serialize])

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
  }, [setState])

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
      parsedMacros: vil.macroJson
        ? vil.macroJson.map((m) => jsonToMacroActions(JSON.stringify(m)) ?? [])
        : null,
      layoutOptions: vil.layoutOptions,
      tapDanceEntries: vil.tapDance,
      comboEntries: vil.combo,
      keyOverrideEntries: vil.keyOverride,
      altRepeatKeyEntries: vil.altRepeatKey,
      qmkSettingsValues: vil.qmkSettings,
      layerNames,
    }))
  }, [setState, stateRef, saveLayerNamesRef])

  const reset = useCallback(() => {
    setState(emptyState())
    qmkSettingsBaselineRef.current = {}
  }, [setState, qmkSettingsBaselineRef])

  const refreshUnlockStatus = useCallback(async () => {
    try {
      const unlockStatus = await window.vialAPI.getUnlockStatus()
      setState((s) => ({ ...s, unlockStatus }))
    } catch (err) {
      console.error('[KB] unlock status refresh failed:', err)
    }
  }, [setState])

  // Pipette-file QMK settings wrappers (read/write local state, no HID)
  const pipetteFileQmkSettingsGet = useCallback(async (qsid: number): Promise<number[]> => {
    return stateRef.current.qmkSettingsValues[String(qsid)] ?? []
  }, [stateRef])

  const pipetteFileQmkSettingsSet = useCallback(async (qsid: number, data: number[]): Promise<void> => {
    setState((s) => ({
      ...s,
      qmkSettingsValues: { ...s.qmkSettingsValues, [String(qsid)]: data },
    }))
    bumpActivity()
  }, [setState, bumpActivity])

  const pipetteFileQmkSettingsReset = useCallback(async (): Promise<void> => {
    setState((s) => ({
      ...s,
      qmkSettingsValues: Object.fromEntries(
        Object.entries(qmkSettingsBaselineRef.current).map(([k, v]) => [k, [...v]]),
      ),
    }))
    bumpActivity()
  }, [setState, qmkSettingsBaselineRef, bumpActivity])

  return {
    serialize,
    serializeVialGui,
    applyDefinition,
    applyVilFile,
    reset,
    refreshUnlockStatus,
    pipetteFileQmkSettingsGet,
    pipetteFileQmkSettingsSet,
    pipetteFileQmkSettingsReset,
  }
}
