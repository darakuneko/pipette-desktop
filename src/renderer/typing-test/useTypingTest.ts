// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useRef, useMemo, useEffect } from 'react'
import { extractMOLayer, extractLTLayer, extractLMLayer, isTapKeycode } from './keycode-char-map'
import { generateWords, generateWordsSync, getLanguageData, selectQuote, quoteToWords } from './word-generator'
import { DEFAULT_TAPPING_TERM_MS } from '../../shared/qmk-settings-tapping-term'
import type { TypingTestConfig, Quote } from './types'
import { DEFAULT_CONFIG, DEFAULT_LANGUAGE } from './types'
import type { TypingAnalyticsEventPayload, TypingMatrixAction } from '../../shared/types/typing-analytics'

export interface UseTypingTestOptions {
  onAnalyticsEvent?: (event: TypingAnalyticsEventPayload) => void
  /** TAPPING_TERM (ms) used to classify masked-key presses as tap vs
   * hold on the release edge. Defaults to QMK's 200 ms; the KeymapEditor
   * passes the live value pulled from the keyboard's QMK settings when
   * available. */
  tappingTermMs?: number
}

/** Press-edge record kept until the matching release edge is seen so
 * masked keys can classify the press as tap vs hold. Non-masked keys
 * are emitted immediately on press and never land in this map. */
interface PressStartRecord {
  tsMs: number
  row: number
  col: number
  layer: number
  keycode: number
}

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
  resetMatrixPressTracking: () => void
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

/** Resolve the effective keycode AND the layer the keycode was picked
 * from. Used by the analytics path so each event is attributed to the
 * layer where the key is actually defined, not the (possibly different)
 * layer the pressed key itself is activating. For example, a lone LT1
 * press at base 0 resolves to LT1(kc) from layer 0 even though it
 * activates layer 1, so the heatmap shows the press on the base-layer
 * view the user is looking at. */
function resolveEffectiveCodeWithLayer(
  row: number,
  col: number,
  keymap: Map<string, number>,
  sortedLayers: number[],
  baseLayer: number,
): { code: number; layer: number } | undefined {
  for (const layer of sortedLayers) {
    const code = keymap.get(`${layer},${row},${col}`)
    if (code != null && code !== 0x01) return { code, layer }
  }
  const baseCode = keymap.get(`${baseLayer},${row},${col}`)
  return baseCode != null ? { code: baseCode, layer: baseLayer } : undefined
}

export function useTypingTest(
  initialConfig?: TypingTestConfig,
  initialLanguage?: string,
  options?: UseTypingTestOptions,
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
  const analyticsSinkRef = useRef(options?.onAnalyticsEvent)
  const prevPressedRef = useRef<Set<string>>(new Set())
  // Press-edge starts for masked keys awaiting a release-edge match. The
  // key is `"row,col"` to mirror the Set used for pressed keys. Not used
  // for non-masked presses, which fire on the press edge itself.
  const pressStartMapRef = useRef<Map<string, PressStartRecord>>(new Map())
  const tappingTermMsRef = useRef(options?.tappingTermMs ?? DEFAULT_TAPPING_TERM_MS)
  const seqRef = useRef(0)
  const langLoadSeqRef = useRef(0)
  configRef.current = config
  languageRef.current = language
  baseLayerRef.current = baseLayer
  windowFocusedRef.current = windowFocused
  analyticsSinkRef.current = options?.onAnalyticsEvent
  tappingTermMsRef.current = options?.tappingTermMs ?? DEFAULT_TAPPING_TERM_MS

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
    const prev = prevPressedRef.current

    // Fixed-point layer activation: a key that activates a layer may
    // itself resolve differently on that newly-active layer, so keep
    // iterating until no new layer is added. Used for both the full
    // live set (drives the UI layer indicator) and the pre-existing
    // set used to classify new presses against the layer context that
    // existed before this frame.
    function activateLayers(keys: Iterable<string>): Set<number> {
      const set = new Set<number>()
      let changed = true
      while (changed) {
        changed = false
        for (const key of keys) {
          const sortedLayers = [...set].sort((a, b) => b - a)
          const [row, col] = parseMatrixKey(key)
          const code = resolveEffectiveCode(row, col, keymap, sortedLayers, bl)
          if (code == null) continue
          const targetLayer = extractSwitchLayer(code)
          if (targetLayer === null) continue
          const effective = Math.max(bl, targetLayer)
          if (!set.has(effective)) {
            set.add(effective)
            changed = true
          }
        }
      }
      return set
    }

    const activeLayerSet = activateLayers(pressed)
    const highestActiveLayer = activeLayerSet.size > 0
      ? Math.max(...activeLayerSet)
      : bl
    setEffectiveLayer(highestActiveLayer)

    // Detect press / release edges for analytics recording. Matrix events
    // come from HID polling and should fire regardless of window focus;
    // it's the caller's responsibility to stop calling processMatrixFrame
    // when recording should pause (e.g. record toggle off).
    //
    // Non-masked keys emit on press — one event per physical press, no
    // action field. Masked keys (LT/MT/TT etc.) defer to the release
    // edge so the duration vs. TAPPING_TERM can classify them into
    // tap vs hold before the event is emitted. If a release never
    // arrives (record toggled off mid-hold) the corresponding entry
    // is dropped via resetMatrixPressTracking / record gate.
    const sink = analyticsSinkRef.current
    if (sink) {
      const starts = pressStartMapRef.current
      // Layer context for a NEW press is "what OTHER keys were already
      // holding us to" — i.e. layers activated by keys carried over
      // from the previous frame. A lone MO(1) press at base 0 must
      // resolve as layer 0 even if MO(1) is also the layer 1 keycode
      // at the same cell; otherwise the press is attributed to the
      // very layer the key is activating and disappears from the
      // base-layer heatmap.
      const carriedKeys: string[] = []
      for (const k of prev) {
        if (pressed.has(k)) carriedKeys.push(k)
      }
      const preExistingLayerSet = activateLayers(carriedKeys)
      const preExistingSortedLayers = [...preExistingLayerSet].sort((a, b) => b - a)
      const ts = Date.now()
      const tappingTermMs = tappingTermMsRef.current

      for (const key of pressed) {
        if (prev.has(key)) continue
        const [row, col] = parseMatrixKey(key)
        const resolved = resolveEffectiveCodeWithLayer(row, col, keymap, preExistingSortedLayers, bl)
        if (!resolved) continue
        const { code, layer: eventLayer } = resolved
        // Only LT / MT style tap-hold keys need the deferred classify
        // pass. LSFT(kc) etc. are "masked" too but always fire the
        // modifier + base together, so the heatmap treats them as
        // regular presses.
        if (isTapKeycode(code)) {
          starts.set(key, { tsMs: ts, row, col, layer: eventLayer, keycode: code })
        } else {
          sink({ kind: 'matrix', row, col, layer: eventLayer, keycode: code, ts })
        }
      }

      for (const key of prev) {
        if (pressed.has(key)) continue
        const start = starts.get(key)
        if (!start) continue
        starts.delete(key)
        const duration = ts - start.tsMs
        const action: TypingMatrixAction = duration < tappingTermMs ? 'tap' : 'hold'
        sink({
          kind: 'matrix',
          row: start.row,
          col: start.col,
          layer: start.layer,
          keycode: start.keycode,
          ts: start.tsMs,
          action,
        })
      }
    }
    prevPressedRef.current = new Set(pressed)
  }, [])

  /** Reset press-edge tracking. Call on record toggle, device change, or
   * keymap reload so the next frame doesn't emit stale "newly pressed" events.
   * Also clears deferred masked-key press starts so a hold in progress
   * when recording stops doesn't resurface the next time recording
   * resumes. */
  const resetMatrixPressTracking = useCallback(() => {
    prevPressedRef.current = new Set()
    pressStartMapRef.current = new Map()
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

    const sink = analyticsSinkRef.current
    if (sink && (key.length === 1 || key === 'Backspace')) {
      sink({ kind: 'char', key, ts: Date.now() })
    }

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
    resetMatrixPressTracking,
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
