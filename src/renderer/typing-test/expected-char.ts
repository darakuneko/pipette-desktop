// SPDX-License-Identifier: GPL-2.0-or-later

/** Derives the character a matrix press registered right now should
 *  confirm, for both verbatim and romaji-keystroke judging. Lives in the
 *  typing-test engine layer (not run-log-recorder.ts, which is a
 *  feature built on top of this engine): useTypingTest itself calls this
 *  at registration time, so the engine must not depend on the
 *  run-keystroke-log feature module — see run-log-recorder.ts's own doc
 *  comment for the consumer this exists to serve. */

import { isRomajiInputActive, romajiNextExpectedChar, romajiDetail } from './romaji-input'
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
