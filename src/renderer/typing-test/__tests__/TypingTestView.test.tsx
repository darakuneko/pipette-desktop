// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { TypingTestView } from '../TypingTestView'
import type { LineSnapshot } from '../TypingTestView'
import type { TypingTestState } from '../useTypingTest'
import type { TypingTestConfig } from '../types'
import { DEFAULT_CONFIG } from '../types'

function makeState(overrides: Partial<TypingTestState> = {}): TypingTestState {
  return {
    status: 'waiting',
    runId: 'test-run',
    words: ['the', 'quick', 'brown'],
    currentWordIndex: 0,
    currentInput: '',
    compositionText: '',
    wordResults: [],
    startTime: null,
    endTime: null,
    correctChars: 0,
    incorrectChars: 0,
    totalKeystrokes: 0,
    confirmedChars: 0,
    kspcUncomputable: false,
    currentQuote: null,
    wpmHistory: [],
    lineBreaks: new Set(),
    lineIndents: [],
    romajiKeystrokes: '',
    romajiCapable: false,
    mistakes: {},
    romajiSegmentErred: false,
    missedPositions: [],
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
    expect(screen.getByTestId('typing-test-kspc').textContent).toBe('-')
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

  it('displays kspc when running', () => {
    renderView({
      state: makeState({ status: 'running' }),
      kspc: 1.234,
    })
    expect(screen.getByTestId('typing-test-kspc').textContent).toBe('1.23')
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

describe('TypingTestView kspc cell', () => {
  it('shows "-" before measuring (waiting/countdown), even if a stale kspc prop is passed', () => {
    renderView({ state: makeState({ status: 'waiting' }), kspc: 1.5 })
    expect(screen.getByTestId('typing-test-kspc').textContent).toBe('-')
  })

  it('shows "-" when kspc is null (uncomputable, or nothing confirmed yet)', () => {
    renderView({ state: makeState({ status: 'running' }), kspc: null })
    expect(screen.getByTestId('typing-test-kspc').textContent).toBe('-')
  })

  it('shows "-" when kspc is omitted entirely (defaults to null)', () => {
    renderView({ state: makeState({ status: 'running' }) })
    expect(screen.getByTestId('typing-test-kspc').textContent).toBe('-')
  })

  it('formats a finished run\'s kspc to 2 decimal places', () => {
    renderView({ state: makeState({ status: 'finished' }), wpm: 50, accuracy: 95, kspc: 1 })
    expect(screen.getByTestId('typing-test-kspc').textContent).toBe('1.00')
  })
})

// Plan-typing-mistake-analysis Phase 1: the completion screen's "missed
// characters" list, sourced from the just-finished run's state.mistakes.
describe('TypingTestView mistakes list', () => {
  it('renders the mistakes list, sorted by count DESC then key ASC, when the run finished with mistakes', () => {
    renderView({
      state: makeState({
        status: 'finished',
        mistakes: { a: 1, shi: 3, b: 3 },
      }),
      wpm: 50,
      accuracy: 90,
    })
    const block = screen.getByTestId('typing-test-mistakes')
    expect(block).toBeInTheDocument()
    // count DESC first (shi/b tie at 3, broken by key ASC), then a (1).
    expect(screen.getByTestId('typing-test-mistake-b').textContent).toBe('b:3')
    expect(screen.getByTestId('typing-test-mistake-shi').textContent).toBe('shi:3')
    expect(screen.getByTestId('typing-test-mistake-a').textContent).toBe('a:1')
    const order = [...block.querySelectorAll('[data-testid^="typing-test-mistake-"]')].map((el) => el.getAttribute('data-testid'))
    expect(order).toEqual(['typing-test-mistake-b', 'typing-test-mistake-shi', 'typing-test-mistake-a'])
  })

  it('renders nothing when the finished run had no mistakes', () => {
    renderView({
      state: makeState({ status: 'finished', mistakes: {} }),
      wpm: 50,
      accuracy: 100,
    })
    expect(screen.queryByTestId('typing-test-mistakes')).toBeNull()
  })

  it('does not render the mistakes list before the run finishes, even if mistakes were already tallied', () => {
    renderView({
      state: makeState({ status: 'running', mistakes: { a: 1 } }),
      wpm: 50,
      accuracy: 90,
    })
    expect(screen.queryByTestId('typing-test-mistakes')).toBeNull()
  })

  it('caps the list to the top 12 entries', () => {
    const mistakes: Record<string, number> = {}
    for (let i = 0; i < 20; i++) mistakes[`k${String(i).padStart(2, '0')}`] = 20 - i
    renderView({
      state: makeState({ status: 'finished', mistakes }),
      wpm: 50,
      accuracy: 90,
    })
    const block = screen.getByTestId('typing-test-mistakes')
    expect(block.querySelectorAll('[data-testid^="typing-test-mistake-"]')).toHaveLength(12)
  })
})

describe('TypingTestView error-class line', () => {
  it('renders the substitution/omission/insertion counts when the finished result has the fields', () => {
    renderView({
      state: makeState({ status: 'finished' }),
      wpm: 50,
      accuracy: 90,
      errorClasses: { substitutions: 2, omissions: 1, insertions: 0 },
    })
    expect(screen.getByTestId('typing-test-error-substitutions').textContent).toContain('2')
    expect(screen.getByTestId('typing-test-error-omissions').textContent).toContain('1')
    expect(screen.getByTestId('typing-test-error-insertions').textContent).toContain('0')
  })

  it('renders nothing when errorClasses is null (romaji run, no finalized words, or legacy result)', () => {
    renderView({
      state: makeState({ status: 'finished' }),
      wpm: 50,
      accuracy: 90,
      errorClasses: null,
    })
    expect(screen.queryByTestId('typing-test-error-classes')).toBeNull()
  })

  it('renders nothing when errorClasses is omitted entirely (defaults to null)', () => {
    renderView({ state: makeState({ status: 'finished' }), wpm: 50, accuracy: 90 })
    expect(screen.queryByTestId('typing-test-error-classes')).toBeNull()
  })

  it('does not render before the run finishes, even if errorClasses were somehow already set', () => {
    renderView({
      state: makeState({ status: 'running' }),
      errorClasses: { substitutions: 2, omissions: 1, insertions: 0 },
    })
    expect(screen.queryByTestId('typing-test-error-classes')).toBeNull()
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

describe('TypingTestView romaji guide — flat fallback (no measured lines)', () => {
  // jsdom never lays elements out (width stays 0), so `lines` is always null
  // here regardless of state.lineBreaks — every test in this block exercises
  // the flat single-flow rendering path (see TypingTestView's `guideLines`).
  it('does not render the guide row when romajiGuide is null', () => {
    renderView({ state: makeState({ status: 'running', words: ['あい'] }) })
    expect(screen.queryByTestId('typing-test-romaji-guide')).toBeNull()
  })

  it('renders typed and remaining romaji, and rewrites on prop changes', () => {
    const { rerender } = renderView({
      state: makeState({ status: 'running', words: ['あい'] }),
      romajiGuide: { typed: '', remaining: 'ai', kanaCompleted: 0, words: ['ai'], lineCount: 2, showRow: true },
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
          romajiGuide={{ typed: 'a', remaining: 'i', kanaCompleted: 1, words: ['ai'], lineCount: 2, showRow: true }}
        />
      </I18nextProvider>,
    )
    guide = screen.getByTestId('typing-test-romaji-guide')
    expect(guide.textContent).toBe('ai')
    expect(guide.querySelector('.text-success')?.textContent).toBe('a')
    expect(guide.querySelector('.text-content-muted')?.textContent).toBe('i')
  })

  it('renders the lookahead words, space-separated, after typed/remaining', () => {
    renderView({
      state: makeState({ status: 'running', words: ['あい', 'かめ', 'いぬ'] }),
      romajiGuide: { typed: 'a', remaining: 'i', kanaCompleted: 1, words: ['ai', 'kame', 'inu'], lineCount: 3, showRow: true },
    })
    const guide = screen.getByTestId('typing-test-romaji-guide')
    const lookaheadSpans = screen.getAllByTestId('typing-test-romaji-lookahead')
    expect(lookaheadSpans).toHaveLength(2)
    expect(lookaheadSpans[0].textContent).toBe(' kame')
    expect(lookaheadSpans[1].textContent).toBe(' inu')
    expect(guide.textContent).toBe('ai kame inu')
  })

  it('does not render any lookahead span when lineCount leaves nothing upcoming', () => {
    renderView({
      state: makeState({ status: 'running', words: ['あい'] }),
      romajiGuide: { typed: '', remaining: 'ai', kanaCompleted: 0, words: ['ai'], lineCount: 2, showRow: true },
    })
    expect(screen.queryByTestId('typing-test-romaji-lookahead')).toBeNull()
  })

  it('shows the IME hint once a composition event fires in romaji mode', () => {
    renderView({
      state: makeState({ status: 'running', words: ['あい'] }),
      romajiGuide: { typed: '', remaining: 'ai', kanaCompleted: 0, words: ['ai'], lineCount: 2, showRow: true },
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
      romajiGuide: { typed: '', remaining: 'ai', kanaCompleted: 0, words: ['ai'], lineCount: 2, showRow: true },
    })
    const guide = screen.getByTestId('typing-test-romaji-guide')
    expect(guide.style.getPropertyValue('--tt-font')).toBe('40')
    const typedRemaining = guide.querySelector('.typing-romaji-guide-text')
    expect(typedRemaining).not.toBeNull()
    // The IME hint stays a fixed small size, not tied to --tt-font.
    expect(guide.querySelector('[data-testid="typing-test-romaji-ime-hint"]')).toBeNull()
  })

  // Height-leak fix (romajiGuideStyle, distinct from multilineStyle): the
  // guide container must carry only --tt-font, never the reading window's
  // own inline `height` (multilineStyle's `windowHeight`) — regression
  // coverage for the bug this feature fixed.
  it('never carries an inline height on the guide container (height-leak fix)', () => {
    renderView({
      state: makeState({ status: 'running', words: ['あい'] }),
      romajiGuide: { typed: '', remaining: 'ai', kanaCompleted: 0, words: ['ai'], lineCount: 2, showRow: true },
    })
    const guide = screen.getByTestId('typing-test-romaji-guide')
    expect(guide.style.height).toBe('')
  })

  it('hides the guide row entirely when showRow is false and no IME hint is active', () => {
    renderView({
      state: makeState({ status: 'running', words: ['あい'] }),
      romajiGuide: { typed: '', remaining: 'ai', kanaCompleted: 0, words: ['ai'], lineCount: 0, showRow: false },
    })
    expect(screen.queryByTestId('typing-test-romaji-guide')).toBeNull()
  })

  it('shows only the IME hint (no spelling row) when showRow is false but the IME is detected', () => {
    renderView({
      state: makeState({ status: 'running', words: ['あい'] }),
      romajiGuide: { typed: '', remaining: 'ai', kanaCompleted: 0, words: ['ai'], lineCount: 0, showRow: false },
    })
    const textarea = screen.getByLabelText('IME input') as HTMLTextAreaElement
    fireEvent.compositionStart(textarea)
    const guide = screen.getByTestId('typing-test-romaji-guide')
    expect(screen.getByTestId('typing-test-romaji-ime-hint')).toBeInTheDocument()
    expect(guide.querySelector('.typing-romaji-guide-text')).toBeNull()
  })

  it('never renders per-line guide testids when lines are unmeasured', () => {
    renderView({
      state: makeState({ status: 'running', words: ['あい', 'かめ'] }),
      romajiGuide: { typed: '', remaining: 'ai', kanaCompleted: 0, words: ['ai', 'kame'], lineCount: 2, showRow: true },
    })
    expect(screen.queryByTestId('typing-test-romaji-guide-line-0')).toBeNull()
  })
})

// The real-lines path (state.lineBreaks) is used here instead of the
// synthetic monkeytype rows (useVisualLines) because jsdom can't measure
// layout — real line rows don't need measurement, so they're the only way
// to exercise the line-synchronized guide under jsdom.
describe('TypingTestView romaji guide — line-synchronized (real lines)', () => {
  it('anchors the guide to the current row: cursor on line 2 starts the guide at line 2, not line 1', () => {
    // 6 words, breaks after index 1 and 3 -> 3 lines of 2 words each:
    // line0=[0,1], line1=[2,3], line2=[4,5].
    renderView({
      state: makeState({
        status: 'running',
        words: ['w0', 'w1', 'w2', 'w3', 'w4', 'w5'],
        lineBreaks: new Set([1, 3]),
        currentWordIndex: 2,
      }),
      romajiGuide: {
        typed: 'ty', remaining: 'ped', kanaCompleted: 1,
        words: ['r0', 'r1', 'r2', 'r3', 'r4', 'r5'],
        lineCount: 2, showRow: true,
      },
    })
    expect(screen.queryByTestId('typing-test-romaji-guide-line-0')).not.toBeNull()
    expect(screen.queryByTestId('typing-test-romaji-guide-line-1')).not.toBeNull()
    // Guide line 0 is line1's romaji ([2,3]) — current word (2) typed/remaining
    // plus word 3 as same-line lookahead; guide line 1 is line2's romaji ([4,5]),
    // both entirely lookahead. Line0 ([0,1], before the current row) never appears.
    expect(screen.getByTestId('typing-test-romaji-guide-line-0').textContent).toBe('typed r3')
    expect(screen.getByTestId('typing-test-romaji-guide-line-1').textContent).toBe('r4 r5')
  })

  it('colors a done word (before the current word, same line) with the dimmed success tone', () => {
    // line0=[0,1], line1=[2,3]; currentWordIndex=3 -> word2 is "done" on the
    // same guide line as the current word.
    renderView({
      state: makeState({
        status: 'running',
        words: ['w0', 'w1', 'w2', 'w3'],
        lineBreaks: new Set([1]),
        currentWordIndex: 3,
      }),
      romajiGuide: {
        typed: 'ty', remaining: 'ped', kanaCompleted: 1,
        words: ['r0', 'r1', 'r2', 'r3'],
        lineCount: 1, showRow: true,
      },
    })
    const line = screen.getByTestId('typing-test-romaji-guide-line-0')
    expect(line.textContent).toBe('r2 typed')
    const done = line.querySelector('.text-success\\/60')
    expect(done?.textContent).toBe('r2')
    expect(line.querySelector('.text-success')?.textContent).toBe(' ty')
    expect(line.querySelector('.text-content-muted')?.textContent).toBe('ped')
    // The done-word tier is distinguishable from both the current word's
    // typed tone and the lookahead tone (asserted in the anchor test above).
    expect(done?.className).not.toContain('text-content-muted')
  })

  it('never carries an inline height on the guide container with real lines either', () => {
    renderView({
      state: makeState({ status: 'running', words: ['w0', 'w1'], lineBreaks: new Set([0]) }),
      romajiGuide: { typed: '', remaining: 'r0', kanaCompleted: 0, words: ['r0', 'r1'], lineCount: 2, showRow: true },
    })
    const guide = screen.getByTestId('typing-test-romaji-guide')
    expect(guide.style.height).toBe('')
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

  it('falls back to the flat word-flow layout when line-row measurement has not resolved (jsdom fallback)', () => {
    // Monkeytype modes (words/time/quote, i.e. lineBreaks empty) render
    // synthetic line rows once a hidden-mirror measurement resolves (see the
    // "monkeytype synthetic line rows" describe block below and
    // useVisualLines.test.ts's groupByOffsetTop tests) — but jsdom never
    // lays elements out (getBoundingClientRect stays all-zero), so the
    // container-width guard keeps this deterministic: unmeasured renders
    // flat, exactly like before this feature existed.
    const { container } = renderView({
      state: makeState({ status: 'running', words: ['a', 'b'], lineBreaks: new Set() }),
    })
    expect(container.querySelectorAll('[data-line-row]')).toHaveLength(0)
    // Flat word-flow still uses the shared var-driven window (no line rows).
    expect(screen.getByTestId('typing-test-words').className).toContain('typing-multiline-window')
  })
})

// Plan-line-keystroke-timeline PR1: TypingTestView snapshots its own
// realized `lines` into a caller-owned ref (consumed at finish time by
// use-typing-test-result-save.ts) via a useLayoutEffect, never during
// render.
describe('TypingTestView — lineSnapshotRef (line timeline PR1)', () => {
  it('writes {runId, wordCount, lines} once real (state.lineBreaks) lines render', () => {
    const ref: { current: LineSnapshot | null } = { current: null }
    renderView({
      lineSnapshotRef: ref,
      state: makeState({
        status: 'running',
        runId: 'run-xyz',
        words: ['a', 'b', 'c', 'd'],
        lineBreaks: new Set([1]),
      }),
    })
    expect(ref.current).toEqual({ runId: 'run-xyz', wordCount: 4, lines: [[0, 1], [2, 3]] })
  })

  it('writes null lines when content is flat/unmeasured (jsdom monkeytype fallback)', () => {
    const ref: { current: LineSnapshot | null } = { current: null }
    renderView({
      lineSnapshotRef: ref,
      state: makeState({
        status: 'running',
        runId: 'run-flat',
        words: ['a', 'b'],
        lineBreaks: new Set(),
      }),
    })
    expect(ref.current).toEqual({ runId: 'run-flat', wordCount: 2, lines: null })
  })

  it('updates the ref when runId/words change across a rerender', () => {
    const ref: { current: LineSnapshot | null } = { current: null }
    const { rerender } = renderView({
      lineSnapshotRef: ref,
      state: makeState({ status: 'running', runId: 'run-1', words: ['a', 'b'], lineBreaks: new Set([0]) }),
    })
    expect(ref.current).toEqual({ runId: 'run-1', wordCount: 2, lines: [[0], [1]] })

    rerender(
      <I18nextProvider i18n={i18n}>
        <TypingTestView
          lineSnapshotRef={ref}
          state={makeState({ status: 'running', runId: 'run-2', words: ['x', 'y', 'z'], lineBreaks: new Set([1]) })}
          wpm={0}
          accuracy={100}
          elapsedSeconds={0}
          remainingSeconds={null}
          config={DEFAULT_CONFIG}
          paused={false}
        />
      </I18nextProvider>,
    )
    expect(ref.current).toEqual({ runId: 'run-2', wordCount: 3, lines: [[0, 1], [2]] })
  })

  it('does nothing when lineSnapshotRef is not provided (optional prop)', () => {
    expect(() => renderView({
      state: makeState({ status: 'running', words: ['a', 'b'], lineBreaks: new Set([0]) }),
    })).not.toThrow()
  })
})

describe('TypingTestView — monkeytype synthetic line rows (measured)', () => {
  // jsdom never lays elements out (getBoundingClientRect/offsetTop always
  // read 0), so the mirror-measurement path (see useVisualLines) is
  // exercised here by stubbing both: getBoundingClientRect's width so the
  // container-width guard passes, and offsetTop — keyed by the mirror
  // span's `data-mirror-word` index — so groupByOffsetTop sees a
  // deterministic multi-row layout, the same seam useVisualLines itself
  // reads from in the real browser.
  let mockOffsetTops: number[] = []

  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 400, height: 100, top: 0, left: 0, right: 400, bottom: 100, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect)
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
      const idx = this.getAttribute('data-mirror-word')
      return idx === null ? 0 : (mockOffsetTops[Number(idx)] ?? 0)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    mockOffsetTops = []
  })

  it('groups words into measured rows instead of one flat row', () => {
    // Words 0-1 measure on the same row; word 2 wraps to a second row (the
    // せなか example: the first row ends at the last word that fits).
    mockOffsetTops = [0, 0, 24]
    const { container } = renderView({
      state: makeState({ status: 'running', words: ['a', 'b', 'c'], lineBreaks: new Set() }),
    })
    const rows = container.querySelectorAll('[data-line-row]')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('a')
    expect(rows[0].textContent).toContain('b')
    expect(rows[1].textContent).toContain('c')
  })

  it('never renders the ⏎ glyph for synthetic rows (lineBreaks stays empty in monkeytype modes)', () => {
    mockOffsetTops = [0, 0, 24, 24]
    const { container } = renderView({
      state: makeState({ status: 'running', words: ['a', 'b', 'c', 'd'], lineBreaks: new Set() }),
    })
    expect(container.querySelectorAll('[data-line-row]')).toHaveLength(2)
    expect(container.textContent).not.toContain('⏎')
  })

  it('never renders line-indent spans for synthetic rows (fileImport-only)', () => {
    mockOffsetTops = [0, 0, 24]
    renderView({
      state: makeState({ status: 'running', words: ['a', 'b', 'c'], lineBreaks: new Set() }),
    })
    expect(screen.queryByTestId('line-indent-0')).toBeNull()
    expect(screen.queryByTestId('line-indent-1')).toBeNull()
  })

  it('remeasures when the word list changes (regrouping applies)', () => {
    mockOffsetTops = [0, 0, 0]
    const { container, rerender } = renderView({
      state: makeState({ status: 'running', words: ['a', 'b', 'c'], lineBreaks: new Set() }),
    })
    expect(container.querySelectorAll('[data-line-row]')).toHaveLength(1)

    mockOffsetTops = [0, 24, 24]
    rerender(
      <I18nextProvider i18n={i18n}>
        <TypingTestView
          state={makeState({ status: 'running', words: ['x', 'y', 'z'], lineBreaks: new Set() })}
          wpm={0}
          accuracy={100}
          elapsedSeconds={0}
          remainingSeconds={null}
          config={DEFAULT_CONFIG}
          paused={false}
        />
      </I18nextProvider>,
    )
    expect(container.querySelectorAll('[data-line-row]')).toHaveLength(2)
  })

  it('still uses the shared var-driven multiline window when rows are synthetic', () => {
    mockOffsetTops = [0, 0, 24]
    renderView({
      state: makeState({ status: 'running', words: ['a', 'b', 'c'], lineBreaks: new Set() }),
    })
    expect(screen.getByTestId('typing-test-words').className).toContain('typing-multiline-window')
  })
})

// Plan-logical-line-window PR2: the Lines setting counts LOGICAL lines
// (real or synthetic rows), not visual rows — see useLogicalWindowHeight.
// jsdom never lays elements out, so `[data-line-row]`'s own
// getBoundingClientRect is stubbed per row (keyed by the row's own
// data-line-row index) to feed the measurement a deterministic multi-row
// geometry, the same seam useLogicalWindowHeight itself reads from in the
// real browser.
describe('TypingTestView — logical-line window height (measured, real lines)', () => {
  let mockRowRects: Record<number, { top: number; bottom: number }> = {}

  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const lineRow = this.getAttribute('data-line-row')
      const rect = lineRow !== null ? (mockRowRects[Number(lineRow)] ?? { top: 0, bottom: 0 }) : { top: 0, bottom: 0 }
      return {
        top: rect.top, bottom: rect.bottom, height: rect.bottom - rect.top,
        left: 0, right: 400, width: 400, x: 0, y: rect.top, toJSON: () => ({}),
      } as DOMRect
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    mockRowRects = {}
  })

  it('sets the window height to the bottom of the displayLines-th real line row', () => {
    // Three real lines (words split by lineBreaks after 0 and 1); displayLines=2
    // should size the window to rows 0-1 only (bottom of row 1 = 48).
    mockRowRects = { 0: { top: 0, bottom: 24 }, 1: { top: 24, bottom: 48 }, 2: { top: 48, bottom: 72 } }
    renderView({
      displayLines: 2,
      fontSize: 16,
      state: makeState({ status: 'running', words: ['a', 'b', 'c'], lineBreaks: new Set([0, 1]) }),
    })
    expect(screen.getByTestId('typing-test-words').style.height).toBe('48px')
  })

  it('keeps the CSS min-height fallback when there are fewer/shorter rows than displayLines (short text)', () => {
    // Two real lines totaling 40px of measured content; displayLines=4 at
    // fontSize=16 sets a 96px floor (16 * 4 * 1.5) — content stays shorter
    // than the floor, so the blank-window minimum wins instead of shrinking.
    mockRowRects = { 0: { top: 0, bottom: 20 }, 1: { top: 20, bottom: 40 } }
    renderView({
      displayLines: 4,
      fontSize: 16,
      state: makeState({ status: 'running', words: ['a', 'b'], lineBreaks: new Set([0]) }),
    })
    expect(screen.getByTestId('typing-test-words').style.height).toBe('96px')
  })

  it('re-measures when displayLines changes', () => {
    mockRowRects = { 0: { top: 0, bottom: 24 }, 1: { top: 24, bottom: 48 }, 2: { top: 48, bottom: 72 } }
    const { rerender } = renderView({
      displayLines: 2,
      fontSize: 16,
      state: makeState({ status: 'running', words: ['a', 'b', 'c'], lineBreaks: new Set([0, 1]) }),
    })
    expect(screen.getByTestId('typing-test-words').style.height).toBe('48px')

    rerender(
      <I18nextProvider i18n={i18n}>
        <TypingTestView
          state={makeState({ status: 'running', words: ['a', 'b', 'c'], lineBreaks: new Set([0, 1]) })}
          wpm={0}
          accuracy={100}
          elapsedSeconds={0}
          remainingSeconds={null}
          config={DEFAULT_CONFIG}
          paused={false}
          displayLines={3}
          fontSize={16}
        />
      </I18nextProvider>,
    )
    expect(screen.getByTestId('typing-test-words').style.height).toBe('72px')
  })
})

describe('TypingTestView — logical-line window height (unmeasured fallback)', () => {
  it('sets the window height to the CSS min-height formula when line rows cannot be measured (jsdom)', () => {
    // No getBoundingClientRect mocking here — jsdom's real all-zero rects
    // mean the container-width guard keeps `lines` null, so the height
    // falls back to fontSize * displayLines * 1.5, matching the pre-feature
    // fixed CSS height exactly.
    renderView({
      displayLines: 4,
      fontSize: 24,
      state: makeState({ status: 'running', words: ['a', 'b'], lineBreaks: new Set() }),
    })
    expect(screen.getByTestId('typing-test-words').style.height).toBe('144px')
  })
})

describe('TypingTestView — logical-line window height (measured, synthetic monkeytype rows)', () => {
  let mockOffsetTops: number[] = []
  let mockRowRects: Record<number, { top: number; bottom: number }> = {}

  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const lineRow = this.getAttribute('data-line-row')
      const rect = lineRow !== null ? (mockRowRects[Number(lineRow)] ?? { top: 0, bottom: 0 }) : { top: 0, bottom: 0 }
      return {
        top: rect.top, bottom: rect.bottom, height: rect.bottom - rect.top,
        left: 0, right: 400, width: 400, x: 0, y: rect.top, toJSON: () => ({}),
      } as DOMRect
    })
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
      const idx = this.getAttribute('data-mirror-word')
      return idx === null ? 0 : (mockOffsetTops[Number(idx)] ?? 0)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    mockOffsetTops = []
    mockRowRects = {}
  })

  it('measures synthetic rows the same way as real rows (logical==visual for monkeytype)', () => {
    // Words a,b measure onto row 0; c wraps to row 1. fontSize is chosen so
    // the CSS min-height floor (10 * 2 * 1.5 = 30) is well below the
    // measured target (48) — if the effect only ever ran its first pass
    // (before useVisualLines resolves `lines` asynchronously) this would
    // read 30px instead, so the assertion actually exercises the re-measure
    // once the synthetic rows land, not just the fallback.
    mockOffsetTops = [0, 0, 24]
    mockRowRects = { 0: { top: 0, bottom: 24 }, 1: { top: 24, bottom: 48 } }
    renderView({
      displayLines: 2,
      fontSize: 10,
      state: makeState({ status: 'running', words: ['a', 'b', 'c'], lineBreaks: new Set() }),
    })
    expect(screen.getByTestId('typing-test-words').style.height).toBe('48px')
  })
})
