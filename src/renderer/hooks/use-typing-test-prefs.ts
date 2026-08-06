// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback } from 'react'
import type { TypingTestResult, TypingTestMemory, TypingTestComparisonBaseline, TypingTestComparisonBaselines } from '../../shared/types/pipette-settings'
import { trimResults } from '../typing-test/result-builder'
import type { TypingTestConfig } from '../typing-test/types'
import { clampDisplayLines, clampFontSize, MAX_TYPING_TEST_RESULTS } from '../typing-test/types'
import { isMonkeytypeMode } from './device-prefs-validate'

interface UseTypingTestPrefsArgs {
  typingTestResultsRef: React.RefObject<TypingTestResult[]>
  updateTypingTestResults: (results: TypingTestResult[]) => void
  typingTestConfigRef: React.RefObject<TypingTestConfig | undefined>
  updateTypingTestConfig: (config: TypingTestConfig | undefined) => void
  updateTypingTestMonkeytypeConfig: (config: TypingTestConfig | undefined) => void
  updateTypingTestLanguage: (lang: string | undefined) => void
  updateTypingTestViewOnly: (enabled: boolean) => void
  updateTypingTestViewOnlyWindowSize: (size: { width: number; height: number } | undefined) => void
  updateTypingTestViewOnlyAlwaysOnTop: (enabled: boolean) => void
  typingTestMemoryRef: React.RefObject<TypingTestMemory | undefined>
  updateTypingTestMemory: (memory: TypingTestMemory | undefined) => void
  typingTestDisplayLinesRef: React.RefObject<number>
  updateTypingTestDisplayLines: (lines: number) => void
  typingTestFontSizeRef: React.RefObject<number>
  updateTypingTestFontSize: (px: number) => void
  typingTestHideKeymapRef: React.RefObject<boolean>
  updateTypingTestHideKeymap: (hidden: boolean) => void
  typingTestHideStatsRowRef: React.RefObject<boolean>
  updateTypingTestHideStatsRow: (hidden: boolean) => void
  typingTestHideControlsRef: React.RefObject<boolean>
  updateTypingTestHideControls: (hidden: boolean) => void
  typingTestSaveUnnamedRef: React.RefObject<boolean>
  updateTypingTestSaveUnnamed: (enabled: boolean) => void
  typingTestComparisonBaselinesRef: React.RefObject<TypingTestComparisonBaselines>
  updateTypingTestComparisonBaselines: (baselines: TypingTestComparisonBaselines) => void
  typingTestSettingsPanelOpenRef: React.RefObject<boolean>
  updateTypingTestSettingsPanelOpen: (open: boolean) => void
  typingRecordEnabledRef: React.RefObject<boolean>
  updateTypingRecordEnabled: (enabled: boolean) => void
  saveCurrentPrefs: () => void
}

export function useTypingTestPrefs(args: UseTypingTestPrefsArgs) {
  const {
    typingTestResultsRef, updateTypingTestResults,
    typingTestConfigRef, updateTypingTestConfig, updateTypingTestMonkeytypeConfig,
    updateTypingTestLanguage,
    updateTypingTestViewOnly,
    updateTypingTestViewOnlyWindowSize,
    updateTypingTestViewOnlyAlwaysOnTop,
    typingTestMemoryRef, updateTypingTestMemory,
    typingTestDisplayLinesRef, updateTypingTestDisplayLines,
    typingTestFontSizeRef, updateTypingTestFontSize,
    typingTestHideKeymapRef, updateTypingTestHideKeymap,
    typingTestHideStatsRowRef, updateTypingTestHideStatsRow,
    typingTestHideControlsRef, updateTypingTestHideControls,
    typingTestSaveUnnamedRef, updateTypingTestSaveUnnamed,
    typingTestComparisonBaselinesRef, updateTypingTestComparisonBaselines,
    typingTestSettingsPanelOpenRef, updateTypingTestSettingsPanelOpen,
    typingRecordEnabledRef, updateTypingRecordEnabled,
    saveCurrentPrefs,
  } = args

  const addTypingTestResult = useCallback((result: TypingTestResult) => {
    const updated = trimResults([result, ...typingTestResultsRef.current], MAX_TYPING_TEST_RESULTS)
    updateTypingTestResults(updated)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateTypingTestResults])

  /** Label a saved result (keyed by its ISO date) for run comparison. An
   *  empty name clears the label. No-op when nothing changed. */
  const renameTypingTestResult = useCallback((date: string, name: string) => {
    const nextName = name.trim() || undefined
    let changed = false
    const updated = typingTestResultsRef.current.map((r) => {
      if (r.date !== date || (r.name ?? '') === (nextName ?? '')) return r
      changed = true
      return { ...r, name: nextName }
    })
    if (!changed) return
    updateTypingTestResults(updated)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateTypingTestResults])

  /** Remove a single saved result (keyed by its ISO date). */
  const deleteTypingTestResult = useCallback((date: string) => {
    const updated = typingTestResultsRef.current.filter((r) => r.date !== date)
    if (updated.length === typingTestResultsRef.current.length) return
    updateTypingTestResults(updated)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateTypingTestResults])

  const setTypingTestConfig = useCallback((cfg: TypingTestConfig) => {
    const prev = typingTestConfigRef.current
    updateTypingTestConfig(cfg)
    // Remember the last normal (words/time/quote) config so it survives a
    // switch into a non-normal mode (fileImport / tatoeba) and back. When
    // entering such a mode, capture the outgoing normal config too — covers old
    // prefs where typingTestMonkeytypeConfig was never saved. tatoeba must NOT
    // be cached here, else selecting a MonkeyType language would restore it.
    if (isMonkeytypeMode(cfg.mode)) updateTypingTestMonkeytypeConfig(cfg)
    else if (prev && isMonkeytypeMode(prev.mode)) updateTypingTestMonkeytypeConfig(prev)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateTypingTestConfig, updateTypingTestMonkeytypeConfig])

  const setTypingTestLanguage = useCallback((lang: string) => {
    updateTypingTestLanguage(lang)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateTypingTestLanguage])

  const setTypingTestViewOnly = useCallback((enabled: boolean) => {
    updateTypingTestViewOnly(enabled)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateTypingTestViewOnly])

  const setTypingTestViewOnlyWindowSize = useCallback((size: { width: number; height: number }) => {
    updateTypingTestViewOnlyWindowSize(size)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateTypingTestViewOnlyWindowSize])


  const setTypingTestViewOnlyAlwaysOnTop = useCallback((enabled: boolean) => {
    updateTypingTestViewOnlyAlwaysOnTop(enabled)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateTypingTestViewOnlyAlwaysOnTop])

  const setTypingTestMemory = useCallback((memory: TypingTestMemory | undefined) => {
    // Skip the full-prefs write when nothing changed — most commonly a
    // clear (undefined) issued while already cleared (finish / restart).
    if (typingTestMemoryRef.current === memory) return
    updateTypingTestMemory(memory)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateTypingTestMemory])

  const setTypingTestDisplayLines = useCallback((lines: number) => {
    const clamped = clampDisplayLines(lines)
    if (typingTestDisplayLinesRef.current === clamped) return
    updateTypingTestDisplayLines(clamped)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateTypingTestDisplayLines])

  const setTypingTestFontSize = useCallback((px: number) => {
    const clamped = clampFontSize(px)
    if (typingTestFontSizeRef.current === clamped) return
    updateTypingTestFontSize(clamped)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateTypingTestFontSize])

  const setTypingTestHideKeymap = useCallback((hidden: boolean) => {
    if (typingTestHideKeymapRef.current === hidden) return
    updateTypingTestHideKeymap(hidden)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateTypingTestHideKeymap])

  const setTypingTestHideStatsRow = useCallback((hidden: boolean) => {
    if (typingTestHideStatsRowRef.current === hidden) return
    updateTypingTestHideStatsRow(hidden)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateTypingTestHideStatsRow])

  const setTypingTestHideControls = useCallback((hidden: boolean) => {
    if (typingTestHideControlsRef.current === hidden) return
    updateTypingTestHideControls(hidden)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateTypingTestHideControls])

  const setTypingTestSaveUnnamed = useCallback((enabled: boolean) => {
    if (typingTestSaveUnnamedRef.current === enabled) return
    updateTypingTestSaveUnnamed(enabled)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateTypingTestSaveUnnamed])

  const setTypingTestComparisonBaseline = useCallback((conditionKey: string, baseline: TypingTestComparisonBaseline) => {
    updateTypingTestComparisonBaselines({ ...typingTestComparisonBaselinesRef.current, [conditionKey]: baseline })
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateTypingTestComparisonBaselines, typingTestComparisonBaselinesRef])

  const setTypingTestSettingsPanelOpen = useCallback((open: boolean) => {
    if (typingTestSettingsPanelOpenRef.current === open) return
    updateTypingTestSettingsPanelOpen(open)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateTypingTestSettingsPanelOpen])

  const setTypingRecordEnabled = useCallback((enabled: boolean) => {
    if (typingRecordEnabledRef.current === enabled) return
    updateTypingRecordEnabled(enabled)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateTypingRecordEnabled])

  return {
    addTypingTestResult,
    renameTypingTestResult,
    deleteTypingTestResult,
    setTypingTestConfig,
    setTypingTestLanguage,
    setTypingTestViewOnly,
    setTypingTestViewOnlyWindowSize,
    setTypingTestViewOnlyAlwaysOnTop,
    setTypingTestMemory,
    setTypingTestDisplayLines,
    setTypingTestFontSize,
    setTypingTestHideKeymap,
    setTypingTestHideStatsRow,
    setTypingTestHideControls,
    setTypingTestSaveUnnamed,
    setTypingTestComparisonBaseline,
    setTypingTestSettingsPanelOpen,
    setTypingRecordEnabled,
  }
}
