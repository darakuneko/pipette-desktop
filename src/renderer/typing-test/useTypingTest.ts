// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useRef, useMemo, useEffect } from 'react'
import { getLanguageData } from './word-generator'
import type { WeakSpotBiasProfile } from './word-generator'
import { DEFAULT_TAPPING_TERM_MS } from '../../shared/qmk-settings-tapping-term'
import type { TypingTestConfig } from './types'
import { DEFAULT_CONFIG, DEFAULT_LANGUAGE, isTimeBoundedRun, applyRomajiCaseStyle, isWeakSpotTrainingActive } from './types'
import type { TypingTestMemory } from '../../shared/types/pipette-settings'
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
import { isRomajiInputActive, processRomajiKeyEvent, buildRomajiWordsTable, buildRomajiGuideProgress, romajiDetail } from './romaji-input'
import { isKanaInputActive, processKanaKeyEvent, buildKanaWordsTable, buildKanaGuideProgress } from './kana-input'
import { deriveExpectedChar, deriveMistakeKey, deriveKanaCorrectOverride } from './expected-char'
import { useTypingTestMatrix } from './use-typing-test-matrix'
import { useTypingTestMetrics } from './use-typing-test-metrics'
import { buildMemorySnapshot, buildRestoredState } from './typing-test-memory'
import { effectiveWeakSpotInputMethod, meetsWeakSpotThreshold, weakSpotKeystrokeDeficit, type WeakSpotGateInfo, type MistakeProfile, type WeakSpotInputMethod } from './weak-spot-profile'
import type { UseTypingTestOptions, UseTypingTestReturn } from './use-typing-test-types'

type GetMistakeProfileFn = (language: string, inputMethod: WeakSpotInputMethod) => MistakeProfile | undefined

/** Resolves the immutable per-run Weak Spot Training snapshot for a
 *  words/time run about to start under `config`/`language` — undefined
 *  (sample normally) unless the toggle is on AND a loaded profile meets
 *  the keystroke gate. Called fresh at every run-start decision point
 *  (never cached across calls) so a newly saved result is honored by the
 *  very next run; the caller then threads the SAME returned value into
 *  both the initial word batch (`createWordsForConfig`) and the run
 *  state (`freshState`/`createInitialState`), which is what makes it a
 *  snapshot — nothing re-resolves it mid-run (see `refillTimeModeWords`,
 *  which only ever reads `TypingTestState.weakSpotProfile` back). */
function resolveWeakSpotProfileArg(
  config: TypingTestConfig,
  language: string,
  getMistakeProfile: GetMistakeProfileFn | undefined,
): WeakSpotBiasProfile | undefined {
  if (!isWeakSpotTrainingActive(config)) return undefined
  const inputMethod = effectiveWeakSpotInputMethod(config, language)
  const raw = getMistakeProfile?.(language, inputMethod)
  if (!raw || !meetsWeakSpotThreshold(raw.keystrokes)) return undefined
  return { inputMethod, weights: raw.weights }
}

/** Every async run-start site (restart, setConfig, setLanguage,
 *  setBaseLayer) needs the exact same three steps in the exact same order
 *  — resolve this run's Weak Spot Training snapshot, sample its word batch
 *  with that snapshot, then build the resulting run state with that SAME
 *  snapshot — so this is the one place that does all three, instead of
 *  each call site repeating the resolve-then-thread-into-two-calls
 *  sequence by hand (a shape that's easy to accidentally drop the profile
 *  from one of the two calls while editing). */
async function loadRunState(
  config: TypingTestConfig,
  language: string,
  getMistakeProfile: GetMistakeProfileFn | undefined,
  status?: TypingTestState['status'],
): Promise<TypingTestState> {
  const weakSpotProfile = resolveWeakSpotProfileArg(config, language, getMistakeProfile)
  const result = await createWordsForConfig(config, language, weakSpotProfile)
  return freshState(result, status, weakSpotProfile)
}

export type { WordResult, TypingTestState, TypingTestStatus } from './run-state'
export type { UseTypingTestOptions, UseTypingTestReturn } from './use-typing-test-types'

const COUNTDOWN_MS = 3000

const IGNORED_KEYS = new Set(['Dead', 'Unidentified'])

export function useTypingTest<TPreparedEvent = unknown>(
  initialConfig?: TypingTestConfig,
  initialLanguage?: string,
  options?: UseTypingTestOptions<TPreparedEvent>,
): UseTypingTestReturn {
  // A persisted config/language pair (e.g. restored from device prefs) is
  // taken at face value — `romajiInput` is not paired with the language
  // here; `isRomajiInputActive` gates whether it's honored.
  const [config, setConfigState] = useState<TypingTestConfig>(() => initialConfig ?? DEFAULT_CONFIG)
  const [language, setLanguageState] = useState<string>(() => initialLanguage ?? DEFAULT_LANGUAGE)
  const [isLanguageLoading, setIsLanguageLoading] = useState(false)
  const [baseLayer, setBaseLayerState] = useState(0)
  const [windowFocused, setWindowFocusedState] = useState(true)
  const getMistakeProfileRef = useRef(options?.getMistakeProfile)
  const [state, setState] = useState<TypingTestState>(() => {
    const initCfg = initialConfig ?? DEFAULT_CONFIG
    const initLang = initialLanguage ?? DEFAULT_LANGUAGE
    return createInitialState(initCfg, initLang, undefined, resolveWeakSpotProfileArg(initCfg, initLang, getMistakeProfileRef.current))
  })
  const configRef = useRef(config)
  const stateRef = useRef(state)
  const languageRef = useRef(language)
  const baseLayerRef = useRef(baseLayer)
  const windowFocusedRef = useRef(windowFocused)
  const prepareAnalyticsEventRef = useRef(options?.onPrepareAnalyticsEvent)
  const emitAnalyticsEventRef = useRef(options?.onEmitAnalyticsEvent)
  const noteKeystrokeRegistrationRef = useRef(options?.onNoteKeystrokeRegistration)
  const noteCharContextRef = useRef(options?.onNoteCharContext)
  const tappingTermMsRef = useRef(options?.tappingTermMs ?? DEFAULT_TAPPING_TERM_MS)
  const seqRef = useRef(0)
  const langLoadSeqRef = useRef(0)
  configRef.current = config
  stateRef.current = state
  languageRef.current = language
  baseLayerRef.current = baseLayer
  windowFocusedRef.current = windowFocused
  prepareAnalyticsEventRef.current = options?.onPrepareAnalyticsEvent
  emitAnalyticsEventRef.current = options?.onEmitAnalyticsEvent
  noteKeystrokeRegistrationRef.current = options?.onNoteKeystrokeRegistration
  noteCharContextRef.current = options?.onNoteCharContext
  tappingTermMsRef.current = options?.tappingTermMs ?? DEFAULT_TAPPING_TERM_MS
  getMistakeProfileRef.current = options?.getMistakeProfile

  const restartAsync = useCallback(async () => {
    const seq = ++seqRef.current
    const nextState = await loadRunState(configRef.current, languageRef.current, getMistakeProfileRef.current)
    if (seqRef.current !== seq) return
    setState(nextState)
  }, [])

  const restart = useCallback(() => {
    void restartAsync()
  }, [restartAsync])

  const restartWithCountdown = useCallback(async () => {
    const seq = ++seqRef.current
    const nextState = await loadRunState(configRef.current, languageRef.current, getMistakeProfileRef.current, 'countdown')
    if (seqRef.current !== seq) return
    setState(nextState)
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
    const nextState = await loadRunState(newConfig, languageRef.current, getMistakeProfileRef.current)
    if (seqRef.current !== seq) return
    setState(nextState)
  }, [])

  const setLanguage = useCallback(async (newLanguage: string): Promise<string> => {
    setLanguageState(newLanguage)
    languageRef.current = newLanguage

    setIsLanguageLoading(true)
    const seq = ++seqRef.current
    const langSeq = ++langLoadSeqRef.current
    try {
      await getLanguageData(newLanguage)
      const nextState = await loadRunState(configRef.current, newLanguage, getMistakeProfileRef.current)
      if (seqRef.current !== seq) return languageRef.current
      setState(nextState)
      return newLanguage
    } catch {
      if (seqRef.current !== seq) return languageRef.current
      languageRef.current = DEFAULT_LANGUAGE
      setLanguageState(DEFAULT_LANGUAGE)
      const fallbackProfile = resolveWeakSpotProfileArg(configRef.current, DEFAULT_LANGUAGE, getMistakeProfileRef.current)
      setState(createInitialState(configRef.current, DEFAULT_LANGUAGE, undefined, fallbackProfile))
      return DEFAULT_LANGUAGE
    } finally {
      if (langLoadSeqRef.current === langSeq) {
        setIsLanguageLoading(false)
      }
    }
  }, [])

  const { effectiveLayer, applyBaseLayer, processMatrixFrame, resetMatrixPressTracking } = useTypingTestMatrix<TPreparedEvent>({
    stateRef, configRef, languageRef, baseLayerRef, windowFocusedRef,
    prepareAnalyticsEventRef, emitAnalyticsEventRef, noteKeystrokeRegistrationRef, tappingTermMsRef,
  })

  const setBaseLayer = useCallback(async (layer: number) => {
    setBaseLayerState(layer)
    baseLayerRef.current = layer
    // A layer key held across the base-layer change (e.g. the keyboard
    // popover's own layer selector) must keep the indicator on its
    // latched target rather than snapping to the newly selected base —
    // see MatrixLayerLatch.displayLayer via applyBaseLayer.
    applyBaseLayer(layer)
    const seq = ++seqRef.current
    const nextState = await loadRunState(configRef.current, languageRef.current, getMistakeProfileRef.current)
    if (seqRef.current !== seq) return
    setState(nextState)
  }, [])

  // --- Memory mode (imported fileImport text only): pause / capture / restore ---

  /** Snapshot the in-progress test so it can be persisted and resumed.
   *  Returns null unless an imported fileImport text is active. */
  const captureMemory = useCallback((): TypingTestMemory | null => {
    return buildMemorySnapshot(stateRef.current, configRef.current)
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
    const text = await createWordsForConfig(cfg, languageRef.current)
    if (seqRef.current !== seq) return false
    if (text.words.length === 0) return false
    setState(buildRestoredState(memory, resume, text))
    return true
  }, [])

  const setWindowFocused = useCallback((focused: boolean) => {
    setWindowFocusedState(focused)
    windowFocusedRef.current = focused
  }, [])

  const processKeyEvent = useCallback((key: string, ctrlKey: boolean, altKey: boolean, metaKey: boolean, code?: string, shiftKey?: boolean) => {
    if (!windowFocusedRef.current) return
    // Ignore modifier combos, but allow AltGr (Ctrl+Alt) when it produces a printable character
    if (metaKey) return
    if ((ctrlKey || altKey) && key.length !== 1) return
    if (ctrlKey && !altKey) return
    if (altKey && !ctrlKey) return
    if (IGNORED_KEYS.has(key)) return

    // Char events never queue (unlike matrix events, they have no tap-hold
    // ambiguity to wait out), so prepare + emit happen back to back here,
    // in the same call — no staleness window to guard against.
    const prepare = prepareAnalyticsEventRef.current
    if (prepare && (key.length === 1 || key === 'Backspace')) {
      // Always true here — the early return above already refused to run
      // at all while unfocused — passed through anyway for a uniform
      // prepare() signature between the matrix and char call sites.
      const prepared = prepare('char', windowFocusedRef.current)
      if (prepared != null) {
        // Run-keystroke-log word attribution for this char, captured NOW
        // — before the reducer below advances state for this same key —
        // see onNoteCharContext's doc comment. Gated on focus the same
        // way as onNoteKeystrokeRegistration's own call site.
        if (windowFocusedRef.current) {
          noteCharContextRef.current?.(
            stateRef.current.runId, stateRef.current.currentWordIndex,
            () => deriveExpectedChar(stateRef.current, configRef.current, languageRef.current),
            () => deriveMistakeKey(stateRef.current, configRef.current, languageRef.current),
            windowFocusedRef.current,
            () => deriveKanaCorrectOverride(stateRef.current, configRef.current, languageRef.current, key, code, shiftKey === true),
          )
        }
        emitAnalyticsEventRef.current?.(prepared, { kind: 'char', key, ts: Date.now() })
      }
    }

    // Total-keystroke counter's predicate — same gate as the analytics
    // prepare() call above, so it counts exactly the keystrokes this
    // implementation can observe per-key (see TypingTestState.totalKeystrokes).
    const countsAsKeystroke = key.length === 1 || key === 'Backspace'

    setState((rawState) => {
      if (rawState.status !== 'waiting' && rawState.status !== 'running') return rawState
      // Applied once, up front: every branch below (including its no-op
      // paths — a wrong submit key, a Backspace on empty input) returns a
      // state derived from this already-incremented `s`, so a rejected/
      // no-op keystroke still counts as retyping cost without each branch
      // having to add it separately.
      const s = countsAsKeystroke ? { ...rawState, totalKeystrokes: rawState.totalKeystrokes + 1 } : rawState

      // Romaji mode has its own key semantics for every key kind — see
      // processRomajiKeyEvent's doc comment in romaji-input.ts. Dispatch
      // once here instead of re-checking isRomajiInputActive per branch.
      // `s.romajiCapable` (not a ref) so the capability read matches the
      // text that actually produced `s.words`, even mid-async-load.
      if (isRomajiInputActive(configRef.current, languageRef.current, s.romajiCapable)) {
        return processRomajiKeyEvent(s, key, configRef.current, languageRef.current)
      }

      // Kana mode has its own key semantics too — see
      // processKanaKeyEvent's doc comment in kana-input.ts. Judges from
      // `code`/`shiftKey` (physical position), never from `key` beyond
      // the Enter/Backspace/Space/multi-char-name checks it shares with
      // processRomajiKeyEvent's own dispatch shape.
      if (isKanaInputActive(configRef.current, languageRef.current, s.romajiCapable)) {
        return processKanaKeyEvent(s, key, code, shiftKey === true, configRef.current, languageRef.current)
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
        // Auto-finish when last char of last word is typed (words/quote modes,
        // and tatoeba's Lines pattern — every mode but a time-bounded run).
        if (!isTimeBoundedRun(configRef.current)) {
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
      // Mirrors processCompositionEnd's sticky flag, set here too (not just
      // at the end) so a run that finishes or pauses while composition is
      // still open — e.g. time-mode expiry, or pause, firing before the
      // IME ever commits — is marked uncomputable immediately. Waiting for
      // compositionEnd alone missed exactly that window: the composing
      // keydowns already bypass processKeyEvent's counter (see
      // processCompositionEnd's own comment), so a run that never reaches
      // compositionEnd would otherwise save a computable KSPC built from an
      // undercounted totalKeystrokes.
      const s2 = s.kspcUncomputable ? s : { ...s, kspcUncomputable: true }
      return { ...s2, compositionText: '' }
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
      // Any composition end during a run means at least some keystrokes were
      // routed through the IME instead of processKeyEvent's per-key counter
      // — composing keydowns never reach processKeyEvent at all (see the
      // capture-phase listener in useInputModes, `if (e.isComposing) return`)
      // — so totalKeystrokes can no longer be trusted for KSPC on this run.
      // One-way: freshState is the only place that resets it. Set
      // unconditionally, before the mode/data branches below, so every path
      // out of this updater (romaji ignore, empty-data cancel, real commit)
      // carries it.
      const s2 = s.kspcUncomputable ? s : { ...s, kspcUncomputable: true }
      // Romaji mode is direct-keystroke only; IME composition input (which
      // implies IME is on, contrary to the mode's requirement) is ignored
      // entirely rather than fed into currentInput.
      if (isRomajiInputActive(configRef.current, languageRef.current, s2.romajiCapable)) return s2
      if (!data) {
        return { ...s2, compositionText: '' }
      }
      let current = s2
      if (current.status === 'waiting') {
        current = { ...current, status: 'running', startTime: Date.now() }
      }
      current = { ...current, currentInput: current.currentInput + data, compositionText: '' }
      if (!isTimeBoundedRun(configRef.current)) {
        return tryFinishLastWord(current) ?? current
      }
      return current
    })
  }, [])

  const { wpm, kpm, accuracy, kspc, elapsedSeconds, remainingSeconds } = useTypingTestMetrics(state, config, setState)

  // Full-run per-word romaji table (romajiInput mode only) — see
  // buildRomajiWordsTable's doc comment in romaji-input.ts. Deliberately its
  // own memo, NOT depending on state.romajiKeystrokes: rebuilding a
  // RomajiMatcher per word is O(n) in word count, so it must only rerun when
  // the run's word list itself changes (fresh run / time-mode refill), not
  // on every keystroke.
  const romajiWordsTable = useMemo(
    () => buildRomajiWordsTable(config, language, state),
    [config, language, state.words, state.romajiCapable],
  )

  // Current word's romaji progress (romajiInput mode only) — see
  // buildRomajiGuideProgress's doc comment in romaji-input.ts for the
  // guide-row derivation itself; this memo only pins the dependency set
  // (unchanged from before the words-table split above). Composed with
  // romajiWordsTable and case-styled once here, rather than inside either
  // half, so the split above stays purely about the O(n) table build.
  const romajiGuide = useMemo(() => {
    const progress = buildRomajiGuideProgress(config, language, state)
    if (!progress || !romajiWordsTable) return null
    const detail = romajiDetail(config)
    return applyRomajiCaseStyle({ ...progress, words: romajiWordsTable }, detail?.caseStyle)
  }, [config, language, state.words, state.currentWordIndex, state.romajiKeystrokes, state.romajiCapable, romajiWordsTable])

  // Kana mode's own words table / guide progress — mirrors
  // romajiWordsTable/romajiGuide's split exactly (see buildKanaWordsTable's
  // own doc comment for why the full-run table is a separate, less
  // frequently rebuilt memo). No case-styling step (kana has no
  // RomajiCaseStyle-equivalent setting — かな has no upper/lower case).
  const kanaWordsTable = useMemo(
    () => buildKanaWordsTable(config, language, state),
    [config, language, state.words, state.romajiCapable],
  )
  const kanaGuide = useMemo(() => {
    const progress = buildKanaGuideProgress(config, language, state, kanaWordsTable)
    if (!progress || !kanaWordsTable) return null
    return { ...progress, words: kanaWordsTable }
  }, [config, language, state.words, state.currentWordIndex, state.kanaCharIndex, state.romajiCapable, kanaWordsTable])

  // Live Weak Spot Training gate for the Option section's toggle/hint —
  // recomputed from the CURRENT config/language (not the possibly-stale
  // snapshot an in-progress run's own state.weakSpotProfile carries). See
  // weak-spot-profile.ts's WeakSpotGateInfo doc comment for the
  // unavailable/insufficient/met distinction.
  const weakSpotGate = useMemo((): WeakSpotGateInfo => {
    if (config.mode !== 'words' && config.mode !== 'time') {
      return { applicable: false, status: 'met', deficit: null }
    }
    const inputMethod = effectiveWeakSpotInputMethod(config, language)
    const raw = options?.getMistakeProfile?.(language, inputMethod)
    if (!raw) return { applicable: true, status: 'unavailable', deficit: null }
    if (meetsWeakSpotThreshold(raw.keystrokes)) return { applicable: true, status: 'met', deficit: null }
    return { applicable: true, status: 'insufficient', deficit: weakSpotKeystrokeDeficit(raw.keystrokes) }
  }, [config, language, options?.getMistakeProfile])

  return {
    state,
    wpm,
    kpm,
    accuracy,
    kspc,
    romajiGuide,
    kanaGuide,
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
    weakSpotGate,
  }
}
