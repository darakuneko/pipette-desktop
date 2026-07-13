// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { TypingTestView } from '../TypingTestView'
import type { TypingTestState } from '../useTypingTest'
import type { TypingTestConfig } from '../types'
import { DEFAULT_CONFIG } from '../types'

function makeState(overrides: Partial<TypingTestState> = {}): TypingTestState {
  return {
    status: 'waiting',
    words: ['the', 'quick', 'brown'],
    currentWordIndex: 0,
    currentInput: '',
    compositionText: '',
    wordResults: [],
    startTime: null,
    endTime: null,
    correctChars: 0,
    incorrectChars: 0,
    currentQuote: null,
    wpmHistory: [],
    lineBreaks: new Set(),
    lineIndents: [],
    ...overrides,
  }
}

function renderView(props: Partial<Parameters<typeof TypingTestView>[0]> = {}) {
  const defaults = {
    state: makeState(),
    wpm: 0,
    accuracy: 100,
    elapsedSeconds: 0,
    remainingSeconds: null as number | null,
    config: DEFAULT_CONFIG,
    paused: false,
  }
  return render(
    <I18nextProvider i18n={i18n}>
      <TypingTestView {...defaults} {...props} />
    </I18nextProvider>,
  )
}

describe('TypingTestView', () => {
  it('renders the view container', () => {
    renderView()
    expect(screen.getByTestId('typing-test-view')).toBeInTheDocument()
  })

  it('shows the stats row with "-" placeholders before measuring', () => {
    // Stats bar is always present (no collapsing/layout shift); before a run
    // is measured (waiting/countdown) every metric reads "-".
    renderView({ state: makeState({ status: 'waiting', words: ['hello', 'world'] }) })
    expect(screen.getByTestId('typing-test-wpm').textContent).toBe('-')
    expect(screen.getByTestId('typing-test-kpm').textContent).toBe('-')
    expect(screen.getByTestId('typing-test-accuracy').textContent).toBe('-')
    expect(screen.getByTestId('typing-test-time').textContent).toBe('-')
    expect(screen.getByTestId('typing-test-word-count').textContent).toBe('-')
  })

  it('cursor blinks in waiting state', () => {
    renderView({ state: makeState({ status: 'waiting', words: ['hello'] }) })
    const word0 = screen.getByTestId('word-0')
    const cursor = word0.querySelector('[aria-hidden="true"]')
    expect(cursor).not.toBeNull()
    expect(cursor!.className).toContain('animate-blink')
  })

  it('cursor does not blink in running state', () => {
    renderView({ state: makeState({ status: 'running', words: ['hello'], currentInput: 'h' }) })
    const word0 = screen.getByTestId('word-0')
    const cursor = word0.querySelector('[aria-hidden="true"]')
    expect(cursor).not.toBeNull()
    expect(cursor!.className).not.toContain('animate-blink')
  })

  it('word container has a var-driven fixed-height window to prevent layout shift', () => {
    renderView({ state: makeState({ status: 'waiting' }) })
    const wordsContainer = screen.getByTestId('typing-test-words')
    // All modes use the var-driven window (font/line settings are shared).
    expect(wordsContainer.className).toContain('typing-multiline-window')
  })

  it('displays word elements when running', () => {
    renderView({
      state: makeState({
        status: 'running',
        words: ['hello', 'world'],
        currentWordIndex: 0,
        currentInput: 'hel',
      }),
    })
    expect(screen.getByTestId('word-0')).toBeInTheDocument()
    expect(screen.getByTestId('word-1')).toBeInTheDocument()
  })

  it('applies success styling to correct completed words', () => {
    renderView({
      state: makeState({
        status: 'running',
        words: ['the', 'quick', 'brown'],
        currentWordIndex: 2,
        currentInput: '',
        wordResults: [
          { word: 'the', typed: 'the', correct: true },
          { word: 'quick', typed: 'quikc', correct: false },
        ],
      }),
    })
    const word0 = screen.getByTestId('word-0')
    expect(word0.className).toContain('text-success')
  })

  it('applies per-character coloring to incorrect completed words', () => {
    renderView({
      state: makeState({
        status: 'running',
        words: ['quick'],
        currentWordIndex: 1,
        currentInput: '',
        wordResults: [
          { word: 'quick', typed: 'quikc', correct: false },
        ],
      }),
    })
    const word0 = screen.getByTestId('word-0')
    const chars = word0.querySelectorAll('span')
    // q, u, i correct; c wrong (typed 'k'); k wrong (typed 'c')
    expect(chars[0].className).toContain('text-success')
    expect(chars[1].className).toContain('text-success')
    expect(chars[2].className).toContain('text-success')
    expect(chars[3].className).toContain('text-danger')
    expect(chars[4].className).toContain('text-danger')
    // mistyped chars show what was actually typed, not the expected char
    expect(word0.textContent).toBe('quikc')
  })

  it('displays typed characters for mistyped positions in completed words', () => {
    renderView({
      state: makeState({
        status: 'running',
        words: ['save', 'next'],
        currentWordIndex: 2,
        currentInput: '',
        wordResults: [
          { word: 'save', typed: 'seve', correct: false },
          { word: 'next', typed: 'next', correct: true },
        ],
      }),
    })
    const word0 = screen.getByTestId('word-0')
    expect(word0.textContent).toBe('seve')
  })

  it('displays typed characters for mistyped positions in current word', () => {
    renderView({
      state: makeState({
        status: 'running',
        words: ['save'],
        currentWordIndex: 0,
        currentInput: 'seve',
      }),
    })
    const word0 = screen.getByTestId('word-0')
    expect(word0.textContent).toBe('seve')
  })

  it('shows expected characters for untyped positions in current word', () => {
    renderView({
      state: makeState({
        status: 'running',
        words: ['hello'],
        currentWordIndex: 0,
        currentInput: 'he',
      }),
    })
    const word0 = screen.getByTestId('word-0')
    // 'h','e' typed correctly, 'l','l','o' not yet typed — show expected
    expect(word0.textContent).toBe('hello')
  })

  it('displays WPM and accuracy when running', () => {
    renderView({
      state: makeState({ status: 'running', correctChars: 10 }),
      wpm: 65,
      accuracy: 97,
      elapsedSeconds: 23,
    })
    expect(screen.getByTestId('typing-test-wpm').textContent).toBe('65')
    expect(screen.getByTestId('typing-test-accuracy').textContent).toBe('97%')
    expect(screen.getByTestId('typing-test-time').textContent).toBe('0:23')
  })

  it('shows the results panel when finished', () => {
    renderView({
      state: makeState({ status: 'finished' }),
      wpm: 70,
      accuracy: 95,
    })
    expect(screen.getByTestId('typing-test-results')).toBeInTheDocument()
  })

  it('displays current/total word count progress', () => {
    renderView({
      state: makeState({
        status: 'running',
        words: ['a', 'b', 'c'],
        currentWordIndex: 1,
      }),
    })
    expect(screen.getByTestId('typing-test-word-count').textContent).toBe('1 / 3')
  })

  it('renders a cursor element within the current word without affecting text content', () => {
    renderView({
      state: makeState({
        status: 'running',
        words: ['hello'],
        currentWordIndex: 0,
        currentInput: 'he',
      }),
    })
    const word = screen.getByTestId('word-0')
    const cursor = word.querySelector('[aria-hidden="true"]')
    expect(cursor).not.toBeNull()
    expect(word.textContent).toBe('hello')
  })
})

describe('TypingTestView measurement toggle (hideStatsRow)', () => {
  it('shows the live measurement row during a run when measurement is on', () => {
    renderView({ hideStatsRow: false, state: makeState({ status: 'running', words: ['a'] }) })
    expect(screen.getByTestId('typing-test-results')).toBeInTheDocument()
  })

  it('hides the live measurement row during a run when measurement is off', () => {
    renderView({ hideStatsRow: true, state: makeState({ status: 'running', words: ['a'] }) })
    expect(screen.queryByTestId('typing-test-results')).toBeNull()
  })

  it('always shows the results when finished, even with measurement off', () => {
    // The toggle only hides the in-run live metrics — finished results are absolute.
    renderView({ hideStatsRow: true, state: makeState({ status: 'finished' }), wpm: 70, accuracy: 95 })
    expect(screen.getByTestId('typing-test-results')).toBeInTheDocument()
  })
})

describe('TypingTestView time mode display', () => {
  it('shows remaining time in time mode', () => {
    const config: TypingTestConfig = { mode: 'time', duration: 30, punctuation: false, numbers: false }
    renderView({
      config,
      remainingSeconds: 25,
      state: makeState({ status: 'running' }),
    })
    expect(screen.getByTestId('typing-test-time').textContent).toBe('0:25')
  })
})

describe('TypingTestView quote mode display', () => {
  it('shows quote source in finished state', () => {
    const config: TypingTestConfig = { mode: 'quote', quoteLength: 'short' }
    renderView({
      config,
      state: makeState({
        status: 'finished',
        currentQuote: { id: 1, text: 'test quote', source: 'Test Book', length: 10 },
      }),
      wpm: 50,
      accuracy: 95,
    })
    expect(screen.getByTestId('typing-test-results')).toBeInTheDocument()
    expect(screen.getByTestId('typing-test-quote-source').textContent).toContain('Test Book')
  })
})

describe('TypingTestView controls row (state-based)', () => {
  const fileImportConfig: TypingTestConfig = { mode: 'fileImport', textId: 'abc' }

  it('shows Next Test (not Restart) before a run starts', () => {
    renderView({ config: fileImportConfig, state: makeState({ status: 'waiting' }) })
    expect(screen.getByTestId('typing-test-start')).toBeInTheDocument()
    expect(screen.queryByTestId('typing-test-restart')).toBeNull()
  })

  it('shows Pause + Restart while running (fileImport)', () => {
    renderView({ config: fileImportConfig, state: makeState({ status: 'running' }) })
    expect(screen.getByTestId('typing-memory-pause')).toBeInTheDocument()
    expect(screen.getByTestId('typing-test-restart')).toBeInTheDocument()
  })

  it('shows Resume + Restart while paused (fileImport)', () => {
    renderView({ config: fileImportConfig, state: makeState({ status: 'paused' }) })
    expect(screen.getByTestId('typing-memory-resume')).toBeInTheDocument()
    expect(screen.getByTestId('typing-test-restart')).toBeInTheDocument()
  })

  it('shows Resume in the waiting state when a fileImport run is saved', () => {
    renderView({ config: fileImportConfig, state: makeState({ status: 'waiting' }), hasSavedMemory: true })
    expect(screen.getByTestId('typing-memory-resume')).toBeInTheDocument()
  })

  it('shows the result name field on finish for normal modes too', () => {
    const wordsConfig: TypingTestConfig = { mode: 'words', wordCount: 30, punctuation: false, numbers: false }
    renderView({ config: wordsConfig, state: makeState({ status: 'finished' }) })
    expect(screen.getByTestId('typing-test-result-name')).toBeInTheDocument()
  })

  it('shows the Complete message on the finished screen', () => {
    renderView({ config: fileImportConfig, state: makeState({ status: 'finished' }) })
    expect(screen.getByTestId('typing-test-complete')).toBeInTheDocument()
  })

  it('hides the Complete message while running', () => {
    renderView({ config: fileImportConfig, state: makeState({ status: 'running' }) })
    expect(screen.queryByTestId('typing-test-complete')).toBeNull()
  })

  it('never shows Resume on the finished screen, even with a saved memory', () => {
    renderView({ config: fileImportConfig, state: makeState({ status: 'finished' }), hasSavedMemory: true })
    expect(screen.queryByTestId('typing-memory-resume')).toBeNull()
    expect(screen.getByTestId('typing-test-result-name')).toBeInTheDocument()
    expect(screen.getByTestId('typing-test-start')).toBeInTheDocument()
  })
})

describe('TypingTestView fileImport mode result naming', () => {
  const fileImportConfig: TypingTestConfig = { mode: 'fileImport', textId: 'abc' }

  it('shows an inline name field (placeholder Unnamed) instead of the quote source', () => {
    renderView({
      config: fileImportConfig,
      state: makeState({ status: 'finished', currentQuote: { id: 1, text: 'x', source: 'code', length: 1 } }),
    })
    expect(screen.queryByTestId('typing-test-quote-source')).toBeNull()
    const field = screen.getByTestId('typing-test-result-name')
    expect(field.textContent).toBe('Unnamed')
  })

  it('shows both WPM and KPM in fileImport mode', () => {
    renderView({
      config: fileImportConfig,
      state: makeState({ status: 'running' }),
      wpm: 24,
      kpm: 120,
    })
    expect(screen.getByTestId('typing-test-wpm').textContent).toBe('24')
    expect(screen.getByTestId('typing-test-kpm').textContent).toBe('120')
  })

  it('preserves leading indentation per line (display only)', () => {
    renderView({
      config: fileImportConfig,
      state: makeState({
        status: 'running',
        words: ['def', 'x'],
        lineBreaks: new Set([0]),
        lineIndents: ['', '  '],
      }),
    })
    // First line has no indent; second line keeps its two-space indent.
    expect(screen.queryByTestId('line-indent-0')).toBeNull()
    expect(screen.getByTestId('line-indent-1').textContent).toBe('  ')
  })

  it('counts fileImport progress by character, the word gap included', () => {
    // "AAA AA" -> 3 + 2 + 1 separator = 6 characters total.
    renderView({
      config: fileImportConfig,
      state: makeState({ status: 'running', words: ['AAA', 'AA'], currentWordIndex: 1, currentInput: '' }),
    })
    // 1 word done (3 chars) + 1 separator passed = 4 / 6.
    expect(screen.getByTestId('typing-test-word-count').textContent).toBe('4 / 6')
  })

  it('hides the words/time/quote settings bar in fileImport mode', () => {
    renderView({ config: fileImportConfig, state: makeState({ status: 'running' }) })
    expect(screen.queryByTestId('mode-words')).toBeNull()
    expect(screen.queryByTestId('mode-time')).toBeNull()
    expect(screen.queryByTestId('mode-quote')).toBeNull()
  })

  it('names the finished result on commit', () => {
    const onNameResult = vi.fn()
    renderView({
      config: fileImportConfig,
      state: makeState({ status: 'finished' }),
      onNameResult,
    })
    // Click opens the naming modal; type and Save commits.
    fireEvent.click(screen.getByTestId('typing-test-result-name'))
    const input = screen.getByTestId('result-name-modal-input')
    fireEvent.change(input, { target: { value: 'QWERTY baseline' } })
    fireEvent.click(screen.getByTestId('result-name-modal-save'))
    expect(onNameResult).toHaveBeenCalledWith('QWERTY baseline')
  })
})

describe('TypingTestView IME space key', () => {
  it('calls onImeSpaceKey when textarea receives half-width space input while not composing', () => {
    const onImeSpaceKey = vi.fn()
    renderView({
      state: makeState({ status: 'running', currentInput: 'the' }),
      onImeSpaceKey,
    })
    const textarea = screen.getByLabelText('IME input') as HTMLTextAreaElement
    // Simulate IME producing a space in the textarea (e.g. Japanese IME swallows keydown)
    textarea.value = ' '
    fireEvent.input(textarea)
    expect(onImeSpaceKey).toHaveBeenCalledTimes(1)
  })

  it('calls onImeSpaceKey when textarea receives full-width space U+3000 input while not composing', () => {
    const onImeSpaceKey = vi.fn()
    renderView({
      state: makeState({ status: 'running', currentInput: 'the' }),
      onImeSpaceKey,
    })
    const textarea = screen.getByLabelText('IME input') as HTMLTextAreaElement
    textarea.value = '\u3000'
    fireEvent.input(textarea)
    expect(onImeSpaceKey).toHaveBeenCalledTimes(1)
  })

  it('does not call onImeSpaceKey during IME composition', () => {
    const onImeSpaceKey = vi.fn()
    renderView({
      state: makeState({ status: 'running', currentInput: '' }),
      onImeSpaceKey,
    })
    const textarea = screen.getByLabelText('IME input') as HTMLTextAreaElement
    // Start composition
    fireEvent.compositionStart(textarea)
    // Simulate space input during composition
    textarea.value = ' '
    fireEvent.input(textarea)
    expect(onImeSpaceKey).not.toHaveBeenCalled()
  })

  it('does not call onImeSpaceKey for non-space input', () => {
    const onImeSpaceKey = vi.fn()
    renderView({
      state: makeState({ status: 'running', currentInput: '' }),
      onImeSpaceKey,
    })
    const textarea = screen.getByLabelText('IME input') as HTMLTextAreaElement
    textarea.value = 'a'
    fireEvent.input(textarea)
    expect(onImeSpaceKey).not.toHaveBeenCalled()
  })
})

describe('TypingTestView romaji guide', () => {
  it('does not render the guide row when romajiGuide is null', () => {
    renderView({ state: makeState({ status: 'running', words: ['あい'] }) })
    expect(screen.queryByTestId('typing-test-romaji-guide')).toBeNull()
  })

  it('renders typed and remaining romaji, and rewrites on prop changes', () => {
    const { rerender } = renderView({
      state: makeState({ status: 'running', words: ['あい'] }),
      romajiGuide: { typed: '', remaining: 'ai', kanaCompleted: 0 },
    })
    let guide = screen.getByTestId('typing-test-romaji-guide')
    expect(guide.textContent).toBe('ai')

    rerender(
      <I18nextProvider i18n={i18n}>
        <TypingTestView
          state={makeState({ status: 'running', words: ['あい'] })}
          wpm={0}
          accuracy={100}
          elapsedSeconds={0}
          remainingSeconds={null}
          config={DEFAULT_CONFIG}
          paused={false}
          romajiGuide={{ typed: 'a', remaining: 'i', kanaCompleted: 1 }}
        />
      </I18nextProvider>,
    )
    guide = screen.getByTestId('typing-test-romaji-guide')
    expect(guide.textContent).toBe('ai')
    expect(guide.querySelector('.text-success')?.textContent).toBe('a')
    expect(guide.querySelector('.text-content-muted')?.textContent).toBe('i')
  })

  it('shows the IME hint once a composition event fires in romaji mode', () => {
    renderView({
      state: makeState({ status: 'running', words: ['あい'] }),
      romajiGuide: { typed: '', remaining: 'ai', kanaCompleted: 0 },
    })
    expect(screen.queryByTestId('typing-test-romaji-ime-hint')).toBeNull()
    const textarea = screen.getByLabelText('IME input') as HTMLTextAreaElement
    fireEvent.compositionStart(textarea)
    expect(screen.getByTestId('typing-test-romaji-ime-hint')).toBeInTheDocument()
  })

  it('does not show the IME hint outside romaji mode', () => {
    renderView({ state: makeState({ status: 'running', words: ['hello'] }) })
    const textarea = screen.getByLabelText('IME input') as HTMLTextAreaElement
    fireEvent.compositionStart(textarea)
    expect(screen.queryByTestId('typing-test-romaji-ime-hint')).toBeNull()
  })

  it('tracks the Font setting via --tt-font, same as the reading window', () => {
    renderView({
      fontSize: 40,
      state: makeState({ status: 'running', words: ['あい'] }),
      romajiGuide: { typed: '', remaining: 'ai', kanaCompleted: 0 },
    })
    const guide = screen.getByTestId('typing-test-romaji-guide')
    expect(guide.style.getPropertyValue('--tt-font')).toBe('40')
    const typedRemaining = guide.querySelector('.typing-romaji-guide-text')
    expect(typedRemaining).not.toBeNull()
    // The IME hint stays a fixed small size, not tied to --tt-font.
    expect(guide.querySelector('[data-testid="typing-test-romaji-ime-hint"]')).toBeNull()
  })

  it('overrides --tt-font with config.romaji.fontSize, leaving the reading window untouched', () => {
    renderView({
      fontSize: 24,
      config: { mode: 'words', wordCount: 30, punctuation: false, numbers: false, romajiInput: true, romaji: { fontSize: 40 } },
      state: makeState({ status: 'running', words: ['あい'] }),
      romajiGuide: { typed: '', remaining: 'ai', kanaCompleted: 0 },
    })
    const guide = screen.getByTestId('typing-test-romaji-guide')
    expect(guide.style.getPropertyValue('--tt-font')).toBe('40')
    const readingWindow = screen.getByTestId('typing-test-words')
    expect(readingWindow.style.getPropertyValue('--tt-font')).toBe('24')
  })
})

describe('TypingTestView paused overlay', () => {
  it('shows paused overlay when paused and running', () => {
    renderView({
      state: makeState({ status: 'running' }),
      paused: true,
    })
    expect(screen.getByTestId('typing-test-paused')).toBeInTheDocument()
  })

  it('does not show paused overlay when not paused', () => {
    renderView({
      state: makeState({ status: 'running' }),
      paused: false,
    })
    expect(screen.queryByTestId('typing-test-paused')).not.toBeInTheDocument()
  })

  it('does not show paused overlay in waiting state even when paused', () => {
    renderView({
      state: makeState({ status: 'waiting' }),
      paused: true,
    })
    expect(screen.queryByTestId('typing-test-paused')).not.toBeInTheDocument()
  })
})

describe('TypingTestView — imported fileImport text (line breaks)', () => {
  it('renders one row per logical line with ⏎ at line ends, and uses the 4-line window', () => {
    const { container } = renderView({
      state: makeState({
        status: 'running',
        words: ['a', 'b', 'c', 'd'],
        currentInput: '',
        lineBreaks: new Set([1]),
      }),
    })
    // Two logical lines: [a b] / [c d].
    const rows = container.querySelectorAll('[data-line-row]')
    expect(rows).toHaveLength(2)
    // ⏎ marker only after the non-final line.
    expect(container.textContent).toContain('⏎')
    expect(container.querySelectorAll('[data-line-row]')[0].textContent).toContain('⏎')
    expect(container.querySelectorAll('[data-line-row]')[1].textContent).not.toContain('⏎')
    // Imported text uses the var-driven multiline window.
    expect(screen.getByTestId('typing-test-words').className).toContain('typing-multiline-window')
  })

  it('applies font size and line count as CSS vars on the fileImport window', () => {
    renderView({
      displayLines: 6,
      fontSize: 32,
      state: makeState({ status: 'running', words: ['a', 'b', 'c', 'd'], lineBreaks: new Set([1]) }),
    })
    const win = screen.getByTestId('typing-test-words')
    expect(win.style.getPropertyValue('--tt-font')).toBe('32')
    expect(win.style.getPropertyValue('--tt-lines')).toBe('6')
  })

  it('shows character progress (not word/line progress) in the stats bar', () => {
    renderView({
      config: { mode: 'fileImport', textId: 'x' },
      state: makeState({
        status: 'running',
        words: ['a', 'b', 'c', 'd'],
        currentWordIndex: 2,
        lineBreaks: new Set([1]),
      }),
    })
    // total = 4 word chars + 3 separators = 7. Done: 2 words (2 chars) + 2
    // separators passed = 4 → "4 / 7".
    expect(screen.getByTestId('typing-test-word-count').textContent).toBe('4 / 7')
  })

  it('keeps the flat word-flow layout (no line rows) when there are no line breaks', () => {
    const { container } = renderView({
      state: makeState({ status: 'running', words: ['a', 'b'], lineBreaks: new Set() }),
    })
    expect(container.querySelectorAll('[data-line-row]')).toHaveLength(0)
    // Flat word-flow still uses the shared var-driven window (no line rows).
    expect(screen.getByTestId('typing-test-words').className).toContain('typing-multiline-window')
  })
})
