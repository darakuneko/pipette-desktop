// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { TypingTestSettingsBar } from '../TypingTestSettingsBar'
import type { TypingTestConfig } from '../types'
import { DEFAULT_CONFIG } from '../types'

function renderBar(props: Partial<Parameters<typeof TypingTestSettingsBar>[0]> = {}) {
  const defaults = {
    config: DEFAULT_CONFIG,
    onConfigChange: vi.fn(),
    language: 'english',
  }
  return render(
    <I18nextProvider i18n={i18n}>
      <TypingTestSettingsBar {...defaults} {...props} />
    </I18nextProvider>,
  )
}

describe('TypingTestSettingsBar mode tabs', () => {
  it('renders mode tabs', () => {
    renderBar()
    expect(screen.getByTestId('mode-words')).toBeInTheDocument()
    expect(screen.getByTestId('mode-time')).toBeInTheDocument()
    expect(screen.getByTestId('mode-quote')).toBeInTheDocument()
  })

  it('highlights the active mode tab', () => {
    renderBar()
    expect(screen.getByTestId('mode-words').className).toContain('text-accent')
    expect(screen.getByTestId('mode-time').className).not.toContain('text-accent')
  })

  it('calls onConfigChange when mode tab clicked', () => {
    const onConfigChange = vi.fn()
    renderBar({ onConfigChange })
    fireEvent.click(screen.getByTestId('mode-time'))
    expect(onConfigChange).toHaveBeenCalledTimes(1)
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    expect(arg.mode).toBe('time')
  })

  it('shows word count options (with the words unit) in words mode', () => {
    renderBar()
    expect(screen.getByTestId('word-count-15')).toBeInTheDocument()
    expect(screen.getByTestId('word-count-120')).toBeInTheDocument()
    // Unit label travels with the button so the value is unambiguous.
    expect(screen.getByTestId('word-count-30').textContent).toBe('30')
  })

  it('highlights the selected word count option with accent color', () => {
    const config: TypingTestConfig = { mode: 'words', wordCount: 60, punctuation: false, numbers: false }
    renderBar({ config })
    expect(screen.getByTestId('word-count-60').className).toContain('text-accent')
    expect(screen.getByTestId('word-count-30').className).not.toContain('text-accent')
  })

  it('calls onConfigChange when word count option clicked', () => {
    const onConfigChange = vi.fn()
    renderBar({ onConfigChange })
    fireEvent.click(screen.getByTestId('word-count-60'))
    expect(onConfigChange).toHaveBeenCalledTimes(1)
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    expect(arg.mode).toBe('words')
    if (arg.mode === 'words') {
      expect(arg.wordCount).toBe(60)
    }
  })

  it('shows duration options (with the seconds unit) in time mode', () => {
    const config: TypingTestConfig = { mode: 'time', duration: 30, punctuation: false, numbers: false }
    renderBar({ config })
    expect(screen.getByTestId('duration-15')).toBeInTheDocument()
    expect(screen.getByTestId('duration-120')).toBeInTheDocument()
    expect(screen.getByTestId('duration-30').textContent).toBe('30')
  })

  it('shows quote length options in quote mode', () => {
    const config: TypingTestConfig = { mode: 'quote', quoteLength: 'medium' }
    renderBar({ config })
    expect(screen.getByTestId('quote-short')).toBeInTheDocument()
    expect(screen.getByTestId('quote-medium')).toBeInTheDocument()
    expect(screen.getByTestId('quote-long')).toBeInTheDocument()
    expect(screen.getByTestId('quote-all')).toBeInTheDocument()
  })
})

describe('TypingTestSettingsBar toggles', () => {
  it('shows punctuation and numbers toggles in words mode', () => {
    renderBar()
    expect(screen.getByTestId('toggle-punctuation')).toBeInTheDocument()
    expect(screen.getByTestId('toggle-numbers')).toBeInTheDocument()
  })

  it('shows punctuation and numbers toggles in time mode', () => {
    const config: TypingTestConfig = { mode: 'time', duration: 30, punctuation: false, numbers: false }
    renderBar({ config })
    expect(screen.getByTestId('toggle-punctuation')).toBeInTheDocument()
    expect(screen.getByTestId('toggle-numbers')).toBeInTheDocument()
  })

  it('hides punctuation and numbers toggles in quote mode', () => {
    const config: TypingTestConfig = { mode: 'quote', quoteLength: 'medium' }
    renderBar({ config })
    expect(screen.queryByTestId('toggle-punctuation')).not.toBeInTheDocument()
    expect(screen.queryByTestId('toggle-numbers')).not.toBeInTheDocument()
  })

  it('highlights active punctuation toggle', () => {
    const config: TypingTestConfig = { mode: 'words', wordCount: 30, punctuation: true, numbers: false }
    renderBar({ config })
    expect(screen.getByTestId('toggle-punctuation').className).toContain('text-accent')
  })

  it('calls onConfigChange when punctuation toggle clicked', () => {
    const onConfigChange = vi.fn()
    renderBar({ onConfigChange })
    fireEvent.click(screen.getByTestId('toggle-punctuation'))
    expect(onConfigChange).toHaveBeenCalledTimes(1)
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    if (arg.mode === 'words') {
      expect(arg.punctuation).toBe(true)
    }
  })
})

describe('TypingTestSettingsBar romaji toggle', () => {
  it('hides the romaji toggle for a non-kana language', () => {
    renderBar({ language: 'english' })
    expect(screen.queryByTestId('toggle-romaji')).not.toBeInTheDocument()
  })

  it('hides the romaji toggle for an empty language string', () => {
    renderBar({ language: '' })
    expect(screen.queryByTestId('toggle-romaji')).not.toBeInTheDocument()
  })

  it('shows the romaji toggle for japanese_hiragana in words mode', () => {
    renderBar({ language: 'japanese_hiragana' })
    expect(screen.getByTestId('toggle-romaji')).toBeInTheDocument()
  })

  it('shows the romaji toggle for japanese_katakana in time mode', () => {
    const config: TypingTestConfig = { mode: 'time', duration: 30, punctuation: false, numbers: false }
    renderBar({ config, language: 'japanese_katakana' })
    expect(screen.getByTestId('toggle-romaji')).toBeInTheDocument()
  })

  it('hides the romaji toggle in quote mode even for a kana language', () => {
    const config: TypingTestConfig = { mode: 'quote', quoteLength: 'medium' }
    renderBar({ config, language: 'japanese_hiragana' })
    expect(screen.queryByTestId('toggle-romaji')).not.toBeInTheDocument()
  })

  it('highlights the romaji toggle when active', () => {
    const config: TypingTestConfig = { mode: 'words', wordCount: 30, punctuation: false, numbers: false, romajiInput: true }
    renderBar({ config, language: 'japanese_hiragana' })
    expect(screen.getByTestId('toggle-romaji').className).toContain('text-accent')
  })

  it('calls onConfigChange with romajiInput toggled on click', () => {
    const onConfigChange = vi.fn()
    const config: TypingTestConfig = { mode: 'words', wordCount: 30, punctuation: false, numbers: false }
    renderBar({ config, language: 'japanese_hiragana', onConfigChange })
    fireEvent.click(screen.getByTestId('toggle-romaji'))
    expect(onConfigChange).toHaveBeenCalledTimes(1)
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    if (arg.mode === 'words') {
      expect(arg.romajiInput).toBe(true)
    }
  })
})

describe('TypingTestSettingsBar toggle preservation', () => {
  it('preserves punctuation/numbers when switching words -> quote -> time', () => {
    const onConfigChange = vi.fn()
    // Start in words mode with punctuation/numbers enabled.
    const config: TypingTestConfig = { mode: 'words', wordCount: 30, punctuation: true, numbers: true }
    const { rerender } = render(
      <I18nextProvider i18n={i18n}>
        <TypingTestSettingsBar config={config} onConfigChange={onConfigChange} language="english" />
      </I18nextProvider>,
    )

    // Switch to quote mode (toggles drop from the config but are remembered).
    fireEvent.click(screen.getByTestId('mode-quote'))
    const quoteConfig = onConfigChange.mock.calls[0][0] as TypingTestConfig
    expect(quoteConfig.mode).toBe('quote')

    onConfigChange.mockClear()
    rerender(
      <I18nextProvider i18n={i18n}>
        <TypingTestSettingsBar config={quoteConfig} onConfigChange={onConfigChange} language="english" />
      </I18nextProvider>,
    )

    // Switch to time mode — toggles restored from before quote mode.
    fireEvent.click(screen.getByTestId('mode-time'))
    const timeConfig = onConfigChange.mock.calls[0][0] as TypingTestConfig
    expect(timeConfig.mode).toBe('time')
    if (timeConfig.mode === 'time') {
      expect(timeConfig.punctuation).toBe(true)
      expect(timeConfig.numbers).toBe(true)
    }
  })

  it('preserves romajiInput when switching words -> time', () => {
    const onConfigChange = vi.fn()
    const config: TypingTestConfig = { mode: 'words', wordCount: 30, punctuation: false, numbers: false, romajiInput: true }
    renderBar({ config, language: 'japanese_hiragana', onConfigChange })

    fireEvent.click(screen.getByTestId('mode-time'))

    const timeConfig = onConfigChange.mock.calls[0][0] as TypingTestConfig
    expect(timeConfig.mode).toBe('time')
    if (timeConfig.mode === 'time') {
      expect(timeConfig.romajiInput).toBe(true)
    }
  })

  it('preserves romajiInput through quote mode, same as punctuation/numbers', () => {
    const onConfigChange = vi.fn()
    const config: TypingTestConfig = { mode: 'words', wordCount: 30, punctuation: false, numbers: false, romajiInput: true }
    const { rerender } = render(
      <I18nextProvider i18n={i18n}>
        <TypingTestSettingsBar config={config} onConfigChange={onConfigChange} language="japanese_hiragana" />
      </I18nextProvider>,
    )

    // Switch to quote mode (romajiInput drops from the config but is remembered).
    fireEvent.click(screen.getByTestId('mode-quote'))
    const quoteConfig = onConfigChange.mock.calls[0][0] as TypingTestConfig
    expect(quoteConfig.mode).toBe('quote')

    onConfigChange.mockClear()
    rerender(
      <I18nextProvider i18n={i18n}>
        <TypingTestSettingsBar config={quoteConfig} onConfigChange={onConfigChange} language="japanese_hiragana" />
      </I18nextProvider>,
    )

    // Switch back to words — romajiInput restored from before quote mode.
    fireEvent.click(screen.getByTestId('mode-words'))
    const wordsConfig = onConfigChange.mock.calls[0][0] as TypingTestConfig
    expect(wordsConfig.mode).toBe('words')
    if (wordsConfig.mode === 'words') {
      expect(wordsConfig.romajiInput).toBe(true)
    }
  })
})
