// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useRef, useEffect } from 'react'
import { emptyState } from './keyboard-types'
import type { BootGuardRef, KeyboardState } from './keyboard-types'
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

  // Boot guard: Promise-based unlock gate for QK_BOOT writes
  const bootGuardRef = useRef<BootGuardRef>({ onUnlock: null })
  const unlockPromiseRef = useRef<{
    promise: Promise<void>
    resolve: () => void
    reject: (reason?: unknown) => void
  } | null>(null)

  const waitForUnlock = useCallback((): Promise<void> => {
    if (!unlockPromiseRef.current) {
      let resolve!: () => void
      let reject!: (reason?: unknown) => void
      const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
      unlockPromiseRef.current = { promise, resolve, reject }
    }
    return unlockPromiseRef.current.promise
  }, [])

  const rejectPendingUnlock = useCallback(() => {
    if (unlockPromiseRef.current) {
      unlockPromiseRef.current.reject(new Error('Unlock cancelled'))
      unlockPromiseRef.current = null
    }
  }, [])

  useEffect(() => {
    if (state.unlockStatus.unlocked && unlockPromiseRef.current) {
      unlockPromiseRef.current.resolve()
      unlockPromiseRef.current = null
    }
  }, [state.unlockStatus.unlocked])

  // Reject dangling unlock promise on unmount to prevent leaks
  useEffect(() => {
    return () => {
      if (unlockPromiseRef.current) {
        unlockPromiseRef.current.reject(new Error('Unmounted'))
        unlockPromiseRef.current = null
      }
    }
  }, [])

  const setBootGuardUnlock = useCallback((cb: () => void) => {
    bootGuardRef.current.onUnlock = cb
  }, [])

  const { reload } = useKeyboardReload(setState, refs)
  const { loadDummy, loadPipetteFile } = useKeyboardLoaders(setState, refs)
  const {
    setKey, setKeysBulk, setEncoder, setLayoutOptions, setMacroBuffer,
    setTapDanceEntry, setComboEntry, setKeyOverrideEntry, setAltRepeatKeyEntry,
    setLayerName, setSaveLayerNamesCallback,
  } = useKeyboardSetters(setState, stateRef, bumpActivity, saveLayerNamesRef, bootGuardRef, waitForUnlock)
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
  } = useKeyboardPersistence(setState, refs, bumpActivity, bootGuardRef, waitForUnlock)

  return {
    ...state,
    activityCount,
    reload,
    reset,
    refreshUnlockStatus,
    setBootGuardUnlock,
    rejectPendingUnlock,
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
