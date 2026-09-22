// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback } from 'react'
import type { KeyboardDefinition, VilFile } from '../../shared/types/protocol'
import type { VialAPI } from '../../shared/types/vial-api'
import { mapToRecord, recordToMap, VILFILE_CURRENT_VERSION } from '../../shared/vil-file'
import { vilToVialGuiJson } from '../../shared/vil-compat'
import { splitMacroBuffer, deserializeMacro, macroActionsToJson, jsonToMacroActions } from '../../preload/macro'
import { parseDefinitionLayout } from '../../shared/kle/definition-layout'
import type { SetState, KeyboardRefs, BootGuardRef, ApplyVilResult, KeyboardState } from './keyboard-types'
import { emptyState } from './keyboard-types'
import { padMacroBuffer } from './pad-macro-buffer'

/** The subset of `VilFile` that `writeVilToDevice` actually writes over
 *  HID. `serializeDeviceFields()` produces exactly this — the fields
 *  `serialize()` adds on top (`macroJson`, `layerNames`, protocol/feature
 *  metadata, `definition`) are for file/snapshot storage and UI display,
 *  never read by an apply or a rollback. */
type DeviceVilFields = Pick<
  VilFile,
  | 'keymap'
  | 'encoderLayout'
  | 'macros'
  | 'layoutOptions'
  | 'tapDance'
  | 'combo'
  | 'keyOverride'
  | 'altRepeatKey'
  | 'qmkSettings'
>

/** Writes every device-facing field of `vil` over HID, in the same order
 *  `applyVilFile` always has. Used both for the real apply (whatever the
 *  caller passes as `vil.qmkSettings` — already filtered to supported
 *  qsids) and for rollback (writing a pre-apply `serializeDeviceFields()`
 *  snapshot back). `maps` are the already-converted keymap/encoderLayout
 *  Maps — the caller computes these once (it needs them for `setState`
 *  too, in the success case) rather than this function re-deriving them
 *  from `vil.keymap`/`vil.encoderLayout` on every call. `opts.padMacrosTo`,
 *  when a positive length is given, always writes exactly that many macro
 *  bytes (truncating or zero-padding `vil.macros` to fit) instead of the
 *  normal "skip if empty" rule — rollback needs this because a backup's
 *  macro buffer can be shorter than the device's actual buffer size
 *  (`setMacroBuffer` stores whatever array it was given, so a shorter
 *  post-edit write leaves state shorter than `macroBufferSize`); writing
 *  only the short backup back would leave the tail of a longer,
 *  since-applied macro buffer on the device. */
async function writeVilToDevice(
  api: VialAPI,
  vil: DeviceVilFields,
  maps: { keymap: Map<string, number>; encoderLayout: Map<string, number> },
  opts?: { padMacrosTo?: number },
): Promise<void> {
  for (const [key, keycode] of maps.keymap) {
    const [layer, row, col] = key.split(',').map(Number)
    await api.setKeycode(layer, row, col, keycode)
  }

  for (const [key, keycode] of maps.encoderLayout) {
    const [layer, idx, direction] = key.split(',').map(Number)
    await api.setEncoder(layer, idx, direction, keycode)
  }

  if (opts?.padMacrosTo && opts.padMacrosTo > 0) {
    await api.setMacroBuffer(padMacroBuffer(vil.macros, opts.padMacrosTo))
  } else if (vil.macros.length > 0) {
    await api.setMacroBuffer(vil.macros)
  }

  await api.setLayoutOptions(vil.layoutOptions)

  for (let i = 0; i < vil.tapDance.length; i++) {
    await api.setTapDance(i, vil.tapDance[i])
  }

  for (let i = 0; i < vil.combo.length; i++) {
    await api.setCombo(i, vil.combo[i])
  }

  for (let i = 0; i < vil.keyOverride.length; i++) {
    await api.setKeyOverride(i, vil.keyOverride[i])
  }

  for (let i = 0; i < vil.altRepeatKey.length; i++) {
    await api.setAltRepeatKey(i, vil.altRepeatKey[i])
  }

  for (const [qsid, data] of Object.entries(vil.qmkSettings)) {
    await api.qmkSettingsSet(Number(qsid), data)
  }
}

export function useKeyboardPersistence(
  setState: SetState,
  refs: KeyboardRefs,
  bumpActivity: () => void,
  bootGuardRef: React.MutableRefObject<BootGuardRef>,
  waitForUnlock: () => Promise<void>,
) {
  const { stateRef, qmkSettingsBaselineRef, saveLayerNamesRef } = refs

  // Exactly the fields `writeVilToDevice` needs, so an apply's pre-write
  // backup (and `serialize()` itself) don't pay for building `macroJson`
  // (a split + deserialize + JSON round trip per macro) on every apply,
  // including the success path, when only a failed apply's rollback ever
  // reads the backup.
  const serializeDeviceFields = useCallback((): DeviceVilFields => {
    const s = stateRef.current
    return {
      keymap: mapToRecord(s.keymap),
      encoderLayout: mapToRecord(s.encoderLayout),
      macros: s.macroBuffer,
      layoutOptions: s.layoutOptions,
      tapDance: s.tapDanceEntries,
      combo: s.comboEntries,
      keyOverride: s.keyOverrideEntries,
      altRepeatKey: s.altRepeatKeyEntries,
      qmkSettings: s.qmkSettingsValues,
    }
  }, [stateRef])

  const serialize = useCallback((): VilFile => {
    const s = stateRef.current
    const macrosSrc = s.parsedMacros
      ?? splitMacroBuffer(s.macroBuffer, s.macroCount).map((m) => deserializeMacro(m, s.vialProtocol))
    return {
      version: VILFILE_CURRENT_VERSION,
      uid: s.uid,
      ...serializeDeviceFields(),
      macroJson: macrosSrc.map((m) => JSON.parse(macroActionsToJson(m)) as unknown[]),
      layerNames: s.layerNames,
      viaProtocol: s.viaProtocol,
      vialProtocol: s.vialProtocol,
      featureFlags: s.dynamicCounts.featureFlags,
      definition: s.definition ?? undefined,
    }
  }, [stateRef, serializeDeviceFields])

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
      const { layout, encoderCount } = parseDefinitionLayout(def)
      if (layout) {
        newState.layout = layout
        newState.encoderCount = encoderCount
      }
      return newState
    })
  }, [setState])

  const applyVilFile = useCallback(async (vil: VilFile): Promise<ApplyVilResult> => {
    const isDummy = stateRef.current.isDummy

    const keymap = recordToMap(vil.keymap)
    const encoderLayout = recordToMap(vil.encoderLayout)

    // QMK settings actually applied by this restore — computed once and
    // shared by the write loop below and the setState at the end, so state
    // (and serialize()/resolveTappingTerm downstream) never claims a value
    // the device didn't accept. In file/dummy mode supportedQsids is
    // derived from the file itself, so nothing is filtered out; on a real
    // device we skip qsids the connected firmware doesn't support (e.g. a
    // .vil saved from a different keyboard or a newer firmware build) —
    // qmkSettingsSet rejects on a non-zero status byte, so sending an
    // unsupported qsid would abort the rest of the restore instead of just
    // leaving that one setting untouched.
    const appliedQmkSettings = isDummy
      ? vil.qmkSettings
      : Object.fromEntries(
          Object.entries(vil.qmkSettings).filter(
            ([qsid]) => stateRef.current.supportedQsids.has(Number(qsid)),
          ),
        )

    if (!isDummy) {
      // Prompt unlock before writing to device
      if (stateRef.current.unlockStatus.unlocked === false) {
        bootGuardRef.current.onUnlock?.()
        await waitForUnlock()
      }

      const api = window.vialAPI

      // Snapshot of "what Pipette believes the device currently holds",
      // taken before the first write — serializeDeviceFields() is
      // pure/synchronous, so this can never itself fail. If the apply below
      // fails partway through, this is written back to restore the device
      // instead of leaving it half-changed while the screen still shows the
      // old (now wrong) state. macroBufferSize is captured here too, at the
      // same moment as the backup — reading it later, from inside the catch
      // below, would risk a value that a disconnect (or anything else that
      // resets state mid-apply) already changed out from under the pending
      // write, silently shrinking how much of the macro buffer the rollback
      // pads and writes back.
      const backup = serializeDeviceFields()
      const backupMacroBufferSize = stateRef.current.macroBufferSize

      try {
        await writeVilToDevice(api, { ...vil, qmkSettings: appliedQmkSettings }, { keymap, encoderLayout })
      } catch (err) {
        console.error('[Persistence] apply failed:', err)
        try {
          // backupMacroBufferSize (not backup.macros.length) is the pad
          // target — see writeVilToDevice's doc for why a shorter post-edit
          // buffer must still be padded to the device's real buffer length.
          await writeVilToDevice(
            api,
            backup,
            { keymap: recordToMap(backup.keymap), encoderLayout: recordToMap(backup.encoderLayout) },
            { padMacrosTo: backupMacroBufferSize },
          )
          return { ok: false, rolledBack: true }
        } catch (rollbackErr) {
          console.error('[Persistence] rollback failed:', rollbackErr)
          return { ok: false, rolledBack: false }
        }
      }
    }

    // Update local state
    const currentLayers = stateRef.current.layers
    const layerNames = Array.from({ length: currentLayers }, (_, i) => vil.layerNames?.[i] ?? '')
    saveLayerNamesRef.current?.(layerNames)

    // writeVilToDevice skips the macro buffer write when vil.macros is empty,
    // so on a real device the two macro fields keep what they had: replacing
    // them would show no macros on screen while the device still holds
    // whatever it had before this restore. In dummy/file mode there is no
    // device to diverge from, so the file's macros are always the new truth.
    const macroWriteSkipped = !isDummy && vil.macros.length === 0
    const macroFields: Partial<Pick<KeyboardState, 'macroBuffer' | 'parsedMacros'>> =
      macroWriteSkipped
        ? {}
        : {
            macroBuffer: vil.macros,
            parsedMacros: vil.macroJson
              ? vil.macroJson.map((m) => jsonToMacroActions(JSON.stringify(m)) ?? [])
              : null,
          }

    setState((s) => ({
      ...s,
      keymap,
      encoderLayout,
      ...macroFields,
      layoutOptions: vil.layoutOptions,
      tapDanceEntries: vil.tapDance,
      comboEntries: vil.combo,
      keyOverrideEntries: vil.keyOverride,
      altRepeatKeyEntries: vil.altRepeatKey,
      qmkSettingsValues: appliedQmkSettings,
      layerNames,
      // Snapshot/layout-store restore and .vil import both converge here —
      // bump so App.tsx's restore-cleanup effect notices even though uid and
      // keymap size are unchanged (the two things KeymapEditor's own clear
      // effect keys off of).
      keymapRestoreSeq: s.keymapRestoreSeq + 1,
    }))

    return { ok: true }
  }, [setState, stateRef, saveLayerNamesRef, serializeDeviceFields])

  const reset = useCallback(() => {
    // `keymapRestoreSeq` is monotonic for the whole session (see
    // keyboard-types.ts) so a disconnect must not zero it back out from
    // under a consumer that is only watching for changes.
    setState((s) => ({ ...emptyState(), keymapRestoreSeq: s.keymapRestoreSeq }))
    qmkSettingsBaselineRef.current = {}
  }, [setState, qmkSettingsBaselineRef])

  const refreshUnlockStatus = useCallback(async () => {
    try {
      const unlockStatus = await window.vialAPI.getUnlockStatus()
      setState((s) => ({ ...s, unlockStatus, unlockStatusKnown: true }))
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
