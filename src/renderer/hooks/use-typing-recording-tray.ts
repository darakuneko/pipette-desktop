// SPDX-License-Identifier: GPL-2.0-or-later
// Footer "Record" toggle persistence + snapshot capture + system
// tray status.

import { useCallback, useEffect, useRef } from 'react'
import type { UseDevicePrefsReturn } from './useDevicePrefs'
import type { useKeyboard } from './useKeyboard'
import { useRecKeystrokeCounter } from './useRecKeystrokeCounter'
import { useTrayStatus } from './useTrayStatus'
import { buildKeymapSnapshot } from '../components/analyze/keymap-snapshot-builder'
import type { DeviceInfo } from '../../shared/types/protocol'
import { EMPTY_UID } from '../../shared/constants/protocol'

interface Params {
  keyboard: ReturnType<typeof useKeyboard>
  devicePrefs: Pick<UseDevicePrefsReturn, 'typingRecordEnabled' | 'setTypingRecordEnabled' | 'appliedUid'>
  typingTestMode: boolean
  isDummy: boolean
  connectedDevice: DeviceInfo | null
  // Called on the rising edge of the REC-unlock gate (see the effect below).
  // App.tsx wires this to editorUI.setShowUnlockDialog(true).
  onRequestUnlockDialog: () => void
}

export function useTypingRecordingTray({
  keyboard,
  devicePrefs,
  typingTestMode,
  isDummy,
  connectedDevice,
  onRequestUnlockDialog,
}: Params) {
  // Persist the record toggle — snapshot capture is handled by the
  // recording-active effect below so any path that activates recording
  // (direct toggle, view re-entry with persisted ON, cold-start after
  // device connect) produces a layout anchor, not just the toggle
  // edge.
  const handleTypingRecordEnabledChange = useCallback((enabled: boolean) => {
    devicePrefs.setTypingRecordEnabled(enabled)
  }, [devicePrefs])

  // Save a keymap snapshot every time recording activates or the
  // active keyboard changes while recording is already active. A
  // keyboard edit made between sessions (user tweaks a layer, comes
  // back, hits Record) must produce a new snapshot so the Analyze
  // heatmap reflects the layout actually in use — not a stale one
  // from the previous toggle-ON. `saveKeymapSnapshotIfChanged` on
  // main dedupes by content, so re-firing on unrelated keyboard
  // state churn is cheap (no file write when the keymap is equal).
  //
  // REC (the footer's Record toggle) authorizes recording wherever matrix
  // frames flow, so `active` fires on the toggle alone. An editor typing
  // test counts too, independent of REC: it records matrix keystrokes
  // tagged by test/run, so without a snapshot the Analyze Heatmap /
  // Ergonomics / Layer-activations views have no layout to draw them on
  // ("No keymap snapshot recorded for this range").
  // Guard must survive StrictMode's double-invoke: the ref keeps the prior
  // { active, uid } across the extra mount/cleanup/mount pass, so the second
  // pass still sees an unchanged (active, uid) as already snapshotted.
  const recordingSnapshotRef = useRef<{ active: boolean; uid: string }>({ active: false, uid: '' })
  useEffect(() => {
    const active = devicePrefs.typingRecordEnabled || typingTestMode
    const uid = keyboard.uid
    const prev = recordingSnapshotRef.current
    recordingSnapshotRef.current = { active, uid }
    if (!active) return
    if (prev.active && prev.uid === uid) return
    const snap = buildKeymapSnapshot(keyboard)
    if (!snap) return
    void window.vialAPI.typingAnalyticsSaveKeymapSnapshot(snap).catch(() => { /* main logs */ })
  }, [devicePrefs.typingRecordEnabled, typingTestMode, keyboard])

  // REC is a per-keyboard setting that stays on across a disconnect, so the
  // tray and the unlock gate also require a connected real keyboard (not a
  // dummy or pipette file) whose prefs are applied: the applied-uid check
  // keeps the previous keyboard's REC from showing while a new keyboard's
  // prefs load, and a reconnect restarts the tray's count.
  const recOnLiveKeyboard = devicePrefs.typingRecordEnabled
    && connectedDevice !== null
    && !isDummy
    && keyboard.uid !== EMPTY_UID
    && devicePrefs.appliedUid === keyboard.uid

  // REC-unlock gate: unlocking is a hard precondition for REC to have any
  // effect (a locked keyboard never emits matrix frames), so this fires the
  // unlock dialog once per uid on the rising edge of "REC armed while
  // locked" — regardless of which screen is active. Covers session restore
  // into the plain editor with REC already on, REC toggled on while locked,
  // and reconnecting a still-locked keyboard with REC still armed.
  //
  // The "already requested" marker is uid-scoped (not a bare boolean) so
  // switching to a different locked keyboard while REC stays armed prompts
  // again for the new uid instead of silently inheriting the previous
  // keyboard's already-consumed prompt: a stale uid simply fails the
  // equality check below and is treated as "not yet prompted for this
  // uid," no separate mismatch branch needed. It resets to null on: the
  // gate condition going false (REC turned off, or the keyboard got
  // unlocked through some other path) or a disconnect — so the dialog is
  // not re-requested on every unrelated re-render while the condition
  // stays continuously true, including across a dismiss (the unlock
  // dialog has no cancel path other than disconnecting).
  // Guard must survive StrictMode's double-invoke: the ref keeps the prior
  // prompted uid across the extra mount/cleanup/mount pass, so the second
  // pass still sees an already-consumed prompt for the same uid.
  const promptedUidRef = useRef<string | null>(null)
  useEffect(() => {
    if (!connectedDevice) {
      promptedUidRef.current = null
      return
    }
    const uid = keyboard.uid
    const gateActive = recOnLiveKeyboard
      && !keyboard.loading
      && keyboard.unlockStatusKnown
      && !keyboard.unlockStatus.unlocked
    if (!gateActive) {
      promptedUidRef.current = null
      return
    }
    if (promptedUidRef.current === uid) return
    promptedUidRef.current = uid
    onRequestUnlockDialog()
  }, [
    connectedDevice,
    recOnLiveKeyboard,
    keyboard.loading,
    keyboard.uid,
    keyboard.unlockStatusKnown,
    keyboard.unlockStatus.unlocked,
    onRequestUnlockDialog,
  ])

  // System tray: connected-keyboard name + live REC keystroke count.
  const recKeystroke = useRecKeystrokeCounter(recOnLiveKeyboard)
  // Dummy and pipette-file "connections" have no live device behind them
  // (see useDeviceConnection's connectDummy/connectPipetteFile), so the
  // tray should read as disconnected rather than show a pseudo name.
  const trayKeyboardName = isDummy ? null : (connectedDevice?.productName ?? null)
  useTrayStatus({ keyboardName: trayKeyboardName, recording: recOnLiveKeyboard, getCount: recKeystroke.getCount, getKpm: recKeystroke.getKpm })

  return { handleTypingRecordEnabledChange, recKeystroke }
}
