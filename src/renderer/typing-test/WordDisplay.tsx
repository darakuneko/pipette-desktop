// SPDX-License-Identifier: GPL-2.0-or-later

import type { WordResult } from './useTypingTest'

const COMPOSITION_CHAR_CLASS = 'text-accent/60 underline decoration-accent/30'

interface WordDisplayProps {
  word: string
  wordIndex: number
  currentWordIndex: number
  currentInput: string
  wordResults: WordResult[]
  cursorBlink: boolean
  compositionText?: string
}

export function WordDisplay({ word, wordIndex, currentWordIndex, currentInput, wordResults, cursorBlink, compositionText = '' }: WordDisplayProps) {
  const testId = `word-${wordIndex}`

  // Completed word — per-character coloring
  if (wordIndex < currentWordIndex) {
    const result = wordResults[wordIndex]
    if (!result) return null
    if (result.correct) {
      return (
        <span data-testid={testId} className="text-success">
          {word}
        </span>
      )
    }
    return (
      <span data-testid={testId}>
        {word.split('').map((char, charIdx) => (
          <span key={charIdx} className={charClassName(char, charIdx, result.typed)}>
            {displayChar(char, charIdx, result.typed)}
          </span>
        ))}
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
      <span data-testid={testId}>
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
              <span key={`extra-${i}`} className="text-danger underline decoration-danger/50 decoration-2 underline-offset-[3px]">
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
    <span data-testid={testId} className="text-content-muted">
      {word}
    </span>
  )
}

function charClassName(expected: string, index: number, input: string): string {
  if (index >= input.length) return 'text-content-muted'
  if (input[index] === expected) return 'text-success'
  return 'text-danger underline decoration-danger/50 decoration-2 underline-offset-[3px]'
}

function displayChar(expected: string, index: number, input: string): string {
  if (index < input.length && input[index] !== expected) return input[index]
  return expected
}

function Cursor({ blink }: { blink: boolean }) {
  return (
    <span
      className={`absolute left-0 bottom-[0.12em] h-[1.1em] w-0.5 rounded-full bg-accent${blink ? ' animate-blink' : ''}`}
      aria-hidden="true"
    />
  )
}
