// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { WordDisplay } from '../WordDisplay'
import type { WordResult } from '../useTypingTest'

function renderWord(props: Partial<Parameters<typeof WordDisplay>[0]> = {}) {
  const defaults = {
    word: 'でぃなー',
    wordIndex: 0,
    currentWordIndex: 0,
    currentInput: '',
    wordResults: [] as WordResult[],
    cursorBlink: false,
  }
  return render(<WordDisplay {...defaults} {...props} />)
}

describe('WordDisplay romaji mode', () => {
  it('colors kana characters as success up through kanaCompleted', () => {
    renderWord({ guideProgress: { kanaCompleted: 1 } })
    const word = screen.getByTestId('word-0')
    // First char (で) confirmed -> success; the rest stay muted.
    const successSpans = word.querySelectorAll('.text-success')
    expect(successSpans.length).toBe(1)
    expect(successSpans[0].textContent).toBe('で')
    expect(word.textContent).toBe('でぃなー')
  })

  it('shows every kana as muted before any keystroke is confirmed', () => {
    renderWord({ guideProgress: { kanaCompleted: 0 } })
    const word = screen.getByTestId('word-0')
    expect(word.querySelector('.text-success')).toBeNull()
  })

  it('colors the full word as success once every kana is confirmed', () => {
    renderWord({ word: 'あい', guideProgress: { kanaCompleted: 2 } })
    const word = screen.getByTestId('word-0')
    const successSpans = word.querySelectorAll('.text-success')
    expect(successSpans.length).toBe(2)
  })

  it('renders no per-character error color even mid-word', () => {
    // Romaji mode never shows a red/danger char — rejected keystrokes leave
    // no trace, so only success/muted classes should ever appear.
    renderWord({ word: 'かんじ', guideProgress: { kanaCompleted: 1 } })
    const word = screen.getByTestId('word-0')
    expect(word.querySelector('.text-danger')).toBeNull()
  })

  it('does not apply romaji coloring to a word that is not the current word', () => {
    renderWord({
      word: 'ねこ',
      wordIndex: 1,
      currentWordIndex: 0,
      guideProgress: { kanaCompleted: 1 },
    })
    const word = screen.getByTestId('word-1')
    // Future word — plain muted styling, unaffected by a guide meant for
    // a different word index.
    expect(word.className).toContain('text-content-muted')
  })

  it('falls back to the normal currentInput-driven rendering when guideProgress is absent', () => {
    renderWord({ word: 'hello', currentInput: 'he' })
    const word = screen.getByTestId('word-0')
    expect(word.textContent).toBe('hello')
  })
})
