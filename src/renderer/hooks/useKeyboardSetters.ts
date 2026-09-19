// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback } from 'react'
import type {
  TapDanceEntry,
  ComboEntry,
  KeyOverrideEntry,
  AltRepeatKeyEntry,
} from '../../shared/types/protocol'
import type { MacroAction } from '../../preload/macro'
import type { BootGuardRef, BulkKeyEntry, SetState, KeyboardState } from './keyboard-types'
import { BulkKeyWriteError } from './keyboard-types'
import { isResetKeycode } from '../../shared/keycodes/keycodes'

export function useKeyboardSetters(
  setState: SetState,
  stateRef: React.MutableRefObject<KeyboardState>,
  bumpActivity: () => void,
  saveLayerNamesRef: React.MutableRefObject<((names: string[]) => void) | null>,
  bootGuardRef: React.MutableRefObject<BootGuardRef>,
  waitForUnlock: () => Promise<void>,
) {
  // Shared by every write path that can include a reset keycode: if the
  // device is locked and at least one of `keycodes` is a reset keycode,
  // trigger the boot-guard prompt and wait for the unlock before writing
  // anything. A single-key call passes its one keycode; setKeysBulk passes
  // the whole entry list so the gate runs once for the batch instead of
  // per entry.
  const ensureUnlockedFor = useCallback(
    async (keycodes: number[]) => {
      if (stateRef.current.unlockStatus.unlocked === false && keycodes.some(isResetKeycode)) {
        bootGuardRef.current.onUnlock?.()
        await waitForUnlock()
      }
    },
    [stateRef, bootGuardRef, waitForUnlock],
  )

  const guardedCall = useCallback(
    async (keycode: number, fn: () => Promise<void>) => {
      await ensureUnlockedFor([keycode])
      await fn()
    },
    [ensureUnlockedFor],
  )

  const setKey = useCallback(
    async (layer: number, row: number, col: number, keycode: number) => {
      if (!stateRef.current.isDummy) {
        await guardedCall(keycode, () => window.vialAPI.setKeycode(layer, row, col, keycode))
      }
      setState((s) => {
        const newKeymap = new Map(s.keymap)
        newKeymap.set(`${layer},${row},${col}`, keycode)
        return { ...s, keymap: newKeymap }
      })
      bumpActivity()
    },
    [setState, stateRef, bumpActivity, guardedCall],
  )

  /** Commits `entries` (or a landed prefix of them) into `state.keymap`. */
  const applyBulkKeymap = useCallback((entries: BulkKeyEntry[]) => {
    setState((s) => {
      const newKeymap = new Map(s.keymap)
      for (const { layer, row, col, keycode } of entries) {
        newKeymap.set(`${layer},${row},${col}`, keycode)
      }
      return { ...s, keymap: newKeymap }
    })
    bumpActivity()
  }, [setState, bumpActivity])

  // Invariant callers rely on: every failure of the non-dummy path below
  // (preflight unlock or a write mid-loop) rejects with a
  // `BulkKeyWriteError`, never a bare error.
  const setKeysBulk = useCallback(
    async (entries: BulkKeyEntry[]) => {
      if (entries.length === 0) return
      if (!stateRef.current.isDummy) {
        // Preflight: a reset keycode on a locked device waits for the
        // unlock BEFORE anything is written, so a cancelled unlock fails
        // with nothing applied. Past this point the loop writes directly —
        // no entry needs an unlock wait of its own.
        try {
          await ensureUnlockedFor(entries.map(({ keycode }) => keycode))
        } catch (err) {
          throw new BulkKeyWriteError(0, err)
        }
        let appliedCount = 0
        try {
          for (const { layer, row, col, keycode } of entries) {
            await window.vialAPI.setKeycode(layer, row, col, keycode)
            appliedCount++
          }
        } catch (err) {
          if (appliedCount > 0) applyBulkKeymap(entries.slice(0, appliedCount))
          throw new BulkKeyWriteError(appliedCount, err)
        }
      }
      applyBulkKeymap(entries)
    },
    [stateRef, ensureUnlockedFor, applyBulkKeymap],
  )

  const setEncoder = useCallback(
    async (
      layer: number,
      idx: number,
      direction: number,
      keycode: number,
    ) => {
      if (!stateRef.current.isDummy) {
        await guardedCall(keycode, () => window.vialAPI.setEncoder(layer, idx, direction, keycode))
      }
      setState((s) => {
        const newLayout = new Map(s.encoderLayout)
        newLayout.set(`${layer},${idx},${direction}`, keycode)
        return { ...s, encoderLayout: newLayout }
      })
      bumpActivity()
    },
    [setState, stateRef, bumpActivity, guardedCall],
  )

  const setLayoutOptions = useCallback(async (options: number) => {
    if (!stateRef.current.isDummy) {
      await window.vialAPI.setLayoutOptions(options)
    }
    setState((s) => ({ ...s, layoutOptions: options }))
    bumpActivity()
  }, [setState, stateRef, bumpActivity])

  const setMacroBuffer = useCallback(async (buffer: number[], parsedMacros?: MacroAction[][]) => {
    if (!stateRef.current.isDummy) {
      await window.vialAPI.setMacroBuffer(buffer)
    }
    setState((s) => ({ ...s, macroBuffer: buffer, parsedMacros: parsedMacros ?? null }))
    bumpActivity()
  }, [setState, stateRef, bumpActivity])

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
    [setState, stateRef, bumpActivity],
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
    [setState, stateRef, bumpActivity],
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
    [setState, stateRef, bumpActivity],
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
    [setState, stateRef, bumpActivity],
  )

  const setSaveLayerNamesCallback = useCallback((cb: (names: string[]) => void) => {
    saveLayerNamesRef.current = cb
  }, [saveLayerNamesRef])

  const setLayerName = useCallback((layer: number, name: string) => {
    const names = [...stateRef.current.layerNames]
    while (names.length <= layer) names.push('')
    names[layer] = name
    saveLayerNamesRef.current?.(names)
    setState((s) => ({ ...s, layerNames: names }))
    bumpActivity()
  }, [setState, stateRef, bumpActivity, saveLayerNamesRef])

  return {
    setKey,
    setKeysBulk,
    setEncoder,
    setLayoutOptions,
    setMacroBuffer,
    setTapDanceEntry,
    setComboEntry,
    setKeyOverrideEntry,
    setAltRepeatKeyEntry,
    setLayerName,
    setSaveLayerNamesCallback,
  }
}
