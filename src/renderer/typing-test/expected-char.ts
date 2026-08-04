// SPDX-License-Identifier: GPL-2.0-or-later

/** Derives the character a matrix press registered right now should
 *  confirm, for both verbatim and romaji-keystroke judging. Lives in the
 *  typing-test engine layer (not run-log-recorder.ts, which is a
 *  feature built on top of this engine): useTypingTest itself calls this
 *  at registration time, so the engine must not depend on the
 *  run-keystroke-log feature module — see run-log-recorder.ts's own doc
 *  comment for the consumer this exists to serve. */

import { isRomajiInputActive, romajiNextExpectedChar, currentRomajiMistakeKey, romajiDetail } from './romaji-input'
import type { TypingTestConfig } from './types'
import type { TypingTestState } from './run-state'

/** Returns undefined once the run has no current word (defensive; the
 *  caller never registers past the last word) or, in romaji mode, once
 *  the current word's kana are already fully matched. */
export function deriveExpectedChar(state: TypingTestState, config: TypingTestConfig, language: string): string | undefined {
  const word = state.words[state.currentWordIndex]
  if (word === undefined) return undefined
  if (isRomajiInputActive(config, language, state.romajiCapable)) {
    return romajiNextExpectedChar(word, state.romajiKeystrokes, romajiDetail(config))
  }
  return word[state.currentInput.length]
}

/** The key an INCORRECT keystroke made right now should be tallied under
 *  in the run's own `mistakes` map (see run-state.ts's
 *  `applyWordMistakes`/`handleBackspace` for verbatim mode,
 *  `handleRomajiChar` for romaji) — threaded into `RunKeystroke.mistakeKey`
 *  by run-log-recorder.ts alongside `expectedChar`, so a completion
 *  screen's Missed chip can show which characters were actually typed for
 *  it (see `buildMissedDetails`, missed-details.ts). Mirrors
 *  `deriveExpectedChar`'s branch structure but is NOT the same value in
 *  romaji mode: `deriveExpectedChar`'s romaji branch is a single next
 *  romaji character, while a mistake tallies against the whole kana
 *  SEGMENT (e.g. "kya") regardless of which of its keystrokes was
 *  rejected — see `currentRomajiMistakeKey`'s own best-effort caveat.
 *  Verbatim mode has no such distinction: the position's own target char
 *  IS its own mistake key, identical to `deriveExpectedChar`. */
export function deriveMistakeKey(state: TypingTestState, config: TypingTestConfig, language: string): string | undefined {
  const word = state.words[state.currentWordIndex]
  if (word === undefined) return undefined
  if (isRomajiInputActive(config, language, state.romajiCapable)) {
    return currentRomajiMistakeKey(word, state.romajiKeystrokes, romajiDetail(config))
  }
  return word[state.currentInput.length]
}
