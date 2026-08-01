// SPDX-License-Identifier: GPL-2.0-or-later
// Per-keyboard Analyze preferences that live outside the filter store:
// finger-assignment overrides, the population-benchmark toggle, and
// the saved Typing Test History used by SummaryView. Fetched once per
// uid alongside each other (same `pipetteSettingsGet` payload) so
// TypingProfileCard doesn't issue its own duplicate IPC. Split out of
// AnalyzePane.tsx (Task-split-analyze-pane).

import { useCallback, useEffect, useState } from 'react'
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
    if (!selectedUid) {
      setFingerAssignments({}); setShowBenchmark(true); setFingersLoading(false); setTypingTestResults([])
      return
    }
    let cancelled = false
    setFingersLoading(true)
    void window.vialAPI
      .pipetteSettingsGet(selectedUid)
      .then((prefs) => {
        if (cancelled) return
        setFingerAssignments(prefs?.analyze?.fingerAssignments ?? {})
        setShowBenchmark(prefs?.analyze?.showBenchmark ?? true)
        setTypingTestResults((prefs?.typingTestResults ?? []).filter(isValidTypingTestResult).map(sanitizeTypingTestResult))
      })
      .catch(() => { if (!cancelled) { setFingerAssignments({}); setShowBenchmark(true); setTypingTestResults([]) } })
      .finally(() => { if (!cancelled) setFingersLoading(false) })
    return () => { cancelled = true }
  }, [selectedUid])

  const handleFingerAssignmentsSave = useCallback(
    async (next: Record<string, FingerType>) => {
      setFingerAssignments(next)
      if (!selectedUid) return
      try {
        // PATCH only this sub-field; the main-side deep merge on `analyze`
        // preserves filters/goal. An empty map clears all overrides (each
        // absent key falls back to the geometry estimate).
        await window.vialAPI.pipetteSettingsPatch(selectedUid, {
          analyze: { fingerAssignments: next },
        })
      } catch {
        // best-effort save
      }
    },
    [selectedUid],
  )

  const handleShowBenchmarkChange = useCallback(
    async (next: boolean) => {
      setShowBenchmark(next)
      if (!selectedUid) return
      try {
        // PATCH only this sub-field; the main-side deep merge on `analyze`
        // preserves filters/goal/fingerAssignments owned by other writers.
        await window.vialAPI.pipetteSettingsPatch(selectedUid, {
          analyze: { showBenchmark: next },
        })
      } catch {
        // best-effort save
      }
    },
    [selectedUid],
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
