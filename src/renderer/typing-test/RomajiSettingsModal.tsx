// SPDX-License-Identifier: GPL-2.0-or-later
// Detail settings for romaji-keystroke judging (kana word packs): the
// master enable, the guide row's display case, its font size, which
// spelling the guide prefers to show, and which alternate-spelling
// families are accepted as input. Opened from the Option section's
// full-width Romaji button in TypingTestSettingsBar, shown only while a
// kana pack (words/time mode) is selected — see ROMAJI_INPUT_LANGUAGES.

import { useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useEscapeClose } from '../hooks/useEscapeClose'
import { ModalCloseButton } from '../components/editors/ModalCloseButton'
import { MODAL_MD } from '../components/editors/store-modal-shared'
import { toggleTrackClass, toggleKnobClass, ROW_CLASS } from '../components/editors/modal-controls'
import type { RomajiStyle } from './romaji-engine'
import type { RomajiCaseStyle, RomajiDetailSettings, TypingTestConfig } from './types'
import { FONT_SIZE_MIN, FONT_SIZE_MAX, FONT_SIZE_STEP } from './types'

// Display order matches the plan's spec ("大文字・先頭大文字・小文字"); the
// i18n values for these keys are the fixed sample spellings ROMAJI / Romaji
// / romaji, identical in every locale (see english.json + the Japanese pack).
const CASE_STYLES: readonly RomajiCaseStyle[] = ['upper', 'capital', 'lower']

const GUIDE_STYLES: readonly (RomajiStyle | 'auto')[] = ['auto', 'kunrei', 'cq', 'digraph', 'xSmall', 'lSmall']
const INPUT_STYLES: readonly RomajiStyle[] = ['kunrei', 'cq', 'digraph', 'xSmall', 'lSmall']

const FONT_OPTIONS = Array.from(
  { length: (FONT_SIZE_MAX - FONT_SIZE_MIN) / FONT_SIZE_STEP + 1 },
  (_, i) => FONT_SIZE_MIN + i * FONT_SIZE_STEP,
)

function segmentButtonClass(active: boolean): string {
  const base = 'inline-flex h-8 items-center rounded-md border px-2.5 text-sm transition-colors'
  return active
    ? `${base} border-accent bg-accent/10 font-semibold text-accent`
    : `${base} border-edge text-content-secondary hover:text-content`
}

/** Drops fields set back to their unset/default value so a persisted config
 *  only ever carries what the user actually changed. Mirrors the same
 *  "undefined = default" contract `RomajiDetailSettings` documents. */
function pruneRomaji(next: RomajiDetailSettings): RomajiDetailSettings | undefined {
  const pruned: RomajiDetailSettings = {}
  if (next.caseStyle !== undefined) pruned.caseStyle = next.caseStyle
  if (next.fontSize !== undefined) pruned.fontSize = next.fontSize
  if (next.guideStyle !== undefined) pruned.guideStyle = next.guideStyle
  if (next.disabledStyles !== undefined && next.disabledStyles.length > 0) pruned.disabledStyles = next.disabledStyles
  return Object.keys(pruned).length > 0 ? pruned : undefined
}

interface Props {
  config: TypingTestConfig & { mode: 'words' | 'time' }
  onConfigChange: (config: TypingTestConfig) => void
  /** The linked Settings > Font value (reading-window font size). Used as
   *  the starting point when the "linked to Font" switch is turned off. */
  linkedFontSize: number
  onClose: () => void
}

export function RomajiSettingsModal({ config, onConfigChange, linkedFontSize, onClose }: Props) {
  const { t } = useTranslation()
  const backdropRef = useRef<HTMLDivElement>(null)
  useEscapeClose(onClose)

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === backdropRef.current) onClose()
  }, [onClose])

  const romaji = config.romaji ?? {}
  const enabled = config.romajiInput === true
  const caseStyle = romaji.caseStyle ?? 'lower'
  const guideStyle = romaji.guideStyle ?? 'auto'
  const disabledStyles = new Set(romaji.disabledStyles ?? [])
  const fontLinked = romaji.fontSize === undefined
  const fontValue = romaji.fontSize ?? linkedFontSize

  const applyRomaji = useCallback((patch: Partial<RomajiDetailSettings>) => {
    const merged = pruneRomaji({ ...romaji, ...patch })
    const { romaji: _current, ...rest } = config
    onConfigChange(merged ? { ...rest, romaji: merged } : rest)
  }, [config, romaji, onConfigChange])

  const toggleInputStyle = useCallback((style: RomajiStyle) => {
    const next = new Set(disabledStyles)
    if (next.has(style)) next.delete(style)
    else next.add(style)
    applyRomaji({ disabledStyles: [...next] })
  }, [disabledStyles, applyRomaji])

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="dialog"
      aria-labelledby="romaji-settings-title"
      onClick={handleBackdropClick}
      data-testid="romaji-settings-modal"
    >
      <div className={`flex max-h-modal-90vh flex-col ${MODAL_MD} rounded-2xl border border-edge bg-surface-alt shadow-xl`}>
        <div className="flex items-center justify-between border-b border-edge px-4 py-3">
          <h2 id="romaji-settings-title" className="text-lg font-semibold text-content">
            {t('editor.typingTest.romajiSettings.title')}
          </h2>
          <ModalCloseButton testid="romaji-settings-modal-close" onClick={onClose} />
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto p-4">
          {/* Master enable */}
          <div className={ROW_CLASS} data-testid="romaji-settings-enabled-row">
            <span className="text-sm font-medium text-content">{t('editor.typingTest.romaji.toggle')}</span>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label={t('editor.typingTest.romaji.toggle')}
              className={toggleTrackClass(enabled)}
              onClick={() => onConfigChange({ ...config, romajiInput: !enabled })}
              data-testid="romaji-settings-enabled"
            >
              <span className={toggleKnobClass(enabled)} />
            </button>
          </div>

          {/* Display case — sample text itself is the label (ROMAJI / Romaji
              / romaji), invariant across locales; the key still routes
              through t() so it participates in the i18n pipeline. */}
          <section className="flex flex-col gap-1.5">
            <span className="text-sm text-content-muted">{t('editor.typingTest.romajiSettings.caseLabel')}:</span>
            <div className="flex flex-wrap gap-1">
              {CASE_STYLES.map((value) => (
                <button
                  key={value}
                  type="button"
                  data-testid={`romaji-case-${value}`}
                  className={segmentButtonClass(caseStyle === value)}
                  onClick={() => applyRomaji({ caseStyle: value === 'lower' ? undefined : value })}
                >
                  {t(`editor.typingTest.romajiSettings.case.${value}`)}
                </button>
              ))}
            </div>
          </section>

          {/* Font size — linked to Settings > Font by default. */}
          <section className="flex flex-col gap-1.5">
            <span className="text-sm text-content-muted">{t('editor.typingTest.fontSize')}:</span>
            <div className={ROW_CLASS}>
              <span className="text-sm text-content">{t('editor.typingTest.romajiSettings.fontLinked')}</span>
              <button
                type="button"
                role="switch"
                aria-checked={fontLinked}
                aria-label={t('editor.typingTest.romajiSettings.fontLinked')}
                className={toggleTrackClass(fontLinked)}
                onClick={() => applyRomaji({ fontSize: fontLinked ? linkedFontSize : undefined })}
                data-testid="romaji-font-linked"
              >
                <span className={toggleKnobClass(fontLinked)} />
              </button>
            </div>
            {!fontLinked && (
              <select
                data-testid="romaji-font-size-select"
                aria-label={t('editor.typingTest.fontSize')}
                value={fontValue}
                onChange={(e) => applyRomaji({ fontSize: Number(e.target.value) })}
                className="h-8 w-20 rounded-md border border-edge bg-surface px-2 text-sm text-content focus:border-accent focus:outline-none"
              >
                {FONT_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            )}
          </section>

          {/* Guide display pattern — single-select, display only. */}
          <section className="flex flex-col gap-1.5">
            <span className="text-sm text-content-muted">{t('editor.typingTest.romajiSettings.guideLabel')}:</span>
            <div className="flex flex-wrap gap-1">
              {GUIDE_STYLES.map((style) => (
                <button
                  key={style}
                  type="button"
                  data-testid={`romaji-guide-${style}`}
                  className={segmentButtonClass(guideStyle === style)}
                  onClick={() => applyRomaji({ guideStyle: style === 'auto' ? undefined : style })}
                >
                  {style === 'auto'
                    ? t('editor.typingTest.romajiSettings.guideAuto')
                    : t(`editor.typingTest.romajiSettings.style.${style}`)}
                </button>
              ))}
            </div>
            <p className="text-xs text-content-muted">{t('editor.typingTest.romajiSettings.guideHint')}</p>
          </section>

          {/* Accepted input patterns — multi-toggle, default all on. */}
          <section className="flex flex-col gap-1.5">
            <span className="text-sm text-content-muted">{t('editor.typingTest.romajiSettings.inputLabel')}:</span>
            <div className="flex flex-wrap gap-1">
              {INPUT_STYLES.map((style) => (
                <button
                  key={style}
                  type="button"
                  data-testid={`romaji-input-${style}`}
                  aria-pressed={!disabledStyles.has(style)}
                  className={segmentButtonClass(!disabledStyles.has(style))}
                  onClick={() => toggleInputStyle(style)}
                >
                  {t(`editor.typingTest.romajiSettings.style.${style}`)}
                </button>
              ))}
            </div>
            <p className="text-xs text-content-muted">{t('editor.typingTest.romajiSettings.inputHint')}</p>
          </section>
        </div>
      </div>
    </div>
  )
}
