// SPDX-License-Identifier: GPL-2.0-or-later
// Typing View "record" toggle persistence + snapshot capture + system
// tray status. Split out of App.tsx (Task-split-app-tsx).

import { useCallback, useEffect, useRef } from 'react'
import type { KeyboardState } from './keyboard-types'
import type { UseDevicePrefsReturn } from './useDevicePrefs'
import { useRecKeystrokeCounter } from './useRecKeystrokeCounter'
import { useTrayStatus } from './useTrayStatus'
import { buildKeymapSnapshot } from '../components/analyze/keymap-snapshot-builder'
import type { DeviceInfo } from '../../shared/types/protocol'

interface Params {
  keyboard: KeyboardState
  devicePrefs: Pick<UseDevicePrefsReturn, 'typingRecordEnabled' | 'typingTestViewOnly' | 'setTypingRecordEnabled'>
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
  // An editor typing test counts too: it records matrix keystrokes
  // tagged by test/run, so without a snapshot the Analyze Heatmap /
  // Ergonomics / Layer-activations views have no layout to draw them on
  // ("No keymap snapshot recorded for this range").
  const recordingSnapshotRef = useRef<{ active: boolean; uid: string }>({ active: false, uid: '' })
  useEffect(() => {
    const active = (devicePrefs.typingRecordEnabled && devicePrefs.typingTestViewOnly)
      || typingTestMode
    const uid = keyboard.uid
    const prev = recordingSnapshotRef.current
    recordingSnapshotRef.current = { active, uid }
    if (!active) return
    if (prev.active && prev.uid === uid) return
    const snap = buildKeymapSnapshot(keyboard)
    if (!snap) return
    void window.vialAPI.typingAnalyticsSaveKeymapSnapshot(snap).catch(() => { /* main logs */ })
  }, [devicePrefs.typingRecordEnabled, devicePrefs.typingTestViewOnly, typingTestMode, keyboard])

  // System tray: connected-keyboard name + live REC keystroke count.
  // recordingActive mirrors useInputModes' authoritative definition
  // exactly (narrower than recordingSnapshotRef's `active` above, which
  // also counts an editor typing-test practice run) — the tray's REC
  // line should only light up for the ambient Typing View record toggle.
  const recordingActive = devicePrefs.typingRecordEnabled && devicePrefs.typingTestViewOnly
  const recKeystroke = useRecKeystrokeCounter(recordingActive)
  // Dummy and pipette-file "connections" have no live device behind them
  // (see useDeviceConnection's connectDummy/connectPipetteFile), so the
  // tray should read as disconnected rather than show a pseudo name.
  const trayKeyboardName = isDummy ? null : (connectedDevice?.productName ?? null)
  useTrayStatus({ keyboardName: trayKeyboardName, recording: recordingActive, getCount: recKeystroke.getCount, getKpm: recKeystroke.getKpm })

  return { handleTypingRecordEnabledChange, recKeystroke }
}
