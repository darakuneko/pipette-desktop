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
    textRomajiCapable: false,
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

describe('TypingTestSettingsBar romaji settings button', () => {
  it('hides the romaji button for a non-kana language', () => {
    renderBar({ language: 'english' })
    expect(screen.queryByTestId('romaji-settings-toggle')).not.toBeInTheDocument()
  })

  it('hides the romaji button for an empty language string', () => {
    renderBar({ language: '' })
    expect(screen.queryByTestId('romaji-settings-toggle')).not.toBeInTheDocument()
  })

  it('shows the romaji button for japanese_hiragana in words mode', () => {
    renderBar({ language: 'japanese_hiragana' })
    expect(screen.getByTestId('romaji-settings-toggle')).toBeInTheDocument()
  })

  it('shows the romaji button for japanese_katakana in time mode', () => {
    const config: TypingTestConfig = { mode: 'time', duration: 30, punctuation: false, numbers: false }
    renderBar({ config, language: 'japanese_katakana' })
    expect(screen.getByTestId('romaji-settings-toggle')).toBeInTheDocument()
  })

  it('hides the romaji button in quote mode even for a kana language', () => {
    const config: TypingTestConfig = { mode: 'quote', quoteLength: 'medium' }
    renderBar({ config, language: 'japanese_hiragana' })
    expect(screen.queryByTestId('romaji-settings-toggle')).not.toBeInTheDocument()
  })

  it('shows the romaji button (Option row only, no Pattern/Units) for a tatoeba kana pack', () => {
    const config: TypingTestConfig = { mode: 'tatoeba', language: 'japanese_hiragana' }
    renderBar({ config })
    expect(screen.getByTestId('romaji-settings-toggle')).toBeInTheDocument()
    expect(screen.queryByTestId('mode-words')).not.toBeInTheDocument()
    expect(screen.queryByTestId('toggle-punctuation')).not.toBeInTheDocument()
  })

  it('hides the romaji button for a tatoeba non-kana pack', () => {
    const config: TypingTestConfig = { mode: 'tatoeba', language: 'english' }
    renderBar({ config })
    expect(screen.queryByTestId('romaji-settings-toggle')).not.toBeInTheDocument()
  })

  it('shows the romaji button for a romaji-capable fileImport text', () => {
    const config: TypingTestConfig = { mode: 'fileImport', textId: 't1' }
    renderBar({ config, textRomajiCapable: true })
    expect(screen.getByTestId('romaji-settings-toggle')).toBeInTheDocument()
    expect(screen.queryByTestId('mode-words')).not.toBeInTheDocument()
  })

  it('hides the romaji button for a fileImport text that is not romaji-capable', () => {
    const config: TypingTestConfig = { mode: 'fileImport', textId: 't1' }
    renderBar({ config, textRomajiCapable: false })
    expect(screen.queryByTestId('romaji-settings-toggle')).not.toBeInTheDocument()
  })

  it('highlights the romaji button when romajiInput is active', () => {
    const config: TypingTestConfig = { mode: 'words', wordCount: 30, punctuation: false, numbers: false, romajiInput: true }
    renderBar({ config, language: 'japanese_hiragana' })
    expect(screen.getByTestId('romaji-settings-toggle').className).toContain('text-accent')
  })

  it('does not highlight the romaji button when romajiInput is inactive', () => {
    const config: TypingTestConfig = { mode: 'words', wordCount: 30, punctuation: false, numbers: false }
    renderBar({ config, language: 'japanese_hiragana' })
    expect(screen.getByTestId('romaji-settings-toggle').className).not.toContain('text-accent')
  })

  it('opens the Romaji Settings modal on click instead of toggling directly', () => {
    const onConfigChange = vi.fn()
    const config: TypingTestConfig = { mode: 'words', wordCount: 30, punctuation: false, numbers: false }
    renderBar({ config, language: 'japanese_hiragana', onConfigChange })
    expect(screen.queryByTestId('romaji-settings-modal')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('romaji-settings-toggle'))
    expect(onConfigChange).not.toHaveBeenCalled()
    expect(screen.getByTestId('romaji-settings-modal')).toBeInTheDocument()
  })

  it('toggles romajiInput via the modal master enable switch', () => {
    const onConfigChange = vi.fn()
    const config: TypingTestConfig = { mode: 'words', wordCount: 30, punctuation: false, numbers: false }
    renderBar({ config, language: 'japanese_hiragana', onConfigChange })
    fireEvent.click(screen.getByTestId('romaji-settings-toggle'))
    fireEvent.click(screen.getByTestId('romaji-settings-enabled'))
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
        <TypingTestSettingsBar config={config} onConfigChange={onConfigChange} language="english" textRomajiCapable={false} />
      </I18nextProvider>,
    )

    // Switch to quote mode (toggles drop from the config but are remembered).
    fireEvent.click(screen.getByTestId('mode-quote'))
    const quoteConfig = onConfigChange.mock.calls[0][0] as TypingTestConfig
    expect(quoteConfig.mode).toBe('quote')

    onConfigChange.mockClear()
    rerender(
      <I18nextProvider i18n={i18n}>
        <TypingTestSettingsBar config={quoteConfig} onConfigChange={onConfigChange} language="english" textRomajiCapable={false} />
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
        <TypingTestSettingsBar config={config} onConfigChange={onConfigChange} language="japanese_hiragana" textRomajiCapable={false} />
      </I18nextProvider>,
    )

    // Switch to quote mode (romajiInput drops from the config but is remembered).
    fireEvent.click(screen.getByTestId('mode-quote'))
    const quoteConfig = onConfigChange.mock.calls[0][0] as TypingTestConfig
    expect(quoteConfig.mode).toBe('quote')

    onConfigChange.mockClear()
    rerender(
      <I18nextProvider i18n={i18n}>
        <TypingTestSettingsBar config={quoteConfig} onConfigChange={onConfigChange} language="japanese_hiragana" textRomajiCapable={false} />
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

  it('preserves the romaji detail settings when switching words -> time', () => {
    const onConfigChange = vi.fn()
    const config: TypingTestConfig = {
      mode: 'words',
      wordCount: 30,
      punctuation: false,
      numbers: false,
      romajiInput: true,
      romaji: { caseStyle: 'capital', disabledStyles: ['c'] },
    }
    renderBar({ config, language: 'japanese_hiragana', onConfigChange })

    fireEvent.click(screen.getByTestId('mode-time'))

    const timeConfig = onConfigChange.mock.calls[0][0] as TypingTestConfig
    expect(timeConfig.mode).toBe('time')
    if (timeConfig.mode === 'time') {
      expect(timeConfig.romaji).toEqual({ caseStyle: 'capital', disabledStyles: ['c'] })
    }
  })

  it('preserves the romaji detail settings through quote mode', () => {
    const onConfigChange = vi.fn()
    const config: TypingTestConfig = {
      mode: 'words',
      wordCount: 30,
      punctuation: false,
      numbers: false,
      romajiInput: true,
      romaji: { guideStyles: ['kunrei'] },
    }
    const { rerender } = render(
      <I18nextProvider i18n={i18n}>
        <TypingTestSettingsBar config={config} onConfigChange={onConfigChange} language="japanese_hiragana" textRomajiCapable={false} />
      </I18nextProvider>,
    )

    fireEvent.click(screen.getByTestId('mode-quote'))
    const quoteConfig = onConfigChange.mock.calls[0][0] as TypingTestConfig
    expect(quoteConfig.mode).toBe('quote')

    onConfigChange.mockClear()
    rerender(
      <I18nextProvider i18n={i18n}>
        <TypingTestSettingsBar config={quoteConfig} onConfigChange={onConfigChange} language="japanese_hiragana" textRomajiCapable={false} />
      </I18nextProvider>,
    )

    fireEvent.click(screen.getByTestId('mode-words'))
    const wordsConfig = onConfigChange.mock.calls[0][0] as TypingTestConfig
    expect(wordsConfig.mode).toBe('words')
    if (wordsConfig.mode === 'words') {
      expect(wordsConfig.romaji).toEqual({ guideStyles: ['kunrei'] })
    }
  })
})
