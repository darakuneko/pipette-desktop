// SPDX-License-Identifier: GPL-2.0-or-later

/** Romaji-mode key semantics: the guard for whether romaji judging is
 *  active for the current config/language, matcher construction/replay,
 *  and the key-event handler that dispatches into it. */

import { createRomajiMatcher, type RomajiMatcher, type RomajiMatcherOptions } from './romaji-engine'
import type { TypingTestConfig, RomajiDetailSettings } from './types'
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
 *  `isRomajiInputActive`, to decide whether a persisted `romajiInput: true`
 *  is actually honored. */
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

/** True when the config opts into sequential romaji-keystroke judging AND
 *  the mode/content combination is actually capable of it (see
 *  `isRomajiCapable`). `romajiInput` is persisted as-is regardless of
 *  capability — same as `punctuation`/`numbers` on words/time — and is
 *  simply not honored while its mode isn't currently capable (a non-kana
 *  language for words/time/tatoeba, or a non-kana-pure text for
 *  fileImport). This keeps the flag intact across any config/language/text
 *  sync order (e.g. a persisted config landing before the persisted
 *  language on mount), and it comes back into effect automatically once a
 *  capable language/text is selected again, without the user needing to
 *  re-toggle it. `config.mode === 'quote'` is checked first (rather than
 *  folded into `isRomajiCapable`'s boolean result) so the compiler can
 *  narrow `config` to the branches that actually carry `romajiInput`. */
export function isRomajiInputActive(config: TypingTestConfig, language: string, textRomajiCapable: boolean | undefined): boolean {
  if (config.mode === 'quote') return false
  return config.romajiInput === true && isRomajiCapable(config, language, textRomajiCapable)
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
 *  kind. Submit keys (Space/Enter) and Backspace are no-ops in this mode —
 *  romaji mode auto-advances on completion and rejected keystrokes never
 *  entered the buffer, so there is nothing to submit or undo (see
 *  `handleRomajiChar`). A printable character starts the run from
 *  'waiting' before being fed to the matcher; every other key (multi-char
 *  names like Shift/Control) passes through untouched, matching the
 *  non-romaji fallback. IME composition input is gated separately in
 *  `processCompositionEnd`, not here. */
export function processRomajiKeyEvent(state: TypingTestState, key: string, config: TypingTestConfig, language: string): TypingTestState {
  if (isSubmitKey(key) || key === 'Enter') return state
  if (key === 'Backspace') return state
  if (key.length === 1) {
    const current = state.status === 'waiting' ? { ...state, status: 'running' as const, startTime: Date.now() } : state
    return handleRomajiChar(current, key, config, language)
  }
  return state
}

/** Sequential romaji-keystroke judging (romajiInput mode). Unlike
 *  `handleChar`, correctness is counted per keystroke rather than per word:
 *  an accepted keystroke (including the one that completes a kana segment)
 *  is a correct char, a rejected one is an incorrect char and leaves the
 *  matcher's position untouched (nothing is appended to currentInput or
 *  the keystroke buffer). Completing the whole word auto-advances — the
 *  submit key is blocked in this mode (see `processKeyEvent`), so there is
 *  no separate Space-triggered finalize path to keep in sync. */
function handleRomajiChar(state: TypingTestState, char: string, config: TypingTestConfig, language: string): TypingTestState {
  if (state.currentWordIndex >= state.words.length) return state

  const word = state.words[state.currentWordIndex]
  const matcher = buildRomajiMatcher(word, state.romajiKeystrokes, romajiDetail(config))
  const result = matcher.acceptChar(char)

  if (result === 'reject') {
    return { ...state, incorrectChars: state.incorrectChars + 1 }
  }

  const correctChars = state.correctChars + 1

  if (result === 'complete' && matcher.isComplete()) {
    const base: TypingTestState = {
      ...state,
      currentWordIndex: state.currentWordIndex + 1,
      currentInput: '',
      romajiKeystrokes: '',
      wordResults: [...state.wordResults, { word, typed: matcher.typedRomaji(), correct: true }],
      correctChars,
    }
    return advanceAfterWord(base, config, language)
  }

  return { ...state, romajiKeystrokes: state.romajiKeystrokes + char, correctChars }
}
