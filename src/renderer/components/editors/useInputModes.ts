// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useEffect, useRef } from 'react'
import { useTypingTest } from '../../typing-test/useTypingTest'
import { buildTypingTestResult, isPbForConfig, materialLabel } from '../../typing-test/result-builder'
import type { TypingTestConfig } from '../../typing-test/types'
import { DEFAULT_CONFIG, DEFAULT_LANGUAGE } from '../../typing-test/types'
import type { TypingTestResult, TypingTestMemory } from '../../../shared/types/pipette-settings'
import type { TypingAnalyticsEventPayload, TypingAnalyticsKeyboard } from '../../../shared/types/typing-analytics'
import { parseMatrixState, POLL_INTERVAL } from './matrix-utils'
import { PROCESS_CODE_TO_KEY } from './keymap-editor-types'

/** Analytics `typing_test` dimension label for the running test: the
 *  imported text's name for custom, else `mode (language)` (e.g.
 *  `words (english)`) so Analyze can slice normal runs by language too.
 *  Delegates to `materialLabel` so the recording side and the Analyze run
 *  filter produce the identical join key. */
function typingTestAnalyticsLabel(
  config: TypingTestConfig,
  language: string,
  currentQuote: { source: string } | null,
): string {
  return materialLabel(config.mode, language, currentQuote?.source)
}

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
  /** Persisted paused-test snapshot for the active keyboard (memory mode). */
  savedTypingTestMemory?: TypingTestMemory
  /** Persist or clear the paused-test snapshot. */
  onTypingTestMemoryChange?: (memory: TypingTestMemory | undefined) => void
  typingTestHistory?: TypingTestResult[]
  typingTestViewOnly?: boolean
  typingRecordEnabled?: boolean
  typingRecordKeyboard?: TypingAnalyticsKeyboard
  /** TAPPING_TERM (ms) forwarded to useTypingTest for masked-key
   * tap/hold classification. Defaults to QMK's 200 ms when the
   * keyboard hasn't reported one. */
  tappingTermMs?: number
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
  /** Memory mode (imported custom text). */
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
  savedTypingTestMemory,
  onTypingTestMemoryChange,
  typingTestHistory,
  typingTestViewOnly,
  typingRecordEnabled,
  typingRecordKeyboard,
  tappingTermMs,
}: UseInputModesOptions): UseInputModesReturn {
  // --- Matrix tester state ---
  const [matrixMode, setMatrixMode] = useState(false)
  const [pressedKeys, setPressedKeys] = useState<Set<string>>(new Set())
  const [everPressedKeys, setEverPressedKeys] = useState<Set<string>>(new Set())
  const pollingRef = useRef(true)
  const timerRef = useRef<ReturnType<typeof setTimeout>>()

  const hasMatrixTester = (getMatrixState != null && rows != null && cols != null) || matrixMode

  useEffect(() => {
    onMatrixModeChange?.(matrixMode, hasMatrixTester)
  }, [matrixMode, hasMatrixTester, onMatrixModeChange])

  // --- Matrix polling ---
  const poll = useCallback(async () => {
    if (!pollingRef.current || !getMatrixState || rows == null || cols == null) return
    try {
      const data = await getMatrixState()
      if (!pollingRef.current) return
      const pressed = parseMatrixState(data, rows, cols)
      setPressedKeys(pressed)
      setEverPressedKeys((prev) => {
        const next = new Set(prev)
        for (const key of pressed) next.add(key)
        return next
      })
    } catch {
      // device may disconnect
    }
    if (pollingRef.current) {
      timerRef.current = setTimeout(poll, POLL_INTERVAL)
    }
  }, [getMatrixState, rows, cols])

  useEffect(() => {
    if (!matrixMode || !unlocked) return
    pollingRef.current = true
    poll()
    return () => {
      pollingRef.current = false
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [poll, matrixMode, unlocked])

  // Deferred matrix mode entry
  const [pendingMatrix, setPendingMatrix] = useState(false)

  const enterMatrixMode = useCallback(() => {
    setMatrixMode(true)
  }, [])

  useEffect(() => {
    if (pendingMatrix && unlocked) {
      setPendingMatrix(false)
      enterMatrixMode()
    }
  }, [pendingMatrix, unlocked, enterMatrixMode])

  const resetMatrixState = useCallback(() => {
    setPressedKeys(new Set())
    setEverPressedKeys(new Set())
    setMatrixMode(false)
  }, [])

  // Exit key tester when the keyboard is locked
  useEffect(() => {
    if (!unlocked && matrixMode) resetMatrixState()
  }, [unlocked, matrixMode, resetMatrixState])

  const handleMatrixToggle = useCallback(() => {
    if (matrixMode) {
      resetMatrixState()
    } else if (unlocked) {
      enterMatrixMode()
    } else {
      setPendingMatrix(true)
      onUnlock?.()
    }
  }, [matrixMode, unlocked, resetMatrixState, enterMatrixMode, onUnlock])

  // --- Typing test ---
  const keyboardRef = useRef(typingRecordKeyboard)
  keyboardRef.current = typingRecordKeyboard
  // Analytics event sink — two independent sources feed the same pipeline:
  //   1. Typing View REC ambient typing — gated by recordingActiveRef
  //      (record toggle ON + compact window open), emitted untagged.
  //   2. A typing test running in the editor — gated by testLabelRef
  //      (non-null while a test is the active input source), emitted with
  //      a `typingTest` dimension tag so Analyze can slice by which test.
  // Both refs are updated below from render so this stays a stable callback
  // (useTypingTest captures it once).
  const recordingActiveRef = useRef(false)
  const testLabelRef = useRef<string | null>(null)
  const testRunIdRef = useRef<string | null>(null)
  const analyticsSink = useCallback((payload: TypingAnalyticsEventPayload) => {
    const keyboard = keyboardRef.current
    if (!keyboard) return
    const label = testLabelRef.current
    if (!recordingActiveRef.current && !label) return
    // A test keystroke carries both its material label and its run id; REC
    // input carries neither (so it lands as the null run / null test).
    const event = label
      ? { ...payload, keyboard, typingTest: label, runId: testRunIdRef.current ?? undefined }
      : { ...payload, keyboard }
    window.vialAPI.typingAnalyticsEvent(event).catch(() => { /* fire-and-forget */ })
  }, [])
  const typingTest = useTypingTest(savedTypingTestConfig, savedTypingTestLanguage, {
    onAnalyticsEvent: analyticsSink,
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
   *  custom text, restore it frozen ('paused') so the user must choose
   *  resume / restart before typing; otherwise start a fresh test. */
  const beginTypingTest = useCallback((withCountdown: boolean) => {
    enterMatrixMode()
    const mem = savedMemoryRef.current
    const cfg = savedConfigRef.current
    if (mem && cfg?.mode === 'custom' && cfg.textId === mem.textId) {
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
  // A test in the editor (not the REC view) is the tagged input source.
  testLabelRef.current = typingTestMode && !typingTestViewOnly
    ? typingTestAnalyticsLabel(typingTest.config, typingTest.language, typingTest.state.currentQuote)
    : null
  // Run id travels with the label so each run's keystrokes are separable.
  testRunIdRef.current = testLabelRef.current ? typingTest.state.runId : null

  // Reset matrix press-edge tracking when keymap changes or recording toggles
  // so the next frame doesn't emit stale press events against an old state.
  useEffect(() => {
    resetMatrixPressTracking()
  }, [keymap, recordingActive, resetMatrixPressTracking])

  // When recording transitions off (either the toggle flips or the user
  // leaves view-only mode), finalize the open session in main and flush
  // its data for the active keyboard.
  const prevRecordingActiveRef = useRef(recordingActive)
  useEffect(() => {
    const wasOn = prevRecordingActiveRef.current
    prevRecordingActiveRef.current = recordingActive
    if (wasOn && !recordingActive) {
      const uid = typingRecordKeyboard?.uid
      if (uid) {
        window.vialAPI.typingAnalyticsFlush(uid).catch(() => { /* fire-and-forget */ })
      }
    }
  }, [recordingActive, typingRecordKeyboard])

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

  // Auto-save typing test result when test finishes
  const savedResultRef = useRef(false)
  useEffect(() => {
    if (typingTestViewOnly) return
    if (typingTest.state.status === 'finished' && !savedResultRef.current && onSaveTypingTestResult) {
      savedResultRef.current = true
      const elapsed = typingTest.state.startTime && typingTest.state.endTime
        ? typingTest.state.endTime - typingTest.state.startTime
        : 0
      const result = buildTypingTestResult({
        correctChars: typingTest.state.correctChars,
        incorrectChars: typingTest.state.incorrectChars,
        wordCount: typingTest.state.currentWordIndex,
        wpm: typingTest.wpm,
        accuracy: typingTest.accuracy,
        elapsedMs: elapsed,
        config: typingTest.config,
        language: typingTest.language,
        wpmHistory: typingTest.state.wpmHistory,
        customTextName: typingTest.config.mode === 'custom' ? typingTest.state.currentQuote?.source : undefined,
        runId: typingTest.state.runId,
      })
      result.isPb = isPbForConfig(result, typingTestHistory ?? [])
      onSaveTypingTestResult(result)
      // Flush the test's analytics so the just-finished minute/session
      // lands in the cache promptly (Analyze can show it without waiting
      // for the minute-close / before-quit flush).
      const uid = keyboardRef.current?.uid
      if (uid) window.vialAPI.typingAnalyticsFlush(uid).catch(() => { /* fire-and-forget */ })
      // A completed test makes any saved pause snapshot obsolete.
      if (savedMemoryRef.current) onMemoryChangeRef.current?.(undefined)
    }
    if (typingTest.state.status !== 'finished') {
      savedResultRef.current = false
    }
  }, [typingTest.state.status, typingTest.state.startTime, typingTest.state.endTime,
    typingTest.state.correctChars, typingTest.state.incorrectChars,
    typingTest.state.currentWordIndex, typingTest.state.wpmHistory,
    typingTest.state.currentQuote, typingTest.state.runId,
    typingTest.wpm, typingTest.accuracy,
    typingTest.config, typingTest.language,
    typingTestHistory, onSaveTypingTestResult])

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
    if (mem && newConfig.mode === 'custom' && newConfig.textId !== mem.textId) {
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
  }, [typingTest])

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
    savedTypingTestMemory,
    pauseTypingTest,
    resumeTypingTest,
    restartTypingTestFromStart,
  }
}
