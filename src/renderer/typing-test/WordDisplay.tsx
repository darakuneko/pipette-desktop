// SPDX-License-Identifier: GPL-2.0-or-later

import type { WordResult } from './useTypingTest'
import type { RomajiGuide } from './types'

const COMPOSITION_CHAR_CLASS = 'text-accent/60 underline decoration-accent/30'
const ERROR_CHAR_CLASS = 'text-danger underline decoration-danger/50 decoration-2 underline-offset-2'

interface WordDisplayProps {
  word: string
  wordIndex: number
  currentWordIndex: number
  currentInput: string
  wordResults: WordResult[]
  cursorBlink: boolean
  compositionText?: string
  /** Romaji-keystroke progress for this word (romajiInput mode only), or
   *  null/undefined for every other word and every other mode. When set,
   *  the current word's confirmed input is derived as `word.slice(0,
   *  kanaCompleted)` instead of using `currentInput` directly — romaji mode
   *  never writes to `currentInput` (see `handleRomajiChar`), and composition
   *  is treated as empty even if the OS IME fired a stray composition event
   *  (rejected keystrokes never appear anywhere, so there is no per-char
   *  error color either). */
  romajiGuide?: RomajiGuide | null
}

export function WordDisplay({ word, wordIndex, currentWordIndex, currentInput, wordResults, cursorBlink, compositionText = '', romajiGuide = null }: WordDisplayProps) {
  const testId = `word-${wordIndex}`

  // Completed word — per-character coloring
  if (wordIndex < currentWordIndex) {
    const result = wordResults[wordIndex]
    if (!result) return null
    if (result.correct) {
      return (
        <span data-testid={testId} className="min-w-0 break-all text-success">
          {word}
        </span>
      )
    }
    return (
      <span data-testid={testId} className="min-w-0 break-all">
        {word.split('').map((char, charIdx) => (
          <span key={charIdx} className={charClassName(char, charIdx, result.typed)}>
            {displayChar(char, charIdx, result.typed)}
          </span>
        ))}
      </span>
    )
  }

  // Current word -- per-character coloring with cursor and composition text.
  // Romaji input mode reuses this same rendering rather than a parallel
  // implementation: its confirmed input is exactly `word.slice(0,
  // kanaCompleted)` (a committed segment always matches the kana it
  // replaces one-for-one here), and composition is forced empty since
  // romaji mode never feeds composition data into currentInput (see
  // `processCompositionEnd`'s composition gate in useTypingTest) — so there
  // is nothing to show and no per-char error color either, matching the
  // dedicated romaji branch this replaced.
  if (wordIndex === currentWordIndex) {
    const effectiveInput = romajiGuide ? word.slice(0, romajiGuide.kanaCompleted) : currentInput
    const effectiveComposition = romajiGuide ? '' : compositionText
    const typedLength = effectiveInput.length
    const compositionChars = Array.from(effectiveComposition)
    const compositionLength = compositionChars.length
    const isComposing = compositionLength > 0
    const cursorBlinks = !isComposing && cursorBlink
    return (
      <span data-testid={testId} className="min-w-0 break-all">
        {word.split('').map((char, charIdx) => {
          // Already typed characters
          if (charIdx < typedLength) {
            return (
              <span key={charIdx} className={charClassName(char, charIdx, effectiveInput)}>
                {displayChar(char, charIdx, effectiveInput)}
              </span>
            )
          }
          // Cursor at the typed/composition boundary
          if (charIdx === typedLength) {
            if (isComposing) {
              // Composition text overlay
              return (
                <span key={charIdx} className="relative">
                  <Cursor blink={false} />
                  <span className={COMPOSITION_CHAR_CLASS}>
                    {compositionChars[charIdx - typedLength]}
                  </span>
                </span>
              )
            }
            // First untyped character with cursor
            return (
              <span key={charIdx} className="relative">
                <Cursor blink={cursorBlinks} />
                <span className={charClassName(char, charIdx, effectiveInput)}>
                  {displayChar(char, charIdx, effectiveInput)}
                </span>
              </span>
            )
          }
          // Remaining composition characters (after the first)
          if (charIdx < typedLength + compositionLength) {
            return (
              <span key={charIdx} className={COMPOSITION_CHAR_CLASS}>
                {compositionChars[charIdx - typedLength]}
              </span>
            )
          }
          // Remaining untyped characters
          return (
            <span key={charIdx} className={charClassName(char, charIdx, effectiveInput)}>
              {displayChar(char, charIdx, effectiveInput)}
            </span>
          )
        })}
        {/* Extra composition chars beyond word length */}
        {typedLength + compositionLength > word.length &&
          compositionChars
            .slice(Math.max(0, word.length - typedLength))
            .map((char, i) => (
              <span key={`comp-extra-${i}`} className={COMPOSITION_CHAR_CLASS}>
                {char}
              </span>
            ))}
        {/* Extra typed chars beyond word length */}
        {typedLength > word.length &&
          effectiveInput
            .slice(word.length)
            .split('')
            .map((char, i) => (
              <span key={`extra-${i}`} className={ERROR_CHAR_CLASS}>
                {char}
              </span>
            ))}
        {/* Cursor after the word when typed/composed past the end */}
        {typedLength >= word.length && (
          <span className="relative">
            <Cursor blink={cursorBlinks} />
          </span>
        )}
      </span>
    )
  }

  // Future word
  return (
    <span data-testid={testId} className="min-w-0 break-all text-content-muted">
      {word}
    </span>
  )
}

function charClassName(expected: string, index: number, input: string): string {
  if (index >= input.length) return 'text-content-muted'
  if (input[index] === expected) return 'text-success'
  return ERROR_CHAR_CLASS
}

function displayChar(expected: string, index: number, input: string): string {
  if (index < input.length && input[index] !== expected) return input[index]
  return expected
}

function Cursor({ blink }: { blink: boolean }) {
  return (
    <span
      className={`absolute left-0 bottom-cursor h-cursor w-0.5 rounded-full bg-accent${blink ? ' animate-blink' : ''}`}
      aria-hidden="true"
    />
  )
}
