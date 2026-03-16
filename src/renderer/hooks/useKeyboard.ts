// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useRef } from 'react'
import { emptyState } from './keyboard-types'
import type { KeyboardState } from './keyboard-types'
import { useKeyboardReload } from './useKeyboardReload'
import { useKeyboardLoaders } from './useKeyboardLoaders'
import { useKeyboardSetters } from './useKeyboardSetters'
import { useKeyboardLighting } from './useKeyboardLighting'
import { useKeyboardPersistence } from './useKeyboardPersistence'

export type { BulkKeyEntry, KeyboardState } from './keyboard-types'

export function useKeyboard() {
  const [state, setState] = useState<KeyboardState>(emptyState())
  const stateRef = useRef(state)
  stateRef.current = state
  const [activityCount, setActivityCount] = useState(0)
  const bumpActivity = useCallback(() => setActivityCount((c) => c + 1), [])
  // Baseline QMK settings snapshot for pipette-file reset (captured at load time)
  const qmkSettingsBaselineRef = useRef<Record<string, number[]>>({})
  const saveLayerNamesRef = useRef<((names: string[]) => void) | null>(null)

  const refs = { stateRef, qmkSettingsBaselineRef, saveLayerNamesRef }

  const { reload } = useKeyboardReload(setState, refs)
  const { loadDummy, loadPipetteFile } = useKeyboardLoaders(setState, refs)
  const {
    setKey, setKeysBulk, setEncoder, setLayoutOptions, setMacroBuffer,
    setTapDanceEntry, setComboEntry, setKeyOverrideEntry, setAltRepeatKeyEntry,
    setLayerName, setSaveLayerNamesCallback,
  } = useKeyboardSetters(setState, stateRef, bumpActivity, saveLayerNamesRef)
  const {
    setBacklightBrightness, setBacklightEffect,
    setRgblightBrightness, setRgblightEffect, setRgblightEffectSpeed, setRgblightColor,
    setVialRGBMode, setVialRGBSpeed, setVialRGBColor, setVialRGBBrightness, setVialRGBHSV,
    updateQmkSettingsValue,
  } = useKeyboardLighting(setState, stateRef, bumpActivity)
  const {
    serialize, serializeVialGui, applyDefinition, applyVilFile,
    reset, refreshUnlockStatus,
    pipetteFileQmkSettingsGet, pipetteFileQmkSettingsSet, pipetteFileQmkSettingsReset,
  } = useKeyboardPersistence(setState, refs, bumpActivity)

  return {
    ...state,
    activityCount,
    reload,
    reset,
    refreshUnlockStatus,
    loadDummy,
    loadPipetteFile,
    pipetteFileQmkSettingsGet,
    pipetteFileQmkSettingsSet,
    pipetteFileQmkSettingsReset,
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
