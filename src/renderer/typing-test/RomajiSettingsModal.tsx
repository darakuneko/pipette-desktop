// SPDX-License-Identifier: GPL-2.0-or-later
// Detail settings for romaji-keystroke judging (kana word packs): the
// master enable, the guide row's display case, which spelling the guide
// prefers to show, and which alternate-spelling families are accepted as
// input. The guide row's font size always tracks the shared Settings >
// Font size — no separate control here. Opened from the Option section's
// full-width Romaji button in TypingTestSettingsBar, shown only while a
// kana pack (words/time mode) is selected — see ROMAJI_INPUT_LANGUAGES.

import { useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useEscapeClose } from '../hooks/useEscapeClose'
import { ModalCloseButton } from '../components/editors/ModalCloseButton'
import { MODAL_LG } from '../components/editors/store-modal-shared'
import { ToggleRow } from '../components/editors/modal-controls'
import { Tooltip } from '../components/ui/Tooltip'
import { BASE_STYLES, type RomajiStyle } from './romaji-engine'
import type { RomajiCaseStyle, RomajiDetailSettings, TypingTestConfig } from './types'
import { optionButtonClass } from './TypingTestSettingsBar'

// Display order matches the plan's spec ("大文字・先頭大文字・小文字"); the
// i18n values for these keys are the fixed sample spellings ROMAJI / Romaji
// / romaji, identical in every locale (see english.json + the Japanese pack).
const CASE_STYLES: readonly RomajiCaseStyle[] = ['upper', 'capital', 'lower']

// Both the Guide and the Accepted input patterns sections share the same
// Base/Options row split: BASE_STYLES (hepburn/kunrei) picks which base
// spelling system is represented, and OPTION_STYLES are the independent
// alternate-spelling families layered on top. Guide's Base row is a single
// select (exactly one of the two is always active); the input row's Base
// row is a toggle pair where at least one must stay enabled (see
// toggleBaseStyle). Both rows' Options are always a multi-select toggle.
// Each button shows a short label (system + one example spelling); the
// full example list lives in the shared Tooltip bubble (components/ui/
// Tooltip), the same affordance used by DeviceSelector / KeycodeField.
const OPTION_STYLES: readonly RomajiStyle[] =
  ['c', 'q', 'digraph', 'xSmall', 'lSmall', 'w', 'v', 'f', 'ye', 'xn', 'nApos']

// Shared by all four Base/Options button rows (Guide and Accepted input
// patterns each have one of each) so every button lands in the same column
// width regardless of its label length. Base only ever renders 2 buttons
// into this 4-column grid, leaving the last 2 cells empty — using the same
// grid-cols-4 as Options (11 buttons, wrapping to 3 rows) is what makes the
// two rows' columns line up instead of Base's pair rendering wider.
const STYLE_GRID_CLASS = 'grid grid-cols-4 gap-1'

/** Drops fields set back to their default value so a persisted config only
 *  ever carries what the user actually changed. The single source of truth
 *  for what "default" means per field (every call site above passes the
 *  real selected value — 'lower' / an empty guideStyles selection included
 *  — rather than deciding locally whether that value is the default).
 *  Mirrors the same "undefined = default" contract `RomajiDetailSettings`
 *  documents. */
function pruneRomaji(next: RomajiDetailSettings): RomajiDetailSettings | undefined {
  const pruned: RomajiDetailSettings = {}
  if (next.caseStyle !== undefined && next.caseStyle !== 'lower') pruned.caseStyle = next.caseStyle
  if (next.guideStyles !== undefined && next.guideStyles.length > 0) pruned.guideStyles = next.guideStyles
  if (next.disabledStyles !== undefined && next.disabledStyles.length > 0) pruned.disabledStyles = next.disabledStyles
  return Object.keys(pruned).length > 0 ? pruned : undefined
}

interface Props {
  config: TypingTestConfig & { mode: 'words' | 'time' }
  onConfigChange: (config: TypingTestConfig) => void
  onClose: () => void
}

export function RomajiSettingsModal({ config, onConfigChange, onClose }: Props) {
  const { t } = useTranslation()
  const backdropRef = useRef<HTMLDivElement>(null)
  useEscapeClose(onClose)

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === backdropRef.current) onClose()
  }, [onClose])

  const romaji = config.romaji ?? {}
  const enabled = config.romajiInput === true
  const caseStyle = romaji.caseStyle ?? 'lower'
  const guideStyles = new Set(romaji.guideStyles ?? [])
  const disabledStyles = new Set(romaji.disabledStyles ?? [])

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

  // hepburn/kunrei are peer base systems, each capable of spelling every
  // kana on its own — but at least one must stay enabled. Clicks are
  // selection-first, not plain toggles: clicking an enabled base while
  // both are on keeps *only* that base (turning the other off — with two
  // bases, "use kunrei alone" is the intent behind clicking Kunrei), an
  // off base joins back in, and the sole enabled base is a no-op.
  const toggleBaseStyle = useCallback((style: RomajiStyle) => {
    const other = BASE_STYLES.find((s) => s !== style)
    if (other === undefined) return
    const next = new Set(disabledStyles)
    if (next.has(style)) next.delete(style)
    else if (!next.has(other)) next.add(other)
    else return
    applyRomaji({ disabledStyles: [...next] })
  }, [disabledStyles, applyRomaji])

  const toggleGuideStyle = useCallback((style: RomajiStyle) => {
    const next = new Set(guideStyles)
    if (next.has(style)) next.delete(style)
    else next.add(style)
    applyRomaji({ guideStyles: [...next] })
  }, [guideStyles, applyRomaji])

  // Guide's Base row is a single select between the two base spelling
  // systems, unlike the input row's Base toggle pair above: the guide only
  // ever shows one representative spelling, so 'kunrei' presence in
  // guideStyles *is* the selection (hepburn is the implicit default and is
  // never itself stored — see pruneRomaji's default table).
  const guideBase: RomajiStyle = guideStyles.has('kunrei') ? 'kunrei' : 'hepburn'
  const selectGuideBase = useCallback((style: RomajiStyle) => {
    const next = new Set(guideStyles)
    if (style === 'kunrei') next.add('kunrei')
    else next.delete('kunrei')
    applyRomaji({ guideStyles: [...next] })
  }, [guideStyles, applyRomaji])

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="dialog"
      aria-labelledby="romaji-settings-title"
      onClick={handleBackdropClick}
      data-testid="romaji-settings-modal"
    >
      <div className={`flex max-h-modal-90vh flex-col ${MODAL_LG} rounded-2xl border border-edge bg-surface-alt shadow-xl`}>
        <div className="flex items-center justify-between border-b border-edge px-4 py-3">
          <h2 id="romaji-settings-title" className="text-lg font-semibold text-content">
            {t('editor.typingTest.romajiSettings.title')}
          </h2>
          <ModalCloseButton testid="romaji-settings-modal-close" onClick={onClose} />
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto p-4">
          {/* Master enable */}
          <ToggleRow
            testid="romaji-settings-enabled"
            label={t('editor.typingTest.romaji.toggle')}
            on={enabled}
            onToggle={() => onConfigChange({ ...config, romajiInput: !enabled })}
          />

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
                  className={optionButtonClass(caseStyle === value, 'px-2.5')}
                  onClick={() => applyRomaji({ caseStyle: value })}
                >
                  {t(`editor.typingTest.romajiSettings.case.${value}`)}
                </button>
              ))}
            </div>
          </section>

          {/* Guide display pattern — same Base/Options row split as
              Accepted input patterns below. Base is a single select
              (exactly one of hepburn/kunrei is always the active
              representative spelling); Options toggle independently and
              may all be off at once. Display only — the guide never
              affects what acceptChar() accepts. */}
          <section className="flex flex-col gap-1.5">
            <span className="text-sm text-content-muted">{t('editor.typingTest.romajiSettings.guideLabel')}:</span>

            <div className="flex flex-col gap-1">
              <span className="text-xs text-content-muted">{t('editor.typingTest.romajiSettings.inputBaseLabel')}:</span>
              <div className={STYLE_GRID_CLASS}>
                {BASE_STYLES.map((style) => (
                  <Tooltip key={style} content={t(`editor.typingTest.romajiSettings.styleTip.${style}`)} side="top" wrapperClassName="w-full" className="max-w-sm">
                    <button
                      type="button"
                      data-testid={`romaji-guide-base-${style}`}
                      aria-pressed={guideBase === style}
                      className={`${optionButtonClass(guideBase === style, 'px-2.5')} w-full justify-center`}
                      onClick={() => selectGuideBase(style)}
                    >
                      {t(`editor.typingTest.romajiSettings.style.${style}`)}
                    </button>
                  </Tooltip>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-xs text-content-muted">{t('editor.typingTest.romajiSettings.inputOptionsLabel')}:</span>
              <div className={STYLE_GRID_CLASS}>
                {OPTION_STYLES.map((style) => (
                  <Tooltip key={style} content={t(`editor.typingTest.romajiSettings.styleTip.${style}`)} side="top" wrapperClassName="w-full" className="max-w-sm">
                    <button
                      type="button"
                      data-testid={`romaji-guide-${style}`}
                      aria-pressed={guideStyles.has(style)}
                      className={`${optionButtonClass(guideStyles.has(style), 'px-2.5')} w-full justify-center`}
                      onClick={() => toggleGuideStyle(style)}
                    >
                      {t(`editor.typingTest.romajiSettings.style.${style}`)}
                    </button>
                  </Tooltip>
                ))}
              </div>
            </div>

            <p className="text-xs text-content-muted">{t('editor.typingTest.romajiSettings.guideHint')}</p>
          </section>

          {/* Accepted input patterns — split into Base (hepburn/kunrei,
              at least one always on) and Options (default all on, may all
              be turned off at once). */}
          <section className="flex flex-col gap-1.5">
            <span className="text-sm text-content-muted">{t('editor.typingTest.romajiSettings.inputLabel')}:</span>

            <div className="flex flex-col gap-1">
              <span className="text-xs text-content-muted">{t('editor.typingTest.romajiSettings.inputBaseLabel')}:</span>
              <div className={STYLE_GRID_CLASS}>
                {BASE_STYLES.map((style) => {
                  const baseEnabled = !disabledStyles.has(style)
                  return (
                    <Tooltip key={style} content={t(`editor.typingTest.romajiSettings.styleTip.${style}`)} side="top" wrapperClassName="w-full" className="max-w-sm">
                      <button
                        type="button"
                        data-testid={`romaji-base-${style}`}
                        aria-pressed={baseEnabled}
                        className={`${optionButtonClass(baseEnabled, 'px-2.5')} w-full justify-center`}
                        onClick={() => toggleBaseStyle(style)}
                      >
                        {t(`editor.typingTest.romajiSettings.style.${style}`)}
                      </button>
                    </Tooltip>
                  )
                })}
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-xs text-content-muted">{t('editor.typingTest.romajiSettings.inputOptionsLabel')}:</span>
              <div className={STYLE_GRID_CLASS}>
                {OPTION_STYLES.map((style) => (
                  <Tooltip key={style} content={t(`editor.typingTest.romajiSettings.styleTip.${style}`)} side="top" wrapperClassName="w-full" className="max-w-sm">
                    <button
                      type="button"
                      data-testid={`romaji-input-${style}`}
                      aria-pressed={!disabledStyles.has(style)}
                      className={`${optionButtonClass(!disabledStyles.has(style), 'px-2.5')} w-full justify-center`}
                      onClick={() => toggleInputStyle(style)}
                    >
                      {t(`editor.typingTest.romajiSettings.style.${style}`)}
                    </button>
                  </Tooltip>
                ))}
              </div>
            </div>

            <p className="text-xs text-content-muted">{t('editor.typingTest.romajiSettings.inputHint')}</p>
          </section>
        </div>
      </div>
    </div>
  )
}
