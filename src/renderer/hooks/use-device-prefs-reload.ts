// SPDX-License-Identifier: GPL-2.0-or-later
//
// Re-reads the connected keyboard's settings file when a Cloud Sync merge
// rewrote it (`keyboards/{uid}/settings`), so an open window shows values
// changed on another device. `applyDevicePrefs` (`useDevicePrefs.ts`) reads
// the same file once at connect; this hook only runs after that read.
//
// One read is in flight at a time. A notification that arrives during a
// read queues exactly one more. A read is never started while a save is in
// flight, and a read during which a save started is dropped and repeated
// once the saves settle, so a reload never puts back a value the user just
// changed.

import { useCallback, useEffect, useRef } from 'react'
import { useSyncUnitApplied } from './use-sync-unit-applied'
import { useLatestRef } from './use-latest-ref'
import type { ApplyValidatedOptions, PatchTracker } from './use-device-prefs-state'
import type { ValidatedPrefs } from './device-prefs-validate'
import type { PipetteSettings } from '../../shared/types/pipette-settings'
import type { UseDevicePrefsReturn } from './device-prefs-types'

/** Session state the reload never touches: the view-mode routing
 *  (`viewMode`, `typingTestViewOnly`), the paused run and the compact
 *  window's size, which this window writes back on its own, and the REC
 *  toggle — turning it on from another device would open the unlock
 *  dialog on a locked keyboard. */
const NEVER_RELOADED: readonly (keyof ValidatedPrefs)[] = [
  'viewMode',
  'typingTestViewOnly',
  'typingTestMemory',
  'typingTestViewOnlyWindowSize',
  'typingRecordEnabled',
]

/** A change to these restarts the typing test (`useInputModes.ts`), so they
 *  wait while the typing test mode is on. */
const TYPING_TEST_FIELDS: readonly (keyof ValidatedPrefs)[] = [
  'typingTestConfig',
  'typingTestMonkeytypeConfig',
  'typingTestLanguage',
]

/** What can hold back part of a reload while it is open:
 *  - `typingTest`: the typing test mode (`TYPING_TEST_FIELDS`)
 *  - `keycodeTabOrder`: the key picker's tab reorder mode */
export type SyncReloadHold = 'typingTest' | 'keycodeTabOrder'

const HELD_FIELDS: Readonly<Record<SyncReloadHold, readonly (keyof ValidatedPrefs)[]>> = {
  typingTest: TYPING_TEST_FIELDS,
  keycodeTabOrder: ['keycodeTabOrder'],
}

interface Args {
  uidRef: React.RefObject<string>
  applySeqRef: React.RefObject<number>
  appliedUid: string | null
  patchTrackerRef: React.RefObject<PatchTracker>
  validate: (raw: PipetteSettings | null) => ValidatedPrefs | null
  applyValidated: (resolved: ValidatedPrefs, options?: ApplyValidatedOptions) => (keyof ValidatedPrefs)[]
}

interface ReloadState {
  running: boolean
  /** Uid of a reload that was asked for but could not start yet (a read
   *  was running, the connect-time read had not been applied, or saves were
   *  in flight). Every point where that can change calls `wake`, which
   *  drops it when another keyboard is current by then. */
  pendingUid: string | null
  /** A reload left a held field different from the file. */
  afterHold: boolean
}

/** Runs a pending reload if it is still for the current keyboard, and
 *  drops it otherwise. */
function wake(state: ReloadState, currentUid: string, reload: () => void): void {
  if (state.pendingUid === null) return
  if (state.pendingUid === currentUid) reload()
  else state.pendingUid = null
}

export function useDevicePrefsReload({ uidRef, applySeqRef, appliedUid, patchTrackerRef, validate, applyValidated }: Args) {
  const validateRef = useLatestRef(validate)
  const appliedUidRef = useLatestRef(appliedUid)
  const stateRef = useRef<ReloadState>({ running: false, pendingUid: null, afterHold: false })
  const holdsRef = useRef<Record<SyncReloadHold, number>>({ typingTest: 0, keycodeTabOrder: 0 })

  const apply = useCallback((prefs: ValidatedPrefs) => {
    const held = new Set<keyof ValidatedPrefs>()
    for (const hold of Object.keys(HELD_FIELDS) as SyncReloadHold[]) {
      if (holdsRef.current[hold] > 0) for (const key of HELD_FIELDS[hold]) held.add(key)
    }
    const differing = applyValidated(prefs, { skip: new Set([...NEVER_RELOADED, ...held]), onlyChanged: true })
    if (differing.some((key) => held.has(key))) stateRef.current.afterHold = true
  }, [applyValidated])

  const reload = useCallback(function reload(): void {
    const state = stateRef.current
    const uid = uidRef.current
    if (!uid) return
    if (state.running || appliedUidRef.current !== uid || patchTrackerRef.current.inFlight > 0) {
      state.pendingUid = uid
      return
    }

    state.running = true
    state.pendingUid = null
    const seq = applySeqRef.current
    const generation = patchTrackerRef.current.generation
    void (async () => {
      try {
        const raw = await window.vialAPI.pipetteSettingsGet(uid)
        // Another keyboard (or a fresh connect) took over: drop the result.
        // A notification for the new keyboard that arrived meanwhile stays
        // pending and waits for its connect-time read to be applied.
        if (uidRef.current !== uid || applySeqRef.current !== seq) return
        if (patchTrackerRef.current.generation !== generation) {
          state.pendingUid = uid
          return
        }
        const prefs = validateRef.current(raw)
        if (prefs) apply(prefs)
      } catch {
        // IPC failure — keep what is shown
      } finally {
        state.running = false
        wake(state, uidRef.current, reload)
      }
    })()
  }, [apply])

  useSyncUnitApplied((syncUnit) => !!uidRef.current && syncUnit === `keyboards/${uidRef.current}/settings`, reload)

  // A notification that arrived during the connect-time read is handled
  // once that read has been applied.
  useEffect(() => {
    if (appliedUid !== null) wake(stateRef.current, uidRef.current, reload)
  }, [appliedUid, reload])

  useEffect(() => {
    const tracker = patchTrackerRef.current
    tracker.onSettled = () => {
      wake(stateRef.current, uidRef.current, reload)
    }
    return () => { tracker.onSettled = null }
  }, [reload])

  /** Holds back the fields of `hold` until the returned release is called.
   *  When a reload found one of them changed, it runs once more after the
   *  last release. */
  const holdSyncReload = useCallback((hold: SyncReloadHold): (() => void) => {
    holdsRef.current[hold]++
    let released = false
    return () => {
      if (released) return
      released = true
      holdsRef.current[hold]--
      const state = stateRef.current
      if (holdsRef.current[hold] > 0 || !state.afterHold) return
      state.afterHold = false
      reload()
    }
  }, [reload])

  return { holdSyncReload }
}

interface LinkArgs {
  devicePrefs: Pick<UseDevicePrefsReturn, 'holdSyncReload' | 'appliedUid' | 'layerNames'>
  /** Uid of the keyboard `useKeyboard` holds. */
  keyboardUid: string
  /** False for a dummy keyboard or an open `.pipette` file: their layer
   *  names come from that file, which may differ from the settings file. */
  liveKeyboard: boolean
  /** `useKeyboard`'s non-saving layer-name update; it ignores another uid
   *  and names equal to the ones shown. */
  replaceLayerNamesFromSync: (uid: string, names: string[]) => void
  /** `useEditorUIState`'s typing test mode. */
  typingTestMode: boolean
}

/** Connects the reload to state outside `useDevicePrefs`: the typing test
 *  mode holds back its fields, and a live keyboard's layer names follow
 *  `devicePrefs.layerNames` whenever both hold the same uid. That covers a
 *  reload, a sync merged during connect (the keyboard reads its names
 *  before the connect-time download, `applyDevicePrefs` after it), and
 *  reloads made while this hook was unmounted. */
export function useDevicePrefsReloadLinks({ devicePrefs, keyboardUid, liveKeyboard, replaceLayerNamesFromSync, typingTestMode }: LinkArgs): void {
  const { holdSyncReload, appliedUid, layerNames } = devicePrefs
  useEffect(() => (typingTestMode ? holdSyncReload('typingTest') : undefined), [typingTestMode, holdSyncReload])

  useEffect(() => {
    if (!liveKeyboard || appliedUid === null || appliedUid !== keyboardUid) return
    replaceLayerNamesFromSync(appliedUid, layerNames)
  }, [liveKeyboard, appliedUid, keyboardUid, layerNames, replaceLayerNamesFromSync])
}
