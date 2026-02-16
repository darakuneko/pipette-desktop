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
    onRestart: vi.fn(),
    onConfigChange: vi.fn(),
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

  it('word container has fixed height to prevent layout shift', () => {
    renderView({ state: makeState({ status: 'waiting' }) })
    const wordsContainer = screen.getByTestId('typing-test-words')
    expect(wordsContainer.className).toContain('h-[7.25rem]')
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

  it('shows results panel and triggers onRestart when restart button clicked', () => {
    const onRestart = vi.fn()
    renderView({
      state: makeState({ status: 'finished' }),
      wpm: 70,
      accuracy: 95,
      onRestart,
    })
    expect(screen.getByTestId('typing-test-results')).toBeInTheDocument()
    const restartBtn = screen.getByTestId('typing-test-restart')
    fireEvent.click(restartBtn)
    expect(onRestart).toHaveBeenCalledTimes(1)
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

describe('TypingTestView mode tabs', () => {
  it('renders mode tabs', () => {
    renderView()
    expect(screen.getByTestId('mode-words')).toBeInTheDocument()
    expect(screen.getByTestId('mode-time')).toBeInTheDocument()
    expect(screen.getByTestId('mode-quote')).toBeInTheDocument()
  })

  it('highlights the active mode tab', () => {
    renderView()
    expect(screen.getByTestId('mode-words').className).toContain('text-accent')
    expect(screen.getByTestId('mode-time').className).not.toContain('text-accent')
  })

  it('calls onConfigChange when mode tab clicked', () => {
    const onConfigChange = vi.fn()
    renderView({ onConfigChange })
    fireEvent.click(screen.getByTestId('mode-time'))
    expect(onConfigChange).toHaveBeenCalledTimes(1)
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    expect(arg.mode).toBe('time')
  })

  it('shows word count options in words mode', () => {
    renderView()
    expect(screen.getByTestId('word-count-15')).toBeInTheDocument()
    expect(screen.getByTestId('word-count-30')).toBeInTheDocument()
    expect(screen.getByTestId('word-count-60')).toBeInTheDocument()
    expect(screen.getByTestId('word-count-120')).toBeInTheDocument()
  })

  it('highlights the selected word count option with accent color', () => {
    const config: TypingTestConfig = { mode: 'words', wordCount: 60, punctuation: false, numbers: false }
    renderView({ config })
    expect(screen.getByTestId('word-count-60').className).toContain('text-accent')
    expect(screen.getByTestId('word-count-30').className).not.toContain('text-accent')
  })

  it('calls onConfigChange when word count option clicked', () => {
    const onConfigChange = vi.fn()
    renderView({ onConfigChange })
    fireEvent.click(screen.getByTestId('word-count-60'))
    expect(onConfigChange).toHaveBeenCalledTimes(1)
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    expect(arg.mode).toBe('words')
    if (arg.mode === 'words') {
      expect(arg.wordCount).toBe(60)
    }
  })

  it('shows duration options in time mode', () => {
    const config: TypingTestConfig = { mode: 'time', duration: 30, punctuation: false, numbers: false }
    renderView({ config })
    expect(screen.getByTestId('duration-15')).toBeInTheDocument()
    expect(screen.getByTestId('duration-30')).toBeInTheDocument()
    expect(screen.getByTestId('duration-60')).toBeInTheDocument()
    expect(screen.getByTestId('duration-120')).toBeInTheDocument()
  })

  it('shows quote length options in quote mode', () => {
    const config: TypingTestConfig = { mode: 'quote', quoteLength: 'medium' }
    renderView({ config })
    expect(screen.getByTestId('quote-short')).toBeInTheDocument()
    expect(screen.getByTestId('quote-medium')).toBeInTheDocument()
    expect(screen.getByTestId('quote-long')).toBeInTheDocument()
    expect(screen.getByTestId('quote-all')).toBeInTheDocument()
  })
})

describe('TypingTestView toggles', () => {
  it('shows punctuation and numbers toggles in words mode', () => {
    renderView()
    expect(screen.getByTestId('toggle-punctuation')).toBeInTheDocument()
    expect(screen.getByTestId('toggle-numbers')).toBeInTheDocument()
  })

  it('shows punctuation and numbers toggles in time mode', () => {
    const config: TypingTestConfig = { mode: 'time', duration: 30, punctuation: false, numbers: false }
    renderView({ config })
    expect(screen.getByTestId('toggle-punctuation')).toBeInTheDocument()
    expect(screen.getByTestId('toggle-numbers')).toBeInTheDocument()
  })

  it('hides punctuation and numbers toggles in quote mode', () => {
    const config: TypingTestConfig = { mode: 'quote', quoteLength: 'medium' }
    renderView({ config })
    expect(screen.queryByTestId('toggle-punctuation')).not.toBeInTheDocument()
    expect(screen.queryByTestId('toggle-numbers')).not.toBeInTheDocument()
  })

  it('highlights active punctuation toggle', () => {
    const config: TypingTestConfig = { mode: 'words', wordCount: 30, punctuation: true, numbers: false }
    renderView({ config })
    expect(screen.getByTestId('toggle-punctuation').className).toContain('text-accent')
  })

  it('calls onConfigChange when punctuation toggle clicked', () => {
    const onConfigChange = vi.fn()
    renderView({ onConfigChange })
    fireEvent.click(screen.getByTestId('toggle-punctuation'))
    expect(onConfigChange).toHaveBeenCalledTimes(1)
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    if (arg.mode === 'words') {
      expect(arg.punctuation).toBe(true)
    }
  })
})

describe('TypingTestView toggle preservation', () => {
  it('preserves punctuation/numbers when switching words -> quote -> time', () => {
    const onConfigChange = vi.fn()
    // Start in words mode with punctuation enabled
    const config: TypingTestConfig = { mode: 'words', wordCount: 30, punctuation: true, numbers: true }
    const { rerender } = render(
      <I18nextProvider i18n={i18n}>
        <TypingTestView
          state={makeState()}
          wpm={0}
          accuracy={100}
          elapsedSeconds={0}
          remainingSeconds={null}
          config={config}
          paused={false}
          onRestart={vi.fn()}
          onConfigChange={onConfigChange}
        />
      </I18nextProvider>,
    )

    // Switch to quote mode
    fireEvent.click(screen.getByTestId('mode-quote'))
    const quoteConfig = onConfigChange.mock.calls[0][0] as TypingTestConfig
    expect(quoteConfig.mode).toBe('quote')

    // Rerender in quote mode
    onConfigChange.mockClear()
    rerender(
      <I18nextProvider i18n={i18n}>
        <TypingTestView
          state={makeState()}
          wpm={0}
          accuracy={100}
          elapsedSeconds={0}
          remainingSeconds={null}
          config={quoteConfig}
          paused={false}
          onRestart={vi.fn()}
          onConfigChange={onConfigChange}
        />
      </I18nextProvider>,
    )

    // Switch to time mode - toggles should be preserved from before quote mode
    fireEvent.click(screen.getByTestId('mode-time'))
    const timeConfig = onConfigChange.mock.calls[0][0] as TypingTestConfig
    expect(timeConfig.mode).toBe('time')
    if (timeConfig.mode === 'time') {
      expect(timeConfig.punctuation).toBe(true)
      expect(timeConfig.numbers).toBe(true)
    }
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
