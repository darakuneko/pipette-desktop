// SPDX-License-Identifier: GPL-2.0-or-later
// Per-keyboard Analyze preferences that live outside the filter store:
// finger-assignment overrides, the population-benchmark toggle, and
// the saved Typing Test History used by SummaryView. Read together per
// uid (same `pipetteSettingsGet` payload), and again after a sync merge
// of that keyboard's settings, so TypingProfileCard doesn't issue its own
// duplicate IPC.

import { useCallback, useEffect, useState } from 'react'
import { keepIfSame, useKeyboardSettingsReader } from '../../hooks/use-keyboard-settings-reader'
import type { FingerType } from '../../../shared/kle/kle-ergonomics'
import type { TypingTestResult } from '../../../shared/types/pipette-settings'
import { isValidTypingTestResult, sanitizeTypingTestResult } from '../../typing-test/typing-test-result-sanitize'

export interface UseAnalyzePanePrefsReturn {
  fingerAssignments: Record<string, FingerType>
  fingersLoading: boolean
  typingTestResults: TypingTestResult[]
  showBenchmark: boolean
  handleFingerAssignmentsSave: (next: Record<string, FingerType>) => Promise<void>
  handleShowBenchmarkChange: (next: boolean) => Promise<void>
}

export function useAnalyzePanePrefs(selectedUid: string | null): UseAnalyzePanePrefsReturn {
  const [fingerAssignments, setFingerAssignments] = useState<Record<string, FingerType>>({})
  const [fingersLoading, setFingersLoading] = useState(false)
  // Saved Typing Test History, sanitized the same way useDevicePrefs reads
  // it — fetched here (alongside fingerAssignments/showBenchmark, same
  // pipetteSettingsGet payload) rather than TypingProfileCard issuing its
  // own duplicate IPC, and passed down through SummaryView.
  const [typingTestResults, setTypingTestResults] = useState<TypingTestResult[]>([])
  // Population-benchmark reference line toggle (WPM / Interval time-series
  // charts). Absent settings mean "on" — see AnalyzeSettings.showBenchmark.
  const [showBenchmark, setShowBenchmark] = useState(true)

  useEffect(() => {
    if (selectedUid) setFingersLoading(true)
  }, [selectedUid])

  // Re-read silently when a sync merge rewrote this keyboard's settings;
  // `fingersLoading` covers only the first read for a uid.
  const { trackWrite } = useKeyboardSettingsReader(selectedUid, (prefs) => {
    const nextFingers = prefs?.analyze?.fingerAssignments ?? {}
    const nextResults = (prefs?.typingTestResults ?? []).filter(isValidTypingTestResult).map(sanitizeTypingTestResult)
    setFingerAssignments((prev) => keepIfSame(prev, nextFingers))
    setShowBenchmark(prefs?.analyze?.showBenchmark ?? true)
    setTypingTestResults((prev) => keepIfSame(prev, nextResults))
    setFingersLoading(false)
  })

  const handleFingerAssignmentsSave = useCallback(
    async (next: Record<string, FingerType>) => {
      setFingerAssignments(next)
      if (!selectedUid) return
      try {
        // PATCH only this sub-field; the main-side deep merge on `analyze`
        // preserves filters/goal. An empty map clears all overrides (each
        // absent key falls back to the geometry estimate).
        await trackWrite(window.vialAPI.pipetteSettingsPatch(selectedUid, {
          analyze: { fingerAssignments: next },
        }))
      } catch {
        // best-effort save
      }
    },
    [selectedUid, trackWrite],
  )

  const handleShowBenchmarkChange = useCallback(
    async (next: boolean) => {
      setShowBenchmark(next)
      if (!selectedUid) return
      try {
        // PATCH only this sub-field; the main-side deep merge on `analyze`
        // preserves filters/goal/fingerAssignments owned by other writers.
        await trackWrite(window.vialAPI.pipetteSettingsPatch(selectedUid, {
          analyze: { showBenchmark: next },
        }))
      } catch {
        // best-effort save
      }
    },
    [selectedUid, trackWrite],
  )

  return {
    fingerAssignments,
    fingersLoading,
    typingTestResults,
    showBenchmark,
    handleFingerAssignmentsSave,
    handleShowBenchmarkChange,
  }
}
