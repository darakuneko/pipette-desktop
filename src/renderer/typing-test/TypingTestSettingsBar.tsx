// SPDX-License-Identifier: GPL-2.0-or-later
// Labeled test-config bar (Pattern / Units / Option) shown below the Mode row
// in editor typing-test mode. Pattern/Units only render for words/time/quote
// (the parent gates the whole bar on mode + romaji capability — tatoeba and
// fileImport only ever see this bar's Option row, and only once their
// content is romaji-capable, see isRomajiCapable). Extracted from
// TypingTestView so the config controls live with the Mode / Base Layer row
// rather than above the reading area.

import { useRef, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { TypingTestConfig, TypingTestMode, QuoteLength, RomajiDetailSettings } from './types'
import { WORD_COUNT_OPTIONS, TIME_DURATION_OPTIONS } from './types'
import { isRomajiCapable, isRomajiInputEnabled } from './romaji-input'
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
  /** Currently selected word-language pack (words/time mode) or Tatoeba
   *  pack id (tatoeba mode). Together with `textRomajiCapable`, gates the
   *  Romaji button — see `isRomajiCapable`. */
  language: string
  /** Whether the currently loaded fileImport text is kana-pure (see
   *  `TypingTestState.romajiCapable`); ignored for every other mode. */
  textRomajiCapable: boolean
}

export function TypingTestSettingsBar({ config, onConfigChange, language, textRomajiCapable }: Props) {
  const { t } = useTranslation()
  const [showRomajiModal, setShowRomajiModal] = useState(false)

  // Remember toggle state (incl. the Romaji Settings detail fields) so it
  // persists through quote mode (which has no toggles at all). punctuation/
  // numbers only ever come from words/time (the only modes that have them);
  // romajiInput/romaji are carried from every mode but quote, since tatoeba
  // and fileImport carry those fields too now (see TypingTestConfig).
  const togglesRef = useRef<{ punctuation: boolean; numbers: boolean; romajiInput: boolean; romaji?: RomajiDetailSettings }>(
    { punctuation: false, numbers: false, romajiInput: true },
  )
  if (config.mode !== 'quote') {
    togglesRef.current = {
      ...togglesRef.current,
      // Default ON: an undefined (not-yet-touched) romajiInput carries as
      // true through a mode switch, matching isRomajiInputEnabled's default.
      romajiInput: isRomajiInputEnabled(config),
      romaji: config.romaji,
      ...(config.mode === 'words' || config.mode === 'time'
        ? { punctuation: config.punctuation, numbers: config.numbers }
        : {}),
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

  // Pattern (mode tabs) and Units (word count / duration / quote length) only
  // apply to the three modes this bar's own mode-switch can reach — tatoeba
  // and fileImport are switched from the Language selector instead (see
  // TypingTestPane), so this bar renders only their Option row for those two.
  const isPatternMode = config.mode === 'words' || config.mode === 'time' || config.mode === 'quote'
  const hasPunctuationNumbers = config.mode === 'words' || config.mode === 'time'
  // Aliased so the RomajiSettingsModal render below can narrow `config`
  // away from 'quote' (its Props require a mode that carries romajiInput).
  const isNotQuote = config.mode !== 'quote'
  // Romaji input judges kana content — words/time by language, tatoeba by
  // its pack's language id, fileImport by the loaded text's own content
  // (see isRomajiCapable). Never available in quote mode.
  const showRomajiToggle = isRomajiCapable(config, language, textRomajiCapable)

  // The unit lives on the label so the buttons stay compact numbers.
  const unitsLabel = config.mode === 'words'
    ? t('editor.typingTest.unitsWords')
    : config.mode === 'time'
    ? t('editor.typingTest.unitsSec')
    : t('editor.typingTest.units')

  return (
    <div className="flex w-full flex-col items-start gap-3">
      {/* Pattern — words / time / quote. Not shown for tatoeba / fileImport:
          those modes switch via the Language selector instead. */}
      {isPatternMode && (
        <div className="flex w-full flex-col items-start gap-1">
          <span className={LABEL}>{t('editor.typingTest.pattern')}</span>
          <div className="flex h-8 w-full items-center gap-1 rounded-lg bg-surface-alt/50 px-1">
            {MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                data-testid={`mode-${mode}`}
                className={`${optionButtonClass(config.mode === mode)} flex-1 justify-center`}
                onClick={() => handleModeChange(mode)}
              >
                {t(`editor.typingTest.mode.${mode}`)}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Units — the unit (words / sec) is shown on the label, so the value
          buttons stay compact numbers. Quote mode uses named lengths. */}
      {isPatternMode && (
        <div className="flex w-full flex-col items-start gap-1">
          <span className={LABEL}>{unitsLabel}</span>
          {config.mode === 'words' && (
            <div className="flex w-full items-center gap-1">
              {WORD_COUNT_OPTIONS.map((count) => (
                <button
                  key={count}
                  type="button"
                  data-testid={`word-count-${count}`}
                  className={`${optionButtonClass(config.wordCount === count)} flex-1 justify-center`}
                  onClick={() => onConfigChange({ ...config, wordCount: count })}
                >
                  {count}
                </button>
              ))}
            </div>
          )}
          {config.mode === 'time' && (
            <div className="flex w-full items-center gap-1">
              {TIME_DURATION_OPTIONS.map((dur) => (
                <button
                  key={dur}
                  type="button"
                  data-testid={`duration-${dur}`}
                  className={`${optionButtonClass(config.duration === dur)} flex-1 justify-center`}
                  onClick={() => onConfigChange({ ...config, duration: dur })}
                >
                  {dur}
                </button>
              ))}
            </div>
          )}
          {config.mode === 'quote' && (
            <div className="flex w-full items-center gap-1">
              {QUOTE_LENGTHS.map((len) => (
                <button
                  key={len}
                  type="button"
                  data-testid={`quote-${len}`}
                  className={`${optionButtonClass(config.quoteLength === len)} flex-1 justify-center`}
                  onClick={() => onConfigChange({ ...config, quoteLength: len })}
                >
                  {t(`editor.typingTest.quoteLength.${len}`)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Option — punctuation / numbers (words & time only) plus the Romaji
          trigger, shown whenever the current mode/content is romaji-capable
          (words/time/tatoeba by language, fileImport by content). */}
      {(hasPunctuationNumbers || showRomajiToggle) && (
        <div className="flex w-full flex-col items-start gap-1">
          <span className={LABEL}>{t('editor.typingTest.optionLabel')}</span>
          {hasPunctuationNumbers && (
            <div className="flex w-full items-center gap-1">
              <button
                type="button"
                data-testid="toggle-punctuation"
                className={`${optionButtonClass(config.punctuation, 'px-2.5')} flex-1 justify-center`}
                onClick={() => onConfigChange({ ...config, punctuation: !config.punctuation })}
              >
                {t('editor.typingTest.punctuation')}
              </button>
              <button
                type="button"
                data-testid="toggle-numbers"
                className={`${optionButtonClass(config.numbers, 'px-2.5')} flex-1 justify-center`}
                onClick={() => onConfigChange({ ...config, numbers: !config.numbers })}
              >
                {t('editor.typingTest.numbers')}
              </button>
            </div>
          )}
          {/* Romaji — a dialog trigger (opens the detail settings modal),
              not a stateful toggle, so it keeps the full-width DATA-section
              button convention (see HistoryToggle) rather than the compact
              option buttons above. Active (accent) whenever romajiInput is
              on, so the state is visible without opening the modal. */}
          {showRomajiToggle && isNotQuote && (
            <button
              type="button"
              data-testid="romaji-settings-toggle"
              className={`${optionButtonClass(isRomajiInputEnabled(config))} w-full justify-center`}
              onClick={() => setShowRomajiModal(true)}
              aria-haspopup="dialog"
              aria-expanded={showRomajiModal}
            >
              {t('editor.typingTest.romaji.toggle')}
            </button>
          )}
        </div>
      )}
      {showRomajiModal && showRomajiToggle && isNotQuote && (
        <RomajiSettingsModal
          config={config}
          onConfigChange={onConfigChange}
          onClose={() => setShowRomajiModal(false)}
        />
      )}
    </div>
  )
}
