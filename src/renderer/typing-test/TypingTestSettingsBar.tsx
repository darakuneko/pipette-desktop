// SPDX-License-Identifier: GPL-2.0-or-later
// Labeled test-config bar (Pattern / Units / Option) shown below the Mode row
// in editor typing-test mode. Hidden for imported custom text (the parent
// gates on mode). Extracted from TypingTestView so the config controls live
// with the Mode / Base Layer row rather than above the reading area.

import { useRef, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { TypingTestConfig, TypingTestMode, QuoteLength, RomajiDetailSettings } from './types'
import { WORD_COUNT_OPTIONS, TIME_DURATION_OPTIONS, ROMAJI_INPUT_LANGUAGES, DEFAULT_FONT_SIZE } from './types'
import { RomajiSettingsModal } from './RomajiSettingsModal'

const MODES: TypingTestMode[] = ['words', 'time', 'quote']
const QUOTE_LENGTHS: QuoteLength[] = ['short', 'medium', 'long', 'all']

export function optionButtonClass(active: boolean, px: 'px-2.5' | 'px-3' = 'px-3'): string {
  // h-8 keeps every config control (here, the Mode row, and the History
  // button) the same height; inline-flex centres the label within it.
  const base = `inline-flex h-8 items-center rounded-md border ${px} text-sm transition-colors`
  return active
    ? `${base} border-accent bg-accent/10 font-semibold text-accent`
    : `${base} border-edge text-content-secondary hover:text-content`
}

// Each group's label sits on its own line above the buttons.
const LABEL = 'text-sm text-content-muted'

interface Props {
  config: TypingTestConfig
  onConfigChange: (config: TypingTestConfig) => void
  /** Currently selected word-language pack. Gates the Romaji button, which
   *  only applies to the kana packs (see `ROMAJI_INPUT_LANGUAGES`). */
  language: string
  /** The reading-window font size (Settings > Font), used by the Romaji
   *  Settings modal as the "linked" default for its own font-size field. */
  fontSize?: number
}

export function TypingTestSettingsBar({ config, onConfigChange, language, fontSize = DEFAULT_FONT_SIZE }: Props) {
  const { t } = useTranslation()
  const [showRomajiModal, setShowRomajiModal] = useState(false)

  // Remember toggle state (incl. the Romaji Settings detail fields) so it
  // persists through quote mode (which has no toggles at all).
  const togglesRef = useRef<{ punctuation: boolean; numbers: boolean; romajiInput: boolean; romaji?: RomajiDetailSettings }>(
    { punctuation: false, numbers: false, romajiInput: false },
  )
  if (config.mode === 'words' || config.mode === 'time') {
    togglesRef.current = {
      punctuation: config.punctuation,
      numbers: config.numbers,
      romajiInput: config.romajiInput === true,
      romaji: config.romaji,
    }
  }

  const handleModeChange = useCallback((mode: TypingTestMode) => {
    const { punctuation, numbers, romajiInput, romaji } = togglesRef.current
    const romajiDetail = romaji ? { romaji } : {}
    switch (mode) {
      case 'words':
        onConfigChange({ mode: 'words', wordCount: config.mode === 'words' ? config.wordCount : 30, punctuation, numbers, romajiInput, ...romajiDetail })
        break
      case 'time':
        onConfigChange({ mode: 'time', duration: config.mode === 'time' ? config.duration : 30, punctuation, numbers, romajiInput, ...romajiDetail })
        break
      case 'quote':
        onConfigChange({ mode: 'quote', quoteLength: config.mode === 'quote' ? config.quoteLength : 'medium' })
        break
    }
  }, [config, onConfigChange])

  const hasPunctuationNumbers = config.mode === 'words' || config.mode === 'time'
  // Romaji input only judges kana word packs — hidden for every other
  // language, and for quote mode (no toggles row at all).
  const showRomajiToggle = hasPunctuationNumbers && ROMAJI_INPUT_LANGUAGES.has(language)

  // The unit lives on the label so the buttons stay compact numbers.
  const unitsLabel = config.mode === 'words'
    ? t('editor.typingTest.unitsWords')
    : config.mode === 'time'
    ? t('editor.typingTest.unitsSec')
    : t('editor.typingTest.units')

  return (
    <div className="flex flex-col items-start gap-3">
      {/* Pattern — words / time / quote */}
      <div className="flex flex-col items-start gap-1">
        <span className={LABEL}>{t('editor.typingTest.pattern')}:</span>
        <div className="flex h-8 items-center gap-1 rounded-lg bg-surface-alt/50 px-1">
          {MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              data-testid={`mode-${mode}`}
              className={optionButtonClass(config.mode === mode)}
              onClick={() => handleModeChange(mode)}
            >
              {t(`editor.typingTest.mode.${mode}`)}
            </button>
          ))}
        </div>
      </div>

      {/* Units — the unit (words / sec) is shown on the label, so the value
          buttons stay compact numbers. Quote mode uses named lengths. */}
      <div className="flex flex-col items-start gap-1">
        <span className={LABEL}>{unitsLabel}:</span>
        {config.mode === 'words' && (
          <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
            {WORD_COUNT_OPTIONS.map((count) => (
              <button
                key={count}
                type="button"
                data-testid={`word-count-${count}`}
                className={optionButtonClass(config.wordCount === count)}
                onClick={() => onConfigChange({ ...config, wordCount: count })}
              >
                {count}
              </button>
            ))}
          </div>
        )}
        {config.mode === 'time' && (
          <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
            {TIME_DURATION_OPTIONS.map((dur) => (
              <button
                key={dur}
                type="button"
                data-testid={`duration-${dur}`}
                className={optionButtonClass(config.duration === dur)}
                onClick={() => onConfigChange({ ...config, duration: dur })}
              >
                {dur}
              </button>
            ))}
          </div>
        )}
        {config.mode === 'quote' && (
          <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
            {QUOTE_LENGTHS.map((len) => (
              <button
                key={len}
                type="button"
                data-testid={`quote-${len}`}
                className={optionButtonClass(config.quoteLength === len)}
                onClick={() => onConfigChange({ ...config, quoteLength: len })}
              >
                {t(`editor.typingTest.quoteLength.${len}`)}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Option — punctuation / numbers (words & time only) */}
      {hasPunctuationNumbers && (
        <div className="flex flex-col items-start gap-1">
          <span className={LABEL}>{t('editor.typingTest.optionLabel')}:</span>
          <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
            <button
              type="button"
              data-testid="toggle-punctuation"
              className={optionButtonClass(config.punctuation, 'px-2.5')}
              onClick={() => onConfigChange({ ...config, punctuation: !config.punctuation })}
            >
              {t('editor.typingTest.punctuation')}
            </button>
            <button
              type="button"
              data-testid="toggle-numbers"
              className={optionButtonClass(config.numbers, 'px-2.5')}
              onClick={() => onConfigChange({ ...config, numbers: !config.numbers })}
            >
              {t('editor.typingTest.numbers')}
            </button>
          </div>
          {/* Romaji — a dialog trigger (opens the detail settings modal),
              not a stateful toggle, so it keeps the full-width DATA-section
              button convention (see HistoryToggle) rather than the compact
              option buttons above. Active (accent) whenever romajiInput is
              on, so the state is visible without opening the modal. */}
          {showRomajiToggle && (
            <button
              type="button"
              data-testid="romaji-settings-toggle"
              className={`${optionButtonClass(config.romajiInput === true)} w-full justify-center`}
              onClick={() => setShowRomajiModal(true)}
              aria-haspopup="dialog"
              aria-expanded={showRomajiModal}
            >
              {t('editor.typingTest.romaji.toggle')}
            </button>
          )}
        </div>
      )}
      {showRomajiModal && hasPunctuationNumbers && (
        <RomajiSettingsModal
          config={config}
          onConfigChange={onConfigChange}
          linkedFontSize={fontSize}
          onClose={() => setShowRomajiModal(false)}
        />
      )}
    </div>
  )
}
