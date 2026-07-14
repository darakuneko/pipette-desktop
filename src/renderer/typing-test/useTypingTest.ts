// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useRef, useMemo, useEffect } from 'react'
import { isTapKeycode } from './keycode-char-map'
import { getLanguageData } from './word-generator'
import { DEFAULT_TAPPING_TERM_MS } from '../../shared/qmk-settings-tapping-term'
import type { TypingTestConfig, RomajiGuide } from './types'
import { DEFAULT_CONFIG, DEFAULT_LANGUAGE, applyRomajiCaseStyle } from './types'
import type { TypingTestMemory } from '../../shared/types/pipette-settings'
import type { TypingAnalyticsEventPayload, TypingMatrixAction } from '../../shared/types/typing-analytics'
import { createWordsForConfig } from './word-supply'
import {
  type TypingTestState,
  freshState,
  createInitialState,
  isSubmitKey,
  handleChar,
  handleBackspace,
  handleSpace,
  tryFinishLastWord,
} from './run-state'
import { isRomajiInputActive, buildRomajiMatcher, romajiDetail, processRomajiKeyEvent } from './romaji-input'
import {
  type PressStartRecord,
  parseMatrixKey,
  extractSwitchLayer,
  resolveEffectiveCode,
  resolveEffectiveCodeWithLayer,
} from './matrix-layers'

export type { WordResult, TypingTestState, TypingTestStatus } from './run-state'

export interface UseTypingTestOptions {
  onAnalyticsEvent?: (event: TypingAnalyticsEventPayload) => void
  /** TAPPING_TERM (ms) used to classify masked-key presses as tap vs
   * hold on the release edge. Defaults to QMK's 200 ms; the KeymapEditor
   * passes the live value pulled from the keyboard's QMK settings when
   * available. */
  tappingTermMs?: number
}

const COUNTDOWN_MS = 3000

const IGNORED_KEYS = new Set(['Dead', 'Unidentified'])

const MAX_WPM_HISTORY = 300

export interface UseTypingTestReturn {
  state: TypingTestState
  wpm: number
  accuracy: number
  /** Current word's romaji progress (romajiInput mode only); null otherwise
   *  or once all words are done. */
  romajiGuide: RomajiGuide | null
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
  captureMemory: () => TypingTestMemory | null
  pause: () => void
  restoreState: (memory: TypingTestMemory, resume: boolean) => Promise<boolean>
}

export function useTypingTest(
  initialConfig?: TypingTestConfig,
  initialLanguage?: string,
  options?: UseTypingTestOptions,
): UseTypingTestReturn {
  // A persisted config/language pair (e.g. restored from device prefs) is
  // taken at face value — `romajiInput` is not paired with the language
  // here; `isRomajiInputActive` gates whether it's honored.
  const [config, setConfigState] = useState<TypingTestConfig>(() => initialConfig ?? DEFAULT_CONFIG)
  const [language, setLanguageState] = useState<string>(() => initialLanguage ?? DEFAULT_LANGUAGE)
  const [isLanguageLoading, setIsLanguageLoading] = useState(false)
  const [baseLayer, setBaseLayerState] = useState(0)
  const [effectiveLayer, setEffectiveLayer] = useState(0)
  const [windowFocused, setWindowFocusedState] = useState(true)
  const [state, setState] = useState<TypingTestState>(() =>
    createInitialState(initialConfig ?? DEFAULT_CONFIG, initialLanguage ?? DEFAULT_LANGUAGE),
  )
  const configRef = useRef(config)
  const stateRef = useRef(state)
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
  stateRef.current = state
  languageRef.current = language
  baseLayerRef.current = baseLayer
  windowFocusedRef.current = windowFocused
  analyticsSinkRef.current = options?.onAnalyticsEvent
  tappingTermMsRef.current = options?.tappingTermMs ?? DEFAULT_TAPPING_TERM_MS

  const restartAsync = useCallback(async () => {
    const seq = ++seqRef.current
    const result = await createWordsForConfig(configRef.current, languageRef.current)
    if (seqRef.current !== seq) return
    setState(freshState(result))
  }, [])

  const restart = useCallback(() => {
    void restartAsync()
  }, [restartAsync])

  const restartWithCountdown = useCallback(async () => {
    const seq = ++seqRef.current
    const result = await createWordsForConfig(configRef.current, languageRef.current)
    if (seqRef.current !== seq) return
    setState(freshState(result, 'countdown'))
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
    // Taken at face value — see isRomajiInputActive for why romajiInput
    // doesn't need to be paired with the active language here.
    setConfigState(newConfig)
    configRef.current = newConfig
    const seq = ++seqRef.current
    const result = await createWordsForConfig(newConfig, languageRef.current)
    if (seqRef.current !== seq) return
    setState(freshState(result))
  }, [])

  const setLanguage = useCallback(async (newLanguage: string): Promise<string> => {
    setLanguageState(newLanguage)
    languageRef.current = newLanguage

    setIsLanguageLoading(true)
    const seq = ++seqRef.current
    const langSeq = ++langLoadSeqRef.current
    try {
      await getLanguageData(newLanguage)
      const result = await createWordsForConfig(configRef.current, newLanguage)
      if (seqRef.current !== seq) return languageRef.current
      setState(freshState(result))
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
    const result = await createWordsForConfig(configRef.current, languageRef.current)
    if (seqRef.current !== seq) return
    setState(freshState(result))
  }, [])

  // --- Memory mode (imported fileImport text only): pause / capture / restore ---

  /** Snapshot the in-progress test so it can be persisted and resumed.
   *  Returns null unless an imported fileImport text is active. */
  const captureMemory = useCallback((): TypingTestMemory | null => {
    const s = stateRef.current
    const cfg = configRef.current
    if (cfg.mode !== 'fileImport') return null
    return {
      textId: cfg.textId,
      runId: s.runId,
      currentWordIndex: s.currentWordIndex,
      currentInput: s.currentInput,
      wordResults: s.wordResults.map((w) => ({ word: w.word, typed: w.typed, correct: w.correct })),
      correctChars: s.correctChars,
      incorrectChars: s.incorrectChars,
      // startTime already folds in any earlier paused/resumed segments.
      elapsedMs: s.startTime ? Date.now() - s.startTime : 0,
      wpmHistory: s.wpmHistory,
      savedAt: new Date().toISOString(),
    }
  }, [])

  /** Stop accepting input and freeze the timer (endTime pins elapsed/WPM)
   *  without discarding progress. */
  const pause = useCallback(() => {
    setState((s) => (s.status === 'running' ? { ...s, status: 'paused', endTime: Date.now() } : s))
  }, [])

  /** Load a persisted snapshot's text and restore its progress.
   *  `resume=true` continues the timer (status 'running'); `resume=false`
   *  shows it frozen ('paused') — used on re-entry so the user must confirm
   *  before continuing. Returns false when the text can no longer be loaded
   *  (e.g. deleted) so the caller can fall back to a fresh test. */
  const restoreState = useCallback(async (memory: TypingTestMemory, resume: boolean): Promise<boolean> => {
    const cfg: TypingTestConfig = { mode: 'fileImport', textId: memory.textId }
    setConfigState(cfg)
    configRef.current = cfg
    const seq = ++seqRef.current
    const { words, quote, lineBreaks, lineIndents, romajiCapable } = await createWordsForConfig(cfg, languageRef.current)
    if (seqRef.current !== seq) return false
    if (words.length === 0) return false
    const idx = Math.min(Math.max(0, memory.currentWordIndex), words.length - 1)
    const startTime = Date.now() - memory.elapsedMs
    setState({
      status: resume ? 'running' : 'paused',
      // Keep the original run's id so a paused/resumed run stays one run in
      // analytics. Older memories without a runId fall back to a fresh id.
      runId: memory.runId ?? crypto.randomUUID(),
      words,
      currentWordIndex: idx,
      currentInput: memory.currentInput,
      compositionText: '',
      wordResults: memory.wordResults.map((w) => ({ word: w.word, typed: w.typed, correct: w.correct })),
      startTime,
      // Paused: pin endTime so elapsed/WPM display stays frozen at the saved time.
      endTime: resume ? null : Date.now(),
      correctChars: memory.correctChars,
      incorrectChars: memory.incorrectChars,
      currentQuote: quote,
      wpmHistory: memory.wpmHistory,
      lineBreaks: new Set(lineBreaks),
      lineIndents,
      romajiKeystrokes: '',
      romajiCapable,
    })
    return true
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

      // Romaji mode has its own key semantics for every key kind — see
      // processRomajiKeyEvent's doc comment in romaji-input.ts. Dispatch
      // once here instead of re-checking isRomajiInputActive per branch.
      // `s.romajiCapable` (not a ref) so the capability read matches the
      // text that actually produced `s.words`, even mid-async-load.
      if (isRomajiInputActive(configRef.current, languageRef.current, s.romajiCapable)) {
        return processRomajiKeyEvent(s, key, configRef.current, languageRef.current)
      }

      // Space and Enter both advance a word, but they are distinct: at a
      // line-end word Enter is expected, elsewhere Space. The non-matching
      // key is a no-op. Flat word-flow sources have no `lineBreaks`, so
      // Space always advances and Enter is always ignored.
      if (isSubmitKey(key) || key === 'Enter') {
        if (s.status === 'waiting') {
          return { ...s, status: 'running', startTime: Date.now() }
        }
        const expectsEnter = s.lineBreaks.has(s.currentWordIndex)
        const wrongSubmitKey = key === 'Enter' ? !expectsEnter : expectsEnter
        if (wrongSubmitKey) return s
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
      // Romaji mode is direct-keystroke only; IME composition input (which
      // implies IME is on, contrary to the mode's requirement) is ignored
      // entirely rather than fed into currentInput.
      if (isRomajiInputActive(configRef.current, languageRef.current, s.romajiCapable)) return s
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

  // Keystrokes per minute (correct chars / minute). FileImport mode shows this
  // instead of WPM, since imported code / CJK text has no meaningful "words".
  const kpm = useMemo(() => {
    if (!state.startTime) return 0
    const end = state.endTime ?? Date.now()
    const minutes = (end - state.startTime) / 60000
    if (minutes <= 0) return 0
    return Math.round(state.correctChars / minutes)
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

  // Current word's romaji progress (romajiInput mode only), re-derived from
  // the accepted keystroke history on every change rather than stored on
  // state directly — see `buildRomajiMatcher`.
  const romajiGuide = useMemo(() => {
    if (!isRomajiInputActive(config, language, state.romajiCapable)) return null
    if (state.currentWordIndex >= state.words.length) return null
    const word = state.words[state.currentWordIndex]
    const detail = romajiDetail(config)
    const matcher = buildRomajiMatcher(word, state.romajiKeystrokes, detail)
    const guide: RomajiGuide = { typed: matcher.typedRomaji(), remaining: matcher.remainingGuide(), kanaCompleted: matcher.completedKanaCount() }
    return applyRomajiCaseStyle(guide, detail?.caseStyle)
  }, [config, language, state.words, state.currentWordIndex, state.romajiKeystrokes, state.romajiCapable])

  return {
    state,
    wpm,
    kpm,
    accuracy,
    romajiGuide,
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
    captureMemory,
    pause,
    restoreState,
  }
}
