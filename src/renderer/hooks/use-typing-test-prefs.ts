// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback } from 'react'
import type { PipetteSettingsPatch, TypingTestResult, TypingTestMemory, TypingTestComparisonBaseline, TypingTestComparisonBaselines } from '../../shared/types/pipette-settings'
import { clampViewOnlyOpacity } from '../../shared/types/pipette-settings'
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
  typingTestViewOnlyOpacityRef: React.RefObject<number>
  updateTypingTestViewOnlyOpacity: (opacity: number) => void
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
  savePrefs: (partial: PipetteSettingsPatch) => void
}

export function useTypingTestPrefs(args: UseTypingTestPrefsArgs) {
  const {
    typingTestResultsRef, updateTypingTestResults,
    typingTestConfigRef, updateTypingTestConfig, updateTypingTestMonkeytypeConfig,
    updateTypingTestLanguage,
    updateTypingTestViewOnly,
    updateTypingTestViewOnlyWindowSize,
    updateTypingTestViewOnlyAlwaysOnTop,
    typingTestViewOnlyOpacityRef, updateTypingTestViewOnlyOpacity,
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
    savePrefs,
  } = args

  const addTypingTestResult = useCallback((result: TypingTestResult) => {
    const updated = trimResults([result, ...typingTestResultsRef.current], MAX_TYPING_TEST_RESULTS)
    updateTypingTestResults(updated)
    savePrefs({ typingTestResults: updated })
  }, [savePrefs, updateTypingTestResults])

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
    savePrefs({ typingTestResults: updated })
  }, [savePrefs, updateTypingTestResults])

  /** Remove a single saved result (keyed by its ISO date). */
  const deleteTypingTestResult = useCallback((date: string) => {
    const updated = typingTestResultsRef.current.filter((r) => r.date !== date)
    if (updated.length === typingTestResultsRef.current.length) return
    updateTypingTestResults(updated)
    savePrefs({ typingTestResults: updated })
  }, [savePrefs, updateTypingTestResults])

  const setTypingTestConfig = useCallback((cfg: TypingTestConfig) => {
    const prev = typingTestConfigRef.current
    updateTypingTestConfig(cfg)
    // Remember the last normal (words/time/quote) config so it survives a
    // switch into a non-normal mode (fileImport / tatoeba) and back. When
    // entering such a mode, capture the outgoing normal config too — covers old
    // prefs where typingTestMonkeytypeConfig was never saved. tatoeba must NOT
    // be cached here, else selecting a MonkeyType language would restore it.
    const patch: PipetteSettingsPatch = { typingTestConfig: cfg as Record<string, unknown> }
    if (isMonkeytypeMode(cfg.mode)) {
      updateTypingTestMonkeytypeConfig(cfg)
      patch.typingTestMonkeytypeConfig = cfg as Record<string, unknown>
    } else if (prev && isMonkeytypeMode(prev.mode)) {
      updateTypingTestMonkeytypeConfig(prev)
      patch.typingTestMonkeytypeConfig = prev as Record<string, unknown>
    }
    savePrefs(patch)
  }, [savePrefs, updateTypingTestConfig, updateTypingTestMonkeytypeConfig])

  const setTypingTestLanguage = useCallback((lang: string) => {
    updateTypingTestLanguage(lang)
    savePrefs({ typingTestLanguage: lang })
  }, [savePrefs, updateTypingTestLanguage])

  const setTypingTestViewOnly = useCallback((enabled: boolean) => {
    updateTypingTestViewOnly(enabled)
    savePrefs({ typingTestViewOnly: enabled })
  }, [savePrefs, updateTypingTestViewOnly])

  const setTypingTestViewOnlyWindowSize = useCallback((size: { width: number; height: number }) => {
    updateTypingTestViewOnlyWindowSize(size)
    savePrefs({ typingTestViewOnlyWindowSize: size })
  }, [savePrefs, updateTypingTestViewOnlyWindowSize])


  const setTypingTestViewOnlyAlwaysOnTop = useCallback((enabled: boolean) => {
    updateTypingTestViewOnlyAlwaysOnTop(enabled)
    savePrefs({ typingTestViewOnlyAlwaysOnTop: enabled })
  }, [savePrefs, updateTypingTestViewOnlyAlwaysOnTop])

  const setTypingTestViewOnlyOpacity = useCallback((opacity: number) => {
    const clamped = clampViewOnlyOpacity(opacity)
    if (typingTestViewOnlyOpacityRef.current === clamped) return
    updateTypingTestViewOnlyOpacity(clamped)
    savePrefs({ typingTestViewOnlyOpacity: clamped })
  }, [savePrefs, updateTypingTestViewOnlyOpacity])

  const setTypingTestMemory = useCallback((memory: TypingTestMemory | undefined) => {
    // Skip the write when nothing changed — most commonly a
    // clear (undefined) issued while already cleared (finish / restart).
    if (typingTestMemoryRef.current === memory) return
    updateTypingTestMemory(memory)
    savePrefs({ typingTestMemory: memory ?? null })
  }, [savePrefs, updateTypingTestMemory])

  const setTypingTestDisplayLines = useCallback((lines: number) => {
    const clamped = clampDisplayLines(lines)
    if (typingTestDisplayLinesRef.current === clamped) return
    updateTypingTestDisplayLines(clamped)
    savePrefs({ typingTestDisplayLines: clamped })
  }, [savePrefs, updateTypingTestDisplayLines])

  const setTypingTestFontSize = useCallback((px: number) => {
    const clamped = clampFontSize(px)
    if (typingTestFontSizeRef.current === clamped) return
    updateTypingTestFontSize(clamped)
    savePrefs({ typingTestFontSize: clamped })
  }, [savePrefs, updateTypingTestFontSize])

  const setTypingTestHideKeymap = useCallback((hidden: boolean) => {
    if (typingTestHideKeymapRef.current === hidden) return
    updateTypingTestHideKeymap(hidden)
    savePrefs({ typingTestHideKeymap: hidden })
  }, [savePrefs, updateTypingTestHideKeymap])

  const setTypingTestHideStatsRow = useCallback((hidden: boolean) => {
    if (typingTestHideStatsRowRef.current === hidden) return
    updateTypingTestHideStatsRow(hidden)
    savePrefs({ typingTestHideStatsRow: hidden })
  }, [savePrefs, updateTypingTestHideStatsRow])

  const setTypingTestHideControls = useCallback((hidden: boolean) => {
    if (typingTestHideControlsRef.current === hidden) return
    updateTypingTestHideControls(hidden)
    savePrefs({ typingTestHideControls: hidden })
  }, [savePrefs, updateTypingTestHideControls])

  const setTypingTestSaveUnnamed = useCallback((enabled: boolean) => {
    if (typingTestSaveUnnamedRef.current === enabled) return
    updateTypingTestSaveUnnamed(enabled)
    savePrefs({ typingTestSaveUnnamed: enabled })
  }, [savePrefs, updateTypingTestSaveUnnamed])

  const setTypingTestComparisonBaseline = useCallback((conditionKey: string, baseline: TypingTestComparisonBaseline) => {
    const updated = { ...typingTestComparisonBaselinesRef.current, [conditionKey]: baseline }
    updateTypingTestComparisonBaselines(updated)
    savePrefs({ typingTestComparisonBaselines: updated })
  }, [savePrefs, updateTypingTestComparisonBaselines, typingTestComparisonBaselinesRef])

  const setTypingTestSettingsPanelOpen = useCallback((open: boolean) => {
    if (typingTestSettingsPanelOpenRef.current === open) return
    updateTypingTestSettingsPanelOpen(open)
    savePrefs({ typingTestSettingsPanelOpen: open })
  }, [savePrefs, updateTypingTestSettingsPanelOpen])

  const setTypingRecordEnabled = useCallback((enabled: boolean) => {
    if (typingRecordEnabledRef.current === enabled) return
    updateTypingRecordEnabled(enabled)
    savePrefs({ typingRecordEnabled: enabled })
  }, [savePrefs, updateTypingRecordEnabled])

  return {
    addTypingTestResult,
    renameTypingTestResult,
    deleteTypingTestResult,
    setTypingTestConfig,
    setTypingTestLanguage,
    setTypingTestViewOnly,
    setTypingTestViewOnlyWindowSize,
    setTypingTestViewOnlyAlwaysOnTop,
    setTypingTestViewOnlyOpacity,
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
