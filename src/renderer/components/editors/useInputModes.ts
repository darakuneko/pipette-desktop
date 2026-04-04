// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useEffect, useRef } from 'react'
import { useTypingTest } from '../../typing-test/useTypingTest'
import { buildTypingTestResult, isPbForConfig } from '../../typing-test/result-builder'
import type { TypingTestConfig } from '../../typing-test/types'
import { DEFAULT_CONFIG, DEFAULT_LANGUAGE } from '../../typing-test/types'
import type { TypingTestResult } from '../../../shared/types/pipette-settings'
import { parseMatrixState, POLL_INTERVAL } from './matrix-utils'
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
  typingTestHistory?: TypingTestResult[]
  typingTestViewOnly?: boolean
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
  typingTestHistory,
  typingTestViewOnly,
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
  const typingTest = useTypingTest(savedTypingTestConfig, savedTypingTestLanguage)
  const {
    restart: restartTypingTest,
    restartWithCountdown,
    processMatrixFrame,
    processKeyEvent,
    setWindowFocused,
  } = typingTest
  const [pendingTypingTest, setPendingTypingTest] = useState(false)

  useEffect(() => {
    if (pendingTypingTest && unlocked) {
      setPendingTypingTest(false)
      enterMatrixMode()
      restartWithCountdown()
      onTypingTestModeChange?.(true)
    }
  }, [pendingTypingTest, unlocked, enterMatrixMode, restartWithCountdown, onTypingTestModeChange])

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
      enterMatrixMode()
      restartTypingTest()
      onTypingTestModeChange?.(true)
    } else {
      setPendingTypingTest(true)
      onUnlock?.()
    }
  }, [typingTestMode, unlocked, resetMatrixState, enterMatrixMode, restartTypingTest, onTypingTestModeChange, onUnlock])

  // Feed matrix frames to typing test
  useEffect(() => {
    if (!typingTestMode) return
    processMatrixFrame(pressedKeys, keymap)
  }, [pressedKeys, typingTestMode, processMatrixFrame, keymap])

  // Capture-phase keydown listener for typing test
  useEffect(() => {
    if (!typingTestMode || typingTestViewOnly) return
    function handler(e: KeyboardEvent) {
      if (document.querySelector('[role="dialog"]')) return
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
      })
      result.isPb = isPbForConfig(result, typingTestHistory ?? [])
      onSaveTypingTestResult(result)
    }
    if (typingTest.state.status !== 'finished') {
      savedResultRef.current = false
    }
  }, [typingTest.state.status, typingTest.state.startTime, typingTest.state.endTime,
    typingTest.state.correctChars, typingTest.state.incorrectChars,
    typingTest.state.currentWordIndex, typingTest.state.wpmHistory,
    typingTest.wpm, typingTest.accuracy,
    typingTest.config, typingTest.language,
    typingTestHistory, onSaveTypingTestResult])

  // Sync saved config/language from device prefs into useTypingTest
  const lastSyncedConfigRef = useRef('')
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
    typingTest.setConfig(newConfig)
    lastSyncedConfigRef.current = JSON.stringify(newConfig)
    onTypingTestConfigChange?.(newConfig)
  }, [typingTest.setConfig, onTypingTestConfigChange])

  const handleTypingTestLanguageChange = useCallback(async (newLanguage: string) => {
    const resolved = await typingTest.setLanguage(newLanguage)
    lastSyncedLanguageRef.current = resolved
    onTypingTestLanguageChange?.(resolved)
  }, [typingTest.setLanguage, onTypingTestLanguageChange])

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
  }
}
