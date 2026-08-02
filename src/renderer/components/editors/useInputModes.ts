// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useEffect, useRef } from 'react'
import { useTypingTest } from '../../typing-test/useTypingTest'
import type { TypingTestConfig } from '../../typing-test/types'
import { DEFAULT_CONFIG, DEFAULT_LANGUAGE } from '../../typing-test/types'
import { useMatrixTester } from './use-matrix-tester'
import { useTypingAnalyticsSink, typingTestAnalyticsLabel } from './use-typing-analytics-sink'
import { useTypingTestResultSave } from './use-typing-test-result-save'
import type { TypingTestResult, TypingTestMemory } from '../../../shared/types/pipette-settings'
import type { TypingAnalyticsKeyboard } from '../../../shared/types/typing-analytics'
import { PROCESS_CODE_TO_KEY } from './keymap-editor-types'

export interface UseInputModesOptions {
  rows?: number
  cols?: number
  getMatrixState?: () => Promise<number[]>
  unlocked?: boolean
  onUnlock?: (options?: { macroWarning?: boolean }) => void
  onMatrixModeChange?: (matrixMode: boolean, hasMatrixTester: boolean) => void
  keymap: Map<string, number>
  typingTestMode?: boolean
  onTypingTestModeChange?: (enabled: boolean) => void
  savedTypingTestConfig?: TypingTestConfig
  savedTypingTestLanguage?: string
  onTypingTestConfigChange?: (config: TypingTestConfig) => void
  onTypingTestLanguageChange?: (lang: string) => void
  onSaveTypingTestResult?: (result: TypingTestResult) => void
  /** Label the latest saved result by its ISO date — used to name a finished
   *  result when save-unnamed is on (the result is already in History). */
  onRenameTypingTestResult?: (date: string, name: string) => void
  /** When true (default), a finished result is auto-saved immediately, even
   *  without a name. When false, the result is held unsaved until the user
   *  names it (via `nameFinishedResult`); leaving it unnamed discards it. */
  saveUnnamed?: boolean
  /** Persisted paused-test snapshot for the active keyboard (memory mode). */
  savedTypingTestMemory?: TypingTestMemory
  /** Persist or clear the paused-test snapshot. */
  onTypingTestMemoryChange?: (memory: TypingTestMemory | undefined) => void
  typingTestHistory?: TypingTestResult[]
  typingTestViewOnly?: boolean
  typingRecordEnabled?: boolean
  typingRecordKeyboard?: TypingAnalyticsKeyboard
  /** Called once per matrix keystroke recorded while REC (Typing View
   *  record toggle) is active — i.e. the same untagged events dispatched
   *  to typingAnalyticsEvent, not the tagged editor-typing-test events.
   *  Feeds the tray's session keystroke count (see useRecKeystrokeCounter
   *  in App.tsx); this hook does no counting of its own. */
  onRecKeystroke?: () => void
  /** TAPPING_TERM (ms) forwarded to useTypingTest for masked-key
   * tap/hold classification. Defaults to QMK's 200 ms when the
   * keyboard hasn't reported one. */
  tappingTermMs?: number
  /** `AppConfig.typingRecordingConsentAccepted` — gates the per-run raw
   * keystroke log (see run-log-recorder.ts), independently of and
   * stricter than `typingRecordEnabled`'s per-minute analytics gate. */
  recordingConsentAccepted?: boolean
}

export interface UseInputModesReturn {
  matrixMode: boolean
  pressedKeys: Set<string>
  everPressedKeys: Set<string>
  hasMatrixTester: boolean
  handleMatrixToggle: () => void
  handleTypingTestToggle: () => void
  typingTest: ReturnType<typeof useTypingTest>
  handleTypingTestConfigChange: (config: TypingTestConfig) => void
  handleTypingTestLanguageChange: (lang: string) => Promise<void>
  /** The just-finished result — the held unsaved one when save-unnamed is off,
   *  else the saved latest; null until a test finishes. For result-name chips. */
  finishedResult: TypingTestResult | null
  /** Name the just-finished result: persists a held unsaved result under the
   *  name (save-unnamed off; blank → discarded) or renames the saved latest. */
  nameFinishedResult: (name: string) => void
  /** Memory mode (imported fileImport text). */
  savedTypingTestMemory?: TypingTestMemory
  pauseTypingTest: () => void
  resumeTypingTest: () => void
  restartTypingTestFromStart: () => void
}

export function useInputModes({
  rows,
  cols,
  getMatrixState,
  unlocked,
  onUnlock,
  onMatrixModeChange,
  keymap,
  typingTestMode,
  onTypingTestModeChange,
  savedTypingTestConfig,
  savedTypingTestLanguage,
  onTypingTestConfigChange,
  onTypingTestLanguageChange,
  onSaveTypingTestResult,
  onRenameTypingTestResult,
  saveUnnamed = true,
  savedTypingTestMemory,
  onTypingTestMemoryChange,
  typingTestHistory,
  typingTestViewOnly,
  typingRecordEnabled,
  typingRecordKeyboard,
  onRecKeystroke,
  tappingTermMs,
  recordingConsentAccepted = false,
}: UseInputModesOptions): UseInputModesReturn {
  // --- Matrix tester ---
  const {
    matrixMode,
    pressedKeys,
    everPressedKeys,
    hasMatrixTester,
    handleMatrixToggle,
    enterMatrixMode,
    resetMatrixState,
  } = useMatrixTester({ rows, cols, getMatrixState, unlocked, onUnlock, onMatrixModeChange })

  // --- Analytics sink (must be called before useTypingTest so its refs
  // exist for useTypingTest to capture the stable callbacks below). ---
  const {
    keyboardRef,
    recordingActiveRef,
    testLabelRef,
    testRunIdRef,
    prepareAnalyticsEvent,
    emitAnalyticsEvent,
    flushAfterPendingEmits,
    runLog,
  } = useTypingAnalyticsSink({ typingRecordKeyboard, onRecKeystroke, recordingConsentAccepted })

  // --- Typing test ---
  const typingTest = useTypingTest(savedTypingTestConfig, savedTypingTestLanguage, {
    onPrepareAnalyticsEvent: prepareAnalyticsEvent,
    onEmitAnalyticsEvent: emitAnalyticsEvent,
    // A direct passthrough — runLog.noteRegistration re-checks the label/
    // consent gate itself (same privacy-critical gate `record` uses
    // above), so ambient REC frames (testLabelRef null) never touch the
    // recorder buffer at all, not even to register.
    onNoteKeystrokeRegistration: runLog.noteRegistration,
    onNoteCharContext: runLog.noteCharContext,
    tappingTermMs,
  })
  const {
    restart: restartTypingTest,
    restartWithCountdown,
    processMatrixFrame,
    resetMatrixPressTracking,
    processKeyEvent,
    setWindowFocused,
  } = typingTest

  const savedMemoryRef = useRef(savedTypingTestMemory)
  savedMemoryRef.current = savedTypingTestMemory
  const savedConfigRef = useRef(savedTypingTestConfig)
  savedConfigRef.current = savedTypingTestConfig
  const onMemoryChangeRef = useRef(onTypingTestMemoryChange)
  onMemoryChangeRef.current = onTypingTestMemoryChange
  // Tracks the config JSON last pushed into useTypingTest so the config-sync
  // effect below doesn't re-apply (and overwrite a restored snapshot).
  const lastSyncedConfigRef = useRef('')

  /** Enter the typing test. When a paused snapshot is saved for the active
   *  fileImport text, restore it frozen ('paused') so the user must choose
   *  resume / restart before typing; otherwise start a fresh test. */
  const beginTypingTest = useCallback((withCountdown: boolean) => {
    enterMatrixMode()
    const mem = savedMemoryRef.current
    const cfg = savedConfigRef.current
    if (mem && cfg?.mode === 'fileImport' && cfg.textId === mem.textId) {
      // Pre-mark the config as synced so the config-sync effect doesn't
      // clobber the restored snapshot with a fresh test.
      lastSyncedConfigRef.current = JSON.stringify(cfg)
      void typingTest.restoreState(mem, false)
    } else if (withCountdown) {
      restartWithCountdown()
    } else {
      restartTypingTest()
    }
    onTypingTestModeChange?.(true)
  }, [enterMatrixMode, typingTest, restartWithCountdown, restartTypingTest, onTypingTestModeChange])

  const [pendingTypingTest, setPendingTypingTest] = useState(false)

  useEffect(() => {
    if (pendingTypingTest && unlocked) {
      setPendingTypingTest(false)
      beginTypingTest(true)
    }
  }, [pendingTypingTest, unlocked, beginTypingTest])

  // Exit typing test when the keyboard is locked
  useEffect(() => {
    if (!unlocked && typingTestMode) {
      resetMatrixState()
      onTypingTestModeChange?.(false)
    }
  }, [unlocked, typingTestMode, resetMatrixState, onTypingTestModeChange])

  const handleTypingTestToggle = useCallback(() => {
    if (typingTestMode) {
      resetMatrixState()
      onTypingTestModeChange?.(false)
    } else if (unlocked) {
      beginTypingTest(false)
    } else {
      setPendingTypingTest(true)
      onUnlock?.()
    }
  }, [typingTestMode, unlocked, resetMatrixState, beginTypingTest, onTypingTestModeChange, onUnlock])

  // Feed matrix frames to typing test
  useEffect(() => {
    if (!typingTestMode) return
    processMatrixFrame(pressedKeys, keymap)
  }, [pressedKeys, typingTestMode, processMatrixFrame, keymap])

  // Effective recording condition: view-only + record toggle on. Anything
  // else leaves the analytics pipeline idle.
  const recordingActive = (typingRecordEnabled ?? false) && (typingTestViewOnly ?? false)
  // Keep the sink's refs current (the sink itself is a stable callback).
  recordingActiveRef.current = recordingActive
  // A test in the editor (not the REC view) is the tagged input source — but
  // only while it is actually running. Entering the test view auto-starts a
  // countdown on the default ('words') config; tagging keystrokes before the
  // run starts would record a phantom material (e.g. `words (english)`) for
  // presses made during countdown / waiting or before the user picks a fileImport
  // text. Gating on 'running' guarantees the config has settled to the chosen
  // material before anything is recorded. Trade-off: the keystroke that starts
  // the run (waiting -> running) and the matrix edge of the key that ends it
  // (running -> finished, seen a poll later) may go untagged — a negligible
  // 1-2 edge gap in the aggregate heatmap, accepted to avoid the phantom run.
  // ('finished' is intentionally excluded so idle presses after a test can't
  // re-introduce a phantom record.)
  testLabelRef.current = typingTestMode && !typingTestViewOnly && typingTest.state.status === 'running'
    ? typingTestAnalyticsLabel(typingTest.config, typingTest.language, typingTest.state.currentQuote)
    : null
  // Run id travels with the label so each run's keystrokes are separable.
  testRunIdRef.current = testLabelRef.current ? typingTest.state.runId : null

  // Reset matrix press-edge tracking when keymap changes or recording toggles
  // so the next frame doesn't emit stale press events against an old state.
  // The drain's completion promise is captured so the record-off effect
  // below can await the *same* drain instead of triggering (and racing) a
  // second one — see pendingDrainRef's use there.
  const pendingDrainRef = useRef<Promise<void>>(Promise.resolve())
  useEffect(() => {
    pendingDrainRef.current = resetMatrixPressTracking()
  }, [keymap, recordingActive, resetMatrixPressTracking])

  // When recording transitions off (either the toggle flips or the user
  // leaves view-only mode), finalize the open session in main and flush
  // its data for the active keyboard. Must wait for the drain the effect
  // above just kicked off (same recordingActive dependency, so it always
  // runs first in this commit) — see flushAfterPendingEmits for why.
  const prevRecordingActiveRef = useRef(recordingActive)
  useEffect(() => {
    const wasOn = prevRecordingActiveRef.current
    prevRecordingActiveRef.current = recordingActive
    if (wasOn && !recordingActive) {
      const uid = typingRecordKeyboard?.uid
      if (uid) flushAfterPendingEmits(pendingDrainRef.current, uid)
    }
  }, [recordingActive, typingRecordKeyboard, flushAfterPendingEmits])

  // Capture-phase keydown listener for typing test
  useEffect(() => {
    if (!typingTestMode || typingTestViewOnly) return
    function handler(e: KeyboardEvent) {
      if (document.querySelector('[role="dialog"]')) return
      // Inline edit fields (e.g. naming a finished result) opt out of typing
      // capture so their keystrokes reach the input instead of the test.
      if (e.target instanceof HTMLElement && e.target.dataset.ttPassthrough != null) return
      if (e.isComposing) return
      let key = e.key
      if (key === 'Process') {
        const resolved = PROCESS_CODE_TO_KEY.get(e.code)
        if (!resolved) return
        key = resolved
      }
      if (e.metaKey) return
      if (e.ctrlKey && !e.altKey) return
      e.preventDefault()
      e.stopPropagation()
      processKeyEvent(key, e.ctrlKey, e.altKey, e.metaKey)
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [typingTestMode, typingTestViewOnly, processKeyEvent])

  const { finishedResult, nameFinishedResult } = useTypingTestResultSave({
    typingTest,
    typingTestViewOnly,
    onSaveTypingTestResult,
    saveUnnamed,
    typingTestHistory,
    onRenameTypingTestResult,
    savedMemoryRef,
    onMemoryChangeRef,
    keyboardRef,
    flushAfterPendingEmits,
    runLog,
  })

  // Sync saved config/language from device prefs into useTypingTest
  useEffect(() => {
    const target = savedTypingTestConfig
    const json = target ? JSON.stringify(target) : ''
    if (json === lastSyncedConfigRef.current) return
    lastSyncedConfigRef.current = json
    typingTest.setConfig(target ?? DEFAULT_CONFIG)
  }, [savedTypingTestConfig, typingTest.setConfig])

  const lastSyncedLanguageRef = useRef('')
  useEffect(() => {
    const target = savedTypingTestLanguage
    if ((target ?? '') === lastSyncedLanguageRef.current) return
    lastSyncedLanguageRef.current = target ?? ''
    typingTest.setLanguage(target ?? DEFAULT_LANGUAGE)
  }, [savedTypingTestLanguage, typingTest.setLanguage])

  // Wrapped setters that persist user-initiated changes to device prefs
  const handleTypingTestConfigChange = useCallback((newConfig: TypingTestConfig) => {
    // Starting a different imported text discards the saved snapshot.
    const mem = savedMemoryRef.current
    if (mem && newConfig.mode === 'fileImport' && newConfig.textId !== mem.textId) {
      onMemoryChangeRef.current?.(undefined)
    }
    typingTest.setConfig(newConfig)
    lastSyncedConfigRef.current = JSON.stringify(newConfig)
    onTypingTestConfigChange?.(newConfig)
  }, [typingTest.setConfig, onTypingTestConfigChange])

  const handleTypingTestLanguageChange = useCallback(async (newLanguage: string) => {
    const resolved = await typingTest.setLanguage(newLanguage)
    lastSyncedLanguageRef.current = resolved
    onTypingTestLanguageChange?.(resolved)
  }, [typingTest.setLanguage, onTypingTestLanguageChange])

  // --- Memory mode handlers ---
  const pauseTypingTest = useCallback(() => {
    const mem = typingTest.captureMemory()
    if (!mem) return
    onMemoryChangeRef.current?.(mem)
    typingTest.pause()
    // Discard (never save) the run-log buffer for THIS run on pause, and
    // block it from being re-buffered once typing resumes under the same
    // runId (see run-log-recorder.ts's `discardRun()`): resume rebases
    // `startTime` to `Date.now() - elapsedMs`, so this run's raw timeline
    // is already broken by the pause gap — the summary result above still
    // saves/resumes normally, just not this run's raw log.
    runLog.discardRun(typingTest.state.runId)
  }, [typingTest, runLog.discardRun])

  const resumeTypingTest = useCallback(() => {
    const mem = savedMemoryRef.current
    if (!mem) return
    void typingTest.restoreState(mem, true).then((ok) => {
      if (!ok) {
        onMemoryChangeRef.current?.(undefined)
        restartTypingTest()
      }
    })
  }, [typingTest, restartTypingTest])

  const restartTypingTestFromStart = useCallback(() => {
    onMemoryChangeRef.current?.(undefined)
    restartTypingTest()
  }, [restartTypingTest])

  // Window focus/blur listeners
  useEffect(() => {
    if (!typingTestMode || typingTestViewOnly) return
    setWindowFocused(document.hasFocus() && document.visibilityState === 'visible')
    function onBlur() { setWindowFocused(false) }
    function onFocus() { setWindowFocused(true) }
    function onVisibility() { setWindowFocused(document.visibilityState === 'visible') }
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [typingTestMode, typingTestViewOnly, setWindowFocused])

  return {
    matrixMode,
    pressedKeys,
    everPressedKeys,
    hasMatrixTester,
    handleMatrixToggle,
    handleTypingTestToggle,
    typingTest,
    handleTypingTestConfigChange,
    handleTypingTestLanguageChange,
    finishedResult,
    nameFinishedResult,
    savedTypingTestMemory,
    pauseTypingTest,
    resumeTypingTest,
    restartTypingTestFromStart,
  }
}
