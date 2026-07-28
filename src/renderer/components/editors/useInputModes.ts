// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useEffect, useRef } from 'react'
import { useTypingTest } from '../../typing-test/useTypingTest'
import { buildTypingTestResult, isPbForConfig, materialLabel } from '../../typing-test/result-builder'
import { isRomajiInputActive } from '../../typing-test/romaji-input'
import type { TypingTestConfig } from '../../typing-test/types'
import { DEFAULT_CONFIG, DEFAULT_LANGUAGE } from '../../typing-test/types'
import type { TypingTestResult, TypingTestMemory } from '../../../shared/types/pipette-settings'
import type { TypingAnalyticsEventPayload, TypingAnalyticsKeyboard } from '../../../shared/types/typing-analytics'
import { parseMatrixState, POLL_INTERVAL } from './matrix-utils'
import { PROCESS_CODE_TO_KEY } from './keymap-editor-types'

/** Analytics `typing_test` dimension label for the running test: the
 *  imported text's name for fileImport, else `mode (language)` (e.g.
 *  `words (english)`) so Analyze can slice normal runs by language too.
 *  Delegates to `materialLabel` so the recording side and the Analyze run
 *  filter produce the identical join key. */
function typingTestAnalyticsLabel(
  config: TypingTestConfig,
  language: string,
  currentQuote: { source: string } | null,
): string {
  // Tatoeba's material label keys off the sentence-pack language (in the
  // config), not the MonkeyType word language, so the recording side and the
  // Analyze run filter still produce an identical join key.
  const effectiveLanguage = config.mode === 'tatoeba' ? config.language : language
  return materialLabel(config.mode, effectiveLanguage, currentQuote?.source)
}

/** Context captured by prepareAnalyticsEvent at press time and carried
 *  opaquely through useTypingTest's ordering queue to emitAnalyticsEvent.
 *  `typingTest`/`runId` are null for ordinary REC input (untagged); an
 *  editor typing-test keystroke always has both set together. */
interface PreparedAnalyticsContext {
  keyboard: TypingAnalyticsKeyboard
  typingTest: string | null
  runId: string | null
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
}: UseInputModesOptions): UseInputModesReturn {
  // --- Matrix tester state ---
  const [matrixMode, setMatrixMode] = useState(false)
  const [pressedKeys, setPressedKeys] = useState<Set<string>>(new Set())
  const [everPressedKeys, setEverPressedKeys] = useState<Set<string>>(new Set())
  const pollingRef = useRef(true)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

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
  const onRecKeystrokeRef = useRef(onRecKeystroke)
  onRecKeystrokeRef.current = onRecKeystroke
  // The sink used to read recordingActiveRef / testLabelRef / testRunIdRef
  // at the moment an event was actually sent, but a matrix event can now
  // sit in useTypingTest's ordering queue for up to the tapping term
  // (waiting on an unresolved tap-hold press ahead of it) before it gets
  // that far. Reading live state that late meant a press authorized and
  // tagged at press time could be silently dropped, or mistagged, by
  // whatever the state had become by the time it was flushed — most
  // visibly, stopping the record toggle mid-hold discarded every queued
  // event instead of just the one it was meant to finalize.
  //
  // Splitting into prepare (called once, at press time) + emit (called
  // once the event is actually ready to ship, immediately or off the
  // back of the queue) fixes that: prepare captures the gate + tag
  // decision when the keystroke happens and hands back an opaque
  // context; emit only ever ships what prepare already decided.
  const prepareAnalyticsEvent = useCallback((kind: 'matrix' | 'char'): PreparedAnalyticsContext | null => {
    const keyboard = keyboardRef.current
    if (!keyboard) return null
    const label = testLabelRef.current
    if (!recordingActiveRef.current && !label) return null
    // Tray keystroke count tracks REC only (untagged matrix events), not
    // the editor typing-test practice mode — matches recordingActive's
    // narrower definition (typingRecordEnabled && typingTestViewOnly).
    // Counted here, at press time, rather than when the event eventually
    // leaves the queue: the count is a live tray readout of physical
    // keystrokes, and a masked key can otherwise sit unresolved for up to
    // the tapping term before its emit — the user would see the tray lag
    // behind their own typing. Firing once per authorized press here
    // matches the previous call frequency (once per event that used to
    // reach the sink) without that lag, and can't double-fire or fire for
    // an unauthorized press since this whole branch is unreachable when
    // this function returns null above.
    if (!label && kind === 'matrix') {
      onRecKeystrokeRef.current?.()
    }
    // A test keystroke carries both its material label and its run id; REC
    // input carries neither (so it lands as the null run / null test).
    return { keyboard, typingTest: label, runId: label ? testRunIdRef.current : null }
  }, [])
  const emitAnalyticsEvent = useCallback((context: PreparedAnalyticsContext, payload: TypingAnalyticsEventPayload): Promise<void> => {
    const event = context.typingTest
      ? { ...payload, keyboard: context.keyboard, typingTest: context.typingTest, runId: context.runId ?? undefined }
      : { ...payload, keyboard: context.keyboard }
    // The return value is only ever awaited by a forced drain
    // (MatrixAnalyticsQueue.drainAll, via resetMatrixPressTracking) — the
    // ordinary press/release/deadline paths call this and ignore it,
    // staying fire-and-forget same as before. Caught here (not left to
    // the caller) so a drain's Promise.all never rejects on an IPC error.
    return window.vialAPI.typingAnalyticsEvent(event).catch(() => { /* fire-and-forget */ })
  }, [])
  const typingTest = useTypingTest(savedTypingTestConfig, savedTypingTestLanguage, {
    onPrepareAnalyticsEvent: prepareAnalyticsEvent,
    onEmitAnalyticsEvent: emitAnalyticsEvent,
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
  // runs first in this commit) to actually land in main before asking it
  // to flush — main's ingestEvent does a real await before an event
  // reaches its minute buffer, so an unawaited flush can be serviced
  // before a just-drained event arrives, landing that event in a fresh
  // buffer entry after the session it belonged to was already finalized.
  const prevRecordingActiveRef = useRef(recordingActive)
  useEffect(() => {
    const wasOn = prevRecordingActiveRef.current
    prevRecordingActiveRef.current = recordingActive
    if (wasOn && !recordingActive) {
      const uid = typingRecordKeyboard?.uid
      if (uid) {
        const drained = pendingDrainRef.current
        void drained
          .then(() => window.vialAPI.typingAnalyticsFlush(uid))
          .catch(() => { /* fire-and-forget */ })
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

  // Auto-save typing test result when test finishes. With save-unnamed on
  // (default) the result is persisted immediately; with it off the built
  // result is held in `pendingUnnamedResult` and only saved once the user
  // names it (commitPendingResult), so an unnamed run is discarded.
  const savedResultRef = useRef(false)
  const [pendingUnnamedResult, setPendingUnnamedResult] = useState<TypingTestResult | null>(null)
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
        fileImportTextName: typingTest.config.mode === 'fileImport' ? typingTest.state.currentQuote?.source : undefined,
        runId: typingTest.state.runId,
        romajiActive: isRomajiInputActive(typingTest.config, typingTest.language, typingTest.state.romajiCapable),
        mistakes: typingTest.state.mistakes,
      })
      result.isPb = isPbForConfig(result, typingTestHistory ?? [])
      if (saveUnnamed) {
        onSaveTypingTestResult(result)
      } else {
        setPendingUnnamedResult(result)
      }
      // Flush the test's analytics so the just-finished minute/session
      // lands in the cache promptly (Analyze can show it without waiting
      // for the minute-close / before-quit flush). Keystrokes are recorded
      // regardless of whether the result row is saved. Drain first (same
      // reasoning as the record-off flush above): a masked key pressed
      // near the end of the run may still be sitting unresolved in the
      // ordering queue, and requesting the flush before it lands in main
      // would land it in a fresh buffer entry after this run's session
      // was already finalized.
      const uid = keyboardRef.current?.uid
      if (uid) {
        resetMatrixPressTracking()
          .then(() => window.vialAPI.typingAnalyticsFlush(uid))
          .catch(() => { /* fire-and-forget */ })
      }
      // A completed test makes any saved pause snapshot obsolete.
      if (savedMemoryRef.current) onMemoryChangeRef.current?.(undefined)
    }
    if (typingTest.state.status !== 'finished') {
      savedResultRef.current = false
      // Leaving the finished state (next test / restart) drops an unsaved,
      // still-unnamed result.
      if (pendingUnnamedResult) setPendingUnnamedResult(null)
    }
  }, [typingTest.state.status, typingTest.state.startTime, typingTest.state.endTime,
    typingTest.state.correctChars, typingTest.state.incorrectChars,
    typingTest.state.currentWordIndex, typingTest.state.wpmHistory,
    typingTest.state.currentQuote, typingTest.state.runId, typingTest.state.romajiCapable,
    typingTest.wpm, typingTest.accuracy,
    typingTest.config, typingTest.language,
    typingTestHistory, onSaveTypingTestResult, saveUnnamed, pendingUnnamedResult,
    resetMatrixPressTracking])

  // The just-finished result, exposed so the pane can build name chips: the
  // held unsaved one (save-unnamed off) until named, else the saved latest.
  const finishedResult = typingTest.state.status === 'finished'
    ? (pendingUnnamedResult ?? typingTestHistory?.[0] ?? null)
    : null

  // Name the just-finished result. A held unsaved result (save-unnamed off) is
  // persisted under the name — blank keeps it discarded; otherwise the already
  // saved latest result is renamed (save-unnamed on; blank clears its name).
  const nameFinishedResult = useCallback((name: string) => {
    if (pendingUnnamedResult) {
      const trimmed = name.trim()
      if (!trimmed) return
      onSaveTypingTestResult?.({ ...pendingUnnamedResult, name: trimmed })
      setPendingUnnamedResult(null)
      return
    }
    const date = typingTestHistory?.[0]?.date
    if (date) onRenameTypingTestResult?.(date, name)
  }, [pendingUnnamedResult, onSaveTypingTestResult, onRenameTypingTestResult, typingTestHistory])

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
    finishedResult,
    nameFinishedResult,
    savedTypingTestMemory,
    pauseTypingTest,
    resumeTypingTest,
    restartTypingTestFromStart,
  }
}
