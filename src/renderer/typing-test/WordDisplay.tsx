// SPDX-License-Identifier: GPL-2.0-or-later

import type { WordResult } from './useTypingTest'

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
   *  the current word renders kana-by-kana success/muted coloring driven by
   *  `kanaCompleted` instead of the usual `currentInput` comparison — romaji
   *  mode never writes to `currentInput` (see `handleRomajiChar`), and
   *  rejected keystrokes never appear anywhere (no per-char error color). */
  romajiGuide?: { typed: string; remaining: string; kanaCompleted: number } | null
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

  // Current word, romaji input mode -- kana colored by confirmed segments
  // rather than by comparing against currentInput (always empty in this
  // mode). No per-char error color: a rejected keystroke never advances the
  // matcher, so there's nothing to mark wrong on the kana itself.
  if (wordIndex === currentWordIndex && romajiGuide) {
    const kanaCompleted = romajiGuide.kanaCompleted
    const kanaClass = (charIdx: number): string => (charIdx < kanaCompleted ? 'text-success' : 'text-content-muted')
    return (
      <span data-testid={testId} className="min-w-0 break-all">
        {word.split('').map((char, charIdx) =>
          charIdx === kanaCompleted ? (
            <span key={charIdx} className="relative">
              <Cursor blink={cursorBlink} />
              <span className={kanaClass(charIdx)}>{char}</span>
            </span>
          ) : (
            <span key={charIdx} className={kanaClass(charIdx)}>{char}</span>
          ),
        )}
        {kanaCompleted >= word.length && (
          <span className="relative">
            <Cursor blink={cursorBlink} />
          </span>
        )}
      </span>
    )
  }

  // Current word -- per-character coloring with cursor and composition text
  if (wordIndex === currentWordIndex) {
    const typedLength = currentInput.length
    const compositionChars = Array.from(compositionText)
    const compositionLength = compositionChars.length
    const isComposing = compositionLength > 0
    const cursorBlinks = !isComposing && cursorBlink
    return (
      <span data-testid={testId} className="min-w-0 break-all">
        {word.split('').map((char, charIdx) => {
          // Already typed characters
          if (charIdx < typedLength) {
            return (
              <span key={charIdx} className={charClassName(char, charIdx, currentInput)}>
                {displayChar(char, charIdx, currentInput)}
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
                <span className={charClassName(char, charIdx, currentInput)}>
                  {displayChar(char, charIdx, currentInput)}
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
            <span key={charIdx} className={charClassName(char, charIdx, currentInput)}>
              {displayChar(char, charIdx, currentInput)}
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
          currentInput
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
