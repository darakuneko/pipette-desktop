// SPDX-License-Identifier: GPL-2.0-or-later

/** Romaji-mode key semantics: the guard for whether romaji judging is
 *  active for the current config/language, matcher construction/replay,
 *  and the key-event handler that dispatches into it. */

import { createRomajiMatcher, canonicalRomaji, type RomajiMatcher, type RomajiMatcherOptions } from './romaji-engine'
import type { TypingTestConfig, RomajiDetailSettings, RomajiGuide } from './types'
import { ROMAJI_INPUT_LANGUAGES } from './types'
import { type TypingTestState, isSubmitKey, advanceAfterWord } from './run-state'

/** True when the romaji-keystroke matcher can operate at all for the given
 *  config, independent of whether the user has actually opted in via
 *  `romajiInput`. Per mode:
 *  - words/time: the active word-language pack is a kana pack (see
 *    `ROMAJI_INPUT_LANGUAGES`).
 *  - tatoeba: the selected pack's `language` id is a kana pack — same set,
 *    since Tatoeba kana packs reuse the monkeytype language ids.
 *  - fileImport: the loaded text's content is pure kana. This can't be
 *    derived from `config` alone (a `textId` says nothing about its
 *    content), so the caller passes in `textRomajiCapable` — sourced from
 *    the typing-test-texts store's computed `romajiCapable` meta field for
 *    the text currently loaded into the run (see `TypingTestState.romajiCapable`
 *    in run-state.ts).
 *  - quote: never capable — quotes are plain-language prose, not kana.
 *  Used both to gate the SettingsBar's Romaji button and, via
 *  `isRomajiInputActive`, to decide whether the (default-on) `romajiInput`
 *  choice is actually honored. */
export function isRomajiCapable(config: TypingTestConfig, language: string, textRomajiCapable: boolean | undefined): boolean {
  switch (config.mode) {
    case 'words':
    case 'time':
      return ROMAJI_INPUT_LANGUAGES.has(language)
    case 'tatoeba':
      return ROMAJI_INPUT_LANGUAGES.has(config.language)
    case 'fileImport':
      return textRomajiCapable === true
    case 'quote':
      return false
  }
}

/** True when the config has opted into sequential romaji-keystroke judging,
 *  independent of whether the mode/content combination is actually capable
 *  of it (see `isRomajiCapable`) — the pure "user opted in" predicate, not
 *  capability-gated. Defaults ON: `romajiInput === undefined` is treated as
 *  opted-in, and only an explicit `false` opts out — mirroring how the
 *  Romaji Settings modal's master toggle writes `false` rather than
 *  deleting the field when the user turns it off (see `RomajiSettingsModal`).
 *  `romajiInput` is persisted as-is regardless of capability — same as
 *  `punctuation`/`numbers` on words/time — so this stays true across any
 *  config/language/text sync order (e.g. a persisted config landing before
 *  the persisted language on mount); capability gating happens separately
 *  in `isRomajiInputActive`. `quote` never carries the field and is always
 *  off. */
export function isRomajiInputEnabled(config: TypingTestConfig): boolean {
  return config.mode === 'quote' ? false : config.romajiInput !== false
}

/** True when the config opts into sequential romaji-keystroke judging
 *  (`isRomajiInputEnabled`) AND the mode/content combination is actually
 *  capable of it (`isRomajiCapable`). This is what actually gates whether
 *  keystrokes are judged romaji-style — the flag itself is never stripped
 *  while incapable (see `isRomajiInputEnabled`), and comes back into effect
 *  automatically once a capable language/text is selected again, without
 *  the user needing to re-toggle it. */
export function isRomajiInputActive(config: TypingTestConfig, language: string, textRomajiCapable: boolean | undefined): boolean {
  return isRomajiInputEnabled(config) && isRomajiCapable(config, language, textRomajiCapable)
}

/** Carries a config's `romajiInput`/`romaji` choice into a freshly built
 *  config of a different mode — used when switching tatoeba language or
 *  importing a new file (`TypingTestPane`'s language selector), which each
 *  build a brand-new config object from scratch rather than spreading the
 *  previous one (unlike the Pattern row's mode switch, which already
 *  carries these fields via `TypingTestSettingsBar`'s `togglesRef`).
 *  Without this, the user's explicit opt-out (`romajiInput: false`) or
 *  detail settings would silently reset to the default on every such
 *  switch. Returns `{}` for `quote` (which has no romaji fields at all) or
 *  when the source config never set them. */
export function carryRomajiFields(config: TypingTestConfig): { romajiInput?: boolean; romaji?: RomajiDetailSettings } {
  if (config.mode === 'quote') return {}
  const fields: { romajiInput?: boolean; romaji?: RomajiDetailSettings } = {}
  if (typeof config.romajiInput === 'boolean') fields.romajiInput = config.romajiInput
  const romaji = romajiDetail(config)
  if (romaji) fields.romaji = romaji
  return fields
}

/** Rebuilds a matcher for `word` by replaying every keystroke accepted so
 *  far for it. Called fresh on each read/write instead of keeping a live
 *  `RomajiMatcher` instance in React state, so state transitions (and the
 *  read-only `romajiGuide` selector) stay pure \u2014 mutation is local to this
 *  call and never escapes it, even under StrictMode's double-invoked
 *  updater functions. Word lengths are short (a handful of kana), so the
 *  replay cost is negligible. */
export function buildRomajiMatcher(word: string, keystrokes: string, opts?: RomajiMatcherOptions): RomajiMatcher {
  const matcher = createRomajiMatcher(word, opts)
  for (const key of keystrokes) matcher.acceptChar(key)
  return matcher
}

/** The single next character romaji judging expects for `word`, given
 *  what's been typed so far — `buildRomajiMatcher(...).nextGuideChar()`,
 *  which (unlike reading `remainingGuide()[0]`) never builds the guide
 *  for the rest of the word just to read one character off it. Used by
 *  expected-char.ts's `deriveExpectedChar` for the romaji branch. */
export function romajiNextExpectedChar(word: string, keystrokes: string, opts?: RomajiMatcherOptions): string | undefined {
  return buildRomajiMatcher(word, keystrokes, opts).nextGuideChar()
}

/** Romaji Settings modal detail fields (disabledStyles / guideStyles /
 *  caseStyle), read only while `romajiInput` is honored (see
 *  `isRomajiInputActive`) — the config shape guarantees `romaji` only
 *  exists on words/time/tatoeba/fileImport configs, so this is undefined
 *  for quote. Passed straight through as `buildRomajiMatcher`'s opts: its
 *  disabledStyles/guideStyles fields structurally satisfy
 *  `RomajiMatcherOptions`, and `createRomajiMatcher` itself already
 *  normalizes an empty disabledStyles/guideStyles array, so there's
 *  nothing left to prune here. */
export function romajiDetail(config: TypingTestConfig): RomajiDetailSettings | undefined {
  return config.mode === 'quote' ? undefined : config.romaji
}

/** Romaji-mode key semantics, dispatched once from `processKeyEvent`'s
 *  updater instead of checking `isRomajiInputActive` separately at each key
 *  kind. Space and Backspace are always no-ops in this mode — rejected
 *  keystrokes never entered the buffer, so there is nothing to undo, and
 *  romaji mode never uses Space to submit (see `handleRomajiChar`). Enter is
 *  a no-op everywhere EXCEPT to commit a LINE-END word (`state.lineBreaks`)
 *  whose romaji has reached `isComplete()` — such a word holds instead of
 *  auto-advancing on completion (see `handleRomajiChar`), matching the
 *  non-romaji Enter-at-line-end convention (Task-romaji-line-end-enter). A
 *  printable character starts the run from 'waiting' before being fed to
 *  the matcher; Enter never starts the run from 'waiting' (mirrors the
 *  pre-existing romaji policy of only a printable char doing so). Every
 *  other key (multi-char names like Shift/Control) passes through
 *  untouched, matching the non-romaji fallback. IME composition input is
 *  gated separately in `processCompositionEnd`, not here. */
export function processRomajiKeyEvent(state: TypingTestState, key: string, config: TypingTestConfig, language: string): TypingTestState {
  if (isSubmitKey(key)) return state
  if (key === 'Enter') {
    if (state.status !== 'running') return state
    if (state.currentWordIndex >= state.words.length) return state
    const word = state.words[state.currentWordIndex]
    const matcher = buildRomajiMatcher(word, state.romajiKeystrokes, romajiDetail(config))
    if (matcher.isComplete() && state.lineBreaks.has(state.currentWordIndex)) {
      return commitRomajiWord(state, matcher, config, language)
    }
    return state
  }
  if (key === 'Backspace') return state
  if (key.length === 1) {
    const current = state.status === 'waiting' ? { ...state, status: 'running' as const, startTime: Date.now() } : state
    return handleRomajiChar(current, key, config, language)
  }
  return state
}

/** Atomic word-advance commit shared by `handleRomajiChar`'s auto-advance
 *  path and `processRomajiKeyEvent`'s Enter-at-line-end path: pushes the
 *  finished word into `wordResults` (typed spelling read from `matcher`),
 *  resets the word-scoped fields (`currentInput`/`romajiKeystrokes`/
 *  `missedPositions`), advances `currentWordIndex`, and unconditionally
 *  resets `romajiSegmentErred` to false — a printable keystroke rejected
 *  AFTER completion while a line-end word is held (see `handleRomajiChar`)
 *  sets that flag, and it must not leak into the next word's mistake
 *  attribution. Delegates the actual run-continuation/refill/finish
 *  decision to `advanceAfterWord`, same as the non-romaji Space/Enter path. */
function commitRomajiWord(state: TypingTestState, matcher: RomajiMatcher, config: TypingTestConfig, language: string): TypingTestState {
  const word = state.words[state.currentWordIndex]
  const base: TypingTestState = {
    ...state,
    wordResults: [...state.wordResults, { word, typed: matcher.typedRomaji(), correct: true }],
    currentInput: '',
    romajiKeystrokes: '',
    missedPositions: [],
    currentWordIndex: state.currentWordIndex + 1,
    romajiSegmentErred: false,
  }
  return advanceAfterWord(base, config, language)
}

/** Sequential romaji-keystroke judging (romajiInput mode). Unlike
 *  `handleChar`, correctness is counted per keystroke rather than per word:
 *  an accepted keystroke (including the one that completes a kana segment)
 *  is a correct char, a rejected one is an incorrect char and leaves the
 *  matcher's position untouched (nothing is appended to currentInput or
 *  the keystroke buffer). Completing the whole word auto-advances via
 *  `commitRomajiWord` — UNLESS the current word is a LINE-END word
 *  (`state.lineBreaks`, real lines from tatoeba/fileImport): that word
 *  instead holds (keystrokes still accumulate, so a printable char typed
 *  while held keeps flowing through the matcher normally — see below) until
 *  `processRomajiKeyEvent`'s Enter handler commits it, matching the
 *  non-romaji Enter-at-line-end convention (Task-romaji-line-end-enter).
 *  Space is blocked in this mode regardless (see `processRomajiKeyEvent`),
 *  so there is no separate Space-triggered finalize path to keep in sync
 *  for non-line-end words.
 *
 *  Mistake tracking (romaji mode): a rejected keystroke marks
 *  `romajiSegmentErred` true for the kana segment currently in progress,
 *  without touching `mistakes` itself. Once that segment actually completes
 *  (detected via `completedKanaCount()` advancing across the keystroke),
 *  the flag decides whether to tally one mistake — keyed by the canonical
 *  romaji spelling of the just-completed kana slice — before resetting the
 *  flag for the next segment. This counts one mistake per erred segment
 *  regardless of how many keystrokes inside it were rejected. A reject
 *  while a line-end word is held (the word is already complete, so any
 *  further printable is necessarily a reject) still sets
 *  `romajiSegmentErred` this same way, but `commitRomajiWord` unconditionally
 *  clears it on commit so it can never leak into the next word's tally. */
function handleRomajiChar(state: TypingTestState, char: string, config: TypingTestConfig, language: string): TypingTestState {
  if (state.currentWordIndex >= state.words.length) return state

  const word = state.words[state.currentWordIndex]
  const matcher = buildRomajiMatcher(word, state.romajiKeystrokes, romajiDetail(config))
  const kanaBefore = matcher.completedKanaCount()
  const result = matcher.acceptChar(char)

  if (result === 'reject') {
    return { ...state, incorrectChars: state.incorrectChars + 1, romajiSegmentErred: true }
  }

  const correctChars = state.correctChars + 1
  // One accepted keystroke confirms exactly one character in this mode
  // (see `TypingTestState.confirmedChars`) — rejects (handled above)
  // don't advance it.
  const confirmedChars = state.confirmedChars + 1
  const kanaAfter = matcher.completedKanaCount()

  let mistakes = state.mistakes
  let romajiSegmentErred = state.romajiSegmentErred
  if (kanaAfter > kanaBefore) {
    if (romajiSegmentErred) {
      const key = canonicalRomaji(word.slice(kanaBefore, kanaAfter))
      mistakes = { ...mistakes, [key]: (mistakes[key] ?? 0) + 1 }
    }
    romajiSegmentErred = false
  }

  const held: TypingTestState = {
    ...state,
    romajiKeystrokes: state.romajiKeystrokes + char,
    correctChars,
    confirmedChars,
    mistakes,
    romajiSegmentErred,
  }

  if (result === 'complete' && matcher.isComplete()) {
    if (state.lineBreaks.has(state.currentWordIndex)) return held
    return commitRomajiWord(held, matcher, config, language)
  }

  return held
}

/** Full-run per-word canonical romaji table (romajiInput mode only),
 *  unbounded and index-aligned with `state.words` — the source `words`
 *  field of the guide `TypingTestView` line-synchronizes against the
 *  reading window's own line structure (see `RomajiGuide`'s doc comment).
 *  Deliberately split out from `buildRomajiGuideProgress` below: building
 *  this table runs a full `RomajiMatcher` over every word in the run
 *  (O(n) in word count), so it must only rebuild when the run's word list
 *  itself changes (fresh run / time-mode refill) — never on every
 *  keystroke. `useTypingTest` memoizes this separately from the
 *  keystroke-reactive half for exactly that reason (dependency set is
 *  `[state.words, ...]`, deliberately NOT `state.romajiKeystrokes`).
 *  Returns null once romaji judging isn't active for this config/language. */
export function buildRomajiWordsTable(config: TypingTestConfig, language: string, state: TypingTestState): string[] | null {
  if (!isRomajiInputActive(config, language, state.romajiCapable)) return null
  const detail = romajiDetail(config)
  return state.words.map((w) => buildRomajiMatcher(w, '', detail).remainingGuide())
}

/** Current word's romaji progress (romajiInput mode only), re-derived from
 *  the accepted keystroke history on every call rather than stored on
 *  state directly — see `buildRomajiMatcher`. `lineCount` is the total
 *  number of guide lines to show (`RomajiDetailSettings.guideLineCount`,
 *  default 2); `showRow` is false only at count 0 — kanaCompleted (for
 *  WordDisplay's coloring) is always computed regardless, since it must
 *  keep working even when the row itself is hidden. Returns null once
 *  romaji judging isn't active for this config/language, or the run has no
 *  current word left. Pure, and deliberately excludes the `words` table
 *  (see `buildRomajiWordsTable`) — the caller (`useTypingTest`) composes
 *  the two into a full `RomajiGuide` and applies `applyRomajiCaseStyle`
 *  once over the merged object. */
export function buildRomajiGuideProgress(config: TypingTestConfig, language: string, state: TypingTestState): Omit<RomajiGuide, 'words'> | null {
  if (!isRomajiInputActive(config, language, state.romajiCapable)) return null
  if (state.currentWordIndex >= state.words.length) return null
  const word = state.words[state.currentWordIndex]
  const detail = romajiDetail(config)
  const matcher = buildRomajiMatcher(word, state.romajiKeystrokes, detail)
  const lineCount = detail?.guideLineCount ?? 2
  return {
    typed: matcher.typedRomaji(),
    remaining: matcher.remainingGuide(),
    kanaCompleted: matcher.completedKanaCount(),
    lineCount,
    showRow: lineCount > 0,
  }
}
