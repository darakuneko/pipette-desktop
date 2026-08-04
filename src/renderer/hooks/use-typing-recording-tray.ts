// SPDX-License-Identifier: GPL-2.0-or-later
// Footer "Record" toggle persistence + snapshot capture + system
// tray status. Split out of App.tsx (Task-split-app-tsx).

import { useCallback, useEffect, useRef } from 'react'
import type { UseDevicePrefsReturn } from './useDevicePrefs'
import type { useKeyboard } from './useKeyboard'
import { useRecKeystrokeCounter } from './useRecKeystrokeCounter'
import { useTrayStatus } from './useTrayStatus'
import { buildKeymapSnapshot } from '../components/analyze/keymap-snapshot-builder'
import type { DeviceInfo } from '../../shared/types/protocol'

interface Params {
  keyboard: ReturnType<typeof useKeyboard>
  devicePrefs: Pick<UseDevicePrefsReturn, 'typingRecordEnabled' | 'setTypingRecordEnabled'>
  typingTestMode: boolean
  isDummy: boolean
  connectedDevice: DeviceInfo | null
}

export function useTypingRecordingTray({
  keyboard,
  devicePrefs,
  typingTestMode,
  isDummy,
  connectedDevice,
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
  // REC (the footer's Record toggle) is no longer scoped to Typing View
  // (Task-typing-record-footer) — it authorizes recording wherever matrix
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

  // System tray: connected-keyboard name + live REC keystroke count.
  // recordingActive mirrors useInputModes' authoritative definition
  // exactly (narrower than recordingSnapshotRef's `active` above, which
  // also counts an editor typing-test practice run) — the tray's REC
  // line lights up as soon as REC is armed, regardless of Typing View /
  // Typing Test placement (matching the footer's own Recording indicator).
  const recordingActive = devicePrefs.typingRecordEnabled ?? false
  const recKeystroke = useRecKeystrokeCounter(recordingActive)
  // Dummy and pipette-file "connections" have no live device behind them
  // (see useDeviceConnection's connectDummy/connectPipetteFile), so the
  // tray should read as disconnected rather than show a pseudo name.
  const trayKeyboardName = isDummy ? null : (connectedDevice?.productName ?? null)
  useTrayStatus({ keyboardName: trayKeyboardName, recording: recordingActive, getCount: recKeystroke.getCount, getKpm: recKeystroke.getKpm })

  return { handleTypingRecordEnabledChange, recKeystroke }
}
