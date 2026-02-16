// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useRef, useMemo, useEffect } from 'react'
import { extractMOLayer, extractLTLayer, extractLMLayer } from './keycode-char-map'
import { generateWords, generateWordsSync, getLanguageData, selectQuote, quoteToWords } from './word-generator'
import type { TypingTestConfig, Quote } from './types'
import { DEFAULT_CONFIG, DEFAULT_LANGUAGE } from './types'

export type TypingTestStatus = 'countdown' | 'waiting' | 'running' | 'finished'

const COUNTDOWN_MS = 3000
const TIME_MODE_BATCH_SIZE = 60
const TIME_MODE_EXTEND_THRESHOLD = 10
const IGNORED_KEYS = new Set(['Dead', 'Unidentified'])

/** Check if a key is a word-submit key (half-width space or full-width space). */
function isSubmitKey(key: string): boolean {
  return key === ' ' || key === '\u3000'
}

const MAX_WPM_HISTORY = 300

export interface WordResult {
  word: string
  typed: string
  correct: boolean
}

export interface TypingTestState {
  status: TypingTestStatus
  words: string[]
  currentWordIndex: number
  currentInput: string
  compositionText: string
  wordResults: WordResult[]
  startTime: number | null
  endTime: number | null
  correctChars: number
  incorrectChars: number
  currentQuote: Quote | null
  wpmHistory: number[]
}

export interface UseTypingTestReturn {
  state: TypingTestState
  wpm: number
  accuracy: number
  elapsedSeconds: number
  remainingSeconds: number | null
  config: TypingTestConfig
  language: string
  isLanguageLoading: boolean
  baseLayer: number
  effectiveLayer: number
  windowFocused: boolean
  processMatrixFrame: (pressed: Set<string>, keymap: Map<string, number>) => void
  processKeyEvent: (key: string, ctrlKey: boolean, altKey: boolean, metaKey: boolean) => void
  processCompositionStart: () => void
  processCompositionUpdate: (data: string) => void
  processCompositionEnd: (data: string) => void
  restart: () => void
  restartWithCountdown: () => void
  setConfig: (config: TypingTestConfig) => void
  setLanguage: (language: string) => Promise<string>
  setBaseLayer: (layer: number) => void
  setWindowFocused: (focused: boolean) => void
}

/** Return the word count and generation options for word-based modes (words/time). */
function wordGenParams(config: TypingTestConfig & { mode: 'words' | 'time' }): { count: number; opts: { punctuation: boolean; numbers: boolean } } {
  return {
    count: config.mode === 'words' ? config.wordCount : TIME_MODE_BATCH_SIZE,
    opts: { punctuation: config.punctuation, numbers: config.numbers },
  }
}

function createWordsForConfigSync(config: TypingTestConfig, language: string): { words: string[]; quote: Quote | null } {
  if (config.mode === 'quote') {
    const quote = selectQuote(config.quoteLength)
    return { words: quoteToWords(quote), quote }
  }
  const { count, opts } = wordGenParams(config)
  const { words } = generateWordsSync(count, opts, language)
  return { words, quote: null }
}

async function createWordsForConfig(config: TypingTestConfig, language: string): Promise<{ words: string[]; quote: Quote | null }> {
  if (config.mode === 'quote') {
    const quote = selectQuote(config.quoteLength)
    return { words: quoteToWords(quote), quote }
  }
  const { count, opts } = wordGenParams(config)
  const { words } = await generateWords(count, opts, language)
  return { words, quote: null }
}

function createInitialState(config: TypingTestConfig, language: string, status: TypingTestStatus = 'waiting'): TypingTestState {
  const { words, quote } = createWordsForConfigSync(config, language)
  return freshState(words, quote, status)
}

function freshState(words: string[], quote: Quote | null, status: TypingTestStatus = 'waiting'): TypingTestState {
  return {
    status,
    words,
    currentWordIndex: 0,
    currentInput: '',
    compositionText: '',
    wordResults: [],
    startTime: null,
    endTime: null,
    correctChars: 0,
    incorrectChars: 0,
    currentQuote: quote,
    wpmHistory: [],
  }
}

/** Parse a "row,col" matrix key string into numeric row and col. */
function parseMatrixKey(key: string): [number, number] {
  const [r, c] = key.split(',')
  return [Number(r), Number(c)]
}

/** Extract the target layer from any layer switch keycode (MO, LT, or LM). */
function extractSwitchLayer(code: number): number | null {
  return extractMOLayer(code) ?? extractLTLayer(code) ?? extractLMLayer(code)
}

/** Resolve the effective keycode for a matrix position by checking active
 * layers in descending order, skipping KC_TRNS (0x01), then falling back
 * to the base layer. */
function resolveEffectiveCode(
  row: number,
  col: number,
  keymap: Map<string, number>,
  sortedLayers: number[],
  baseLayer: number,
): number | undefined {
  for (const layer of sortedLayers) {
    const code = keymap.get(`${layer},${row},${col}`)
    if (code != null && code !== 0x01) return code
  }
  return keymap.get(`${baseLayer},${row},${col}`)
}

export function useTypingTest(
  initialConfig?: TypingTestConfig,
  initialLanguage?: string,
): UseTypingTestReturn {
  const [config, setConfigState] = useState<TypingTestConfig>(() => initialConfig ?? DEFAULT_CONFIG)
  const [language, setLanguageState] = useState<string>(() => initialLanguage ?? DEFAULT_LANGUAGE)
  const [isLanguageLoading, setIsLanguageLoading] = useState(false)
  const [baseLayer, setBaseLayerState] = useState(0)
  const [effectiveLayer, setEffectiveLayer] = useState(0)
  const [windowFocused, setWindowFocusedState] = useState(true)
  const [state, setState] = useState<TypingTestState>(() => createInitialState(initialConfig ?? DEFAULT_CONFIG, initialLanguage ?? DEFAULT_LANGUAGE))
  const configRef = useRef(config)
  const languageRef = useRef(language)
  const baseLayerRef = useRef(baseLayer)
  const windowFocusedRef = useRef(windowFocused)
  const seqRef = useRef(0)
  const langLoadSeqRef = useRef(0)
  configRef.current = config
  languageRef.current = language
  baseLayerRef.current = baseLayer
  windowFocusedRef.current = windowFocused

  const restartAsync = useCallback(async () => {
    const seq = ++seqRef.current
    const { words, quote } = await createWordsForConfig(configRef.current, languageRef.current)
    if (seqRef.current !== seq) return
    setState(freshState(words, quote))
  }, [])

  const restart = useCallback(() => {
    void restartAsync()
  }, [restartAsync])

  const restartWithCountdown = useCallback(async () => {
    const seq = ++seqRef.current
    const { words, quote } = await createWordsForConfig(configRef.current, languageRef.current)
    if (seqRef.current !== seq) return
    setState(freshState(words, quote, 'countdown'))
  }, [])

  // Transition from countdown to waiting after delay
  useEffect(() => {
    if (state.status !== 'countdown') return
    const id = setTimeout(() => {
      setState((s) => (s.status === 'countdown' ? { ...s, status: 'waiting' } : s))
    }, COUNTDOWN_MS)
    return () => clearTimeout(id)
  }, [state.status])

  const setConfig = useCallback(async (newConfig: TypingTestConfig) => {
    setConfigState(newConfig)
    configRef.current = newConfig
    const seq = ++seqRef.current
    const { words, quote } = await createWordsForConfig(newConfig, languageRef.current)
    if (seqRef.current !== seq) return
    setState(freshState(words, quote))
  }, [])

  const setLanguage = useCallback(async (newLanguage: string): Promise<string> => {
    setLanguageState(newLanguage)
    languageRef.current = newLanguage

    setIsLanguageLoading(true)
    const seq = ++seqRef.current
    const langSeq = ++langLoadSeqRef.current
    try {
      await getLanguageData(newLanguage)
      const { words, quote } = await createWordsForConfig(configRef.current, newLanguage)
      if (seqRef.current !== seq) return languageRef.current
      setState(freshState(words, quote))
      return newLanguage
    } catch {
      if (seqRef.current !== seq) return languageRef.current
      languageRef.current = DEFAULT_LANGUAGE
      setLanguageState(DEFAULT_LANGUAGE)
      setState(createInitialState(configRef.current, DEFAULT_LANGUAGE))
      return DEFAULT_LANGUAGE
    } finally {
      if (langLoadSeqRef.current === langSeq) {
        setIsLanguageLoading(false)
      }
    }
  }, [])

  const setBaseLayer = useCallback(async (layer: number) => {
    setBaseLayerState(layer)
    baseLayerRef.current = layer
    setEffectiveLayer(layer)
    const seq = ++seqRef.current
    const { words, quote } = await createWordsForConfig(configRef.current, languageRef.current)
    if (seqRef.current !== seq) return
    setState(freshState(words, quote))
  }, [])

  const processMatrixFrame = useCallback((pressed: Set<string>, keymap: Map<string, number>) => {
    const bl = baseLayerRef.current

    const activeLayerSet = new Set<number>()
    let changed = true
    while (changed) {
      changed = false
      for (const key of pressed) {
        const sortedLayers = [...activeLayerSet].sort((a, b) => b - a)
        const [row, col] = parseMatrixKey(key)
        const code = resolveEffectiveCode(row, col, keymap, sortedLayers, bl)
        if (code == null) continue
        const targetLayer = extractSwitchLayer(code)
        if (targetLayer === null) continue
        const effective = Math.max(bl, targetLayer)
        if (!activeLayerSet.has(effective)) {
          activeLayerSet.add(effective)
          changed = true
        }
      }
    }
    const highestActiveLayer = activeLayerSet.size > 0
      ? Math.max(...activeLayerSet)
      : bl
    setEffectiveLayer(highestActiveLayer)
  }, [])

  const setWindowFocused = useCallback((focused: boolean) => {
    setWindowFocusedState(focused)
    windowFocusedRef.current = focused
  }, [])

  const processKeyEvent = useCallback((key: string, ctrlKey: boolean, altKey: boolean, metaKey: boolean) => {
    if (!windowFocusedRef.current) return
    // Ignore modifier combos, but allow AltGr (Ctrl+Alt) when it produces a printable character
    if (metaKey) return
    if ((ctrlKey || altKey) && key.length !== 1) return
    if (ctrlKey && !altKey) return
    if (altKey && !ctrlKey) return
    if (IGNORED_KEYS.has(key)) return

    setState((s) => {
      if (s.status !== 'waiting' && s.status !== 'running') return s

      if (isSubmitKey(key)) {
        if (s.status === 'waiting') {
          return { ...s, status: 'running', startTime: Date.now() }
        }
        return handleSpace(s, configRef.current, languageRef.current)
      }

      if (key === 'Backspace') {
        // Don't start the test on backspace
        if (s.status === 'waiting') return s
        return handleBackspace(s)
      }

      // Single printable character
      if (key.length === 1) {
        let current = s
        if (current.status === 'waiting') {
          current = { ...current, status: 'running', startTime: Date.now() }
        }
        current = handleChar(current, key)
        // Auto-finish when last char of last word is typed (words/quote modes only)
        if (configRef.current.mode !== 'time') {
          return tryFinishLastWord(current) ?? current
        }
        return current
      }

      // Multi-character key names (Shift, Control, etc.) — ignore
      return s
    })
  }, [])

  const processCompositionStart = useCallback(() => {
    setState((s) => {
      if (s.status !== 'waiting' && s.status !== 'running') return s
      return { ...s, compositionText: '' }
    })
  }, [])

  const processCompositionUpdate = useCallback((data: string) => {
    setState((s) => {
      if (s.status !== 'waiting' && s.status !== 'running') return s
      return { ...s, compositionText: data }
    })
  }, [])

  const processCompositionEnd = useCallback((data: string) => {
    setState((s) => {
      if (s.status !== 'waiting' && s.status !== 'running') return s
      if (!data) {
        return { ...s, compositionText: '' }
      }
      let current = s
      if (current.status === 'waiting') {
        current = { ...current, status: 'running', startTime: Date.now() }
      }
      current = { ...current, currentInput: current.currentInput + data, compositionText: '' }
      if (configRef.current.mode !== 'time') {
        return tryFinishLastWord(current) ?? current
      }
      return current
    })
  }, [])

  // Tick every second while running so elapsed time and WPM update live
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (state.status !== 'running') return
    const id = setInterval(() => {
      setTick((n) => n + 1)
      // Record WPM snapshot for history
      setState((s) => {
        if (s.status !== 'running' || !s.startTime) return s
        const elapsed = (Date.now() - s.startTime) / 60000
        if (elapsed <= 0) return s
        const currentWpm = Math.round((s.correctChars / 5) / elapsed)
        if (s.wpmHistory.length >= MAX_WPM_HISTORY) return s
        return { ...s, wpmHistory: [...s.wpmHistory, currentWpm] }
      })
    }, 1000)
    return () => clearInterval(id)
  }, [state.status])

  // Time mode countdown - finish when remaining reaches 0
  useEffect(() => {
    if (state.status !== 'running') return
    if (config.mode !== 'time') return
    if (!state.startTime) return

    const elapsed = Math.floor((Date.now() - state.startTime) / 1000)
    if (elapsed >= config.duration) {
      setState((s) => {
        if (s.status !== 'running') return s
        return { ...s, status: 'finished', endTime: Date.now() }
      })
    }
  }, [tick, state.status, state.startTime, config])

  const wpm = useMemo(() => {
    if (!state.startTime) return 0
    const end = state.endTime ?? Date.now()
    const minutes = (end - state.startTime) / 60000
    if (minutes <= 0) return 0
    return Math.round((state.correctChars / 5) / minutes)
  }, [state.startTime, state.endTime, state.correctChars, tick])

  const accuracy = useMemo(() => {
    const total = state.correctChars + state.incorrectChars
    if (total === 0) return 100
    return Math.round((state.correctChars / total) * 100)
  }, [state.correctChars, state.incorrectChars])

  const elapsedSeconds = useMemo(() => {
    if (!state.startTime) return 0
    const end = state.endTime ?? Date.now()
    return Math.floor((end - state.startTime) / 1000)
  }, [state.startTime, state.endTime, tick])

  const remainingSeconds = useMemo(() => {
    if (config.mode !== 'time') return null
    if (!state.startTime) return config.duration
    if (state.endTime) return 0
    const elapsed = Math.floor((Date.now() - state.startTime) / 1000)
    return Math.max(0, config.duration - elapsed)
  }, [config, state.startTime, state.endTime, tick])

  return {
    state,
    wpm,
    accuracy,
    elapsedSeconds,
    remainingSeconds,
    config,
    language,
    isLanguageLoading,
    baseLayer,
    effectiveLayer,
    windowFocused,
    processMatrixFrame,
    processKeyEvent,
    processCompositionStart,
    processCompositionUpdate,
    processCompositionEnd,
    restart,
    restartWithCountdown,
    setConfig,
    setLanguage,
    setBaseLayer,
    setWindowFocused,
  }
}

function handleChar(state: TypingTestState, char: string): TypingTestState {
  if (state.currentWordIndex >= state.words.length) return state
  return {
    ...state,
    currentInput: state.currentInput + char,
  }
}

/** If the last word is fully typed, finalize it and finish the test. */
function tryFinishLastWord(state: TypingTestState): TypingTestState | null {
  if (state.currentWordIndex !== state.words.length - 1) return null
  const currentWord = state.words[state.currentWordIndex]
  if (state.currentInput !== currentWord) return null

  // Count chars without trailing space bonus (no space needed for last word)
  let correct = 0
  for (let i = 0; i < currentWord.length; i++) correct++

  return {
    ...state,
    currentWordIndex: state.currentWordIndex + 1,
    currentInput: '',
    wordResults: [...state.wordResults, { word: currentWord, typed: currentWord, correct: true }],
    correctChars: state.correctChars + correct,
    incorrectChars: state.incorrectChars,
    status: 'finished',
    endTime: Date.now(),
  }
}

function handleSpace(state: TypingTestState, config: TypingTestConfig, language: string): TypingTestState {
  if (state.currentWordIndex >= state.words.length) return state

  const currentWord = state.words[state.currentWordIndex]
  const typed = state.currentInput
  const isCorrect = typed === currentWord
  const charCounts = computeWordCharCounts(currentWord, typed)

  const nextIndex = state.currentWordIndex + 1

  const base: TypingTestState = {
    ...state,
    currentWordIndex: nextIndex,
    currentInput: '',
    wordResults: [...state.wordResults, { word: currentWord, typed, correct: isCorrect }],
    correctChars: state.correctChars + charCounts.correct,
    incorrectChars: state.incorrectChars + charCounts.incorrect,
  }

  // Time mode: extend words if running low, never finish from words
  if (config.mode === 'time') {
    const wordsRemaining = state.words.length - nextIndex
    if (wordsRemaining < TIME_MODE_EXTEND_THRESHOLD) {
      const { words: moreWords } = generateWordsSync(TIME_MODE_BATCH_SIZE, {
        punctuation: config.punctuation,
        numbers: config.numbers,
      }, language)
      return { ...base, words: [...state.words, ...moreWords] }
    }
    return base
  }

  // Words and quote modes: finish when all words typed
  if (nextIndex >= state.words.length) {
    return { ...base, status: 'finished', endTime: Date.now() }
  }
  return base
}

function handleBackspace(state: TypingTestState): TypingTestState {
  if (state.currentInput.length === 0) return state
  return {
    ...state,
    currentInput: state.currentInput.slice(0, -1),
  }
}

function computeWordCharCounts(word: string, typed: string): { correct: number; incorrect: number } {
  const len = Math.max(typed.length, word.length)
  let correct = 1 // count the space separator as a correct char
  let incorrect = 0

  for (let i = 0; i < len; i++) {
    if (i < typed.length && i < word.length && typed[i] === word[i]) {
      correct++
    } else {
      incorrect++
    }
  }

  return { correct, incorrect }
}
