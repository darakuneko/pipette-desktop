// SPDX-License-Identifier: GPL-2.0-or-later

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronsLeft, ChevronsRight } from 'lucide-react'
import { ICON_SM } from '../../constants/ui-tokens'
import { TypingTestSettingsBar } from '../../typing-test/TypingTestSettingsBar'
import { LanguageSelectorModal } from '../../typing-test/LanguageSelectorModal'
import { isRomajiCapable, carryRomajiFields } from '../../typing-test/romaji-input'
import { HistoryToggle } from './HistoryToggle'
import { ComparisonToggle } from './ComparisonToggle'
import type { TypingTestResult, TypingTestComparisonBaseline, PooledTypingTestResult } from '../../../shared/types/pipette-settings'
import type { TypingTestConfig } from '../../typing-test/types'
import { DEFAULT_CONFIG, DEFAULT_LANGUAGE, DEFAULT_DISPLAY_LINES, DEFAULT_FONT_SIZE, DISPLAY_LINES_MIN, DISPLAY_LINES_MAX, FONT_OPTIONS } from '../../typing-test/types'
import type { useTypingTest } from '../../typing-test/useTypingTest'
import { ToggleRow } from './modal-controls'
import { PANEL_COLLAPSED_WIDTH } from './keymap-editor-types'
import type { TimelineHandoff } from '../../hooks/useRunTimelineHandoff'
import { Tooltip } from '../ui/Tooltip'

const LINE_OPTIONS = Array.from({ length: DISPLAY_LINES_MAX - DISPLAY_LINES_MIN + 1 }, (_, i) => DISPLAY_LINES_MIN + i)

/** Labelled group inside the left config panel — a small heading with an
 *  underline divider, then its controls (kept at natural width). */
function PanelSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex w-full flex-col items-start gap-2">
      <h3 className="w-full border-b border-edge pb-1 text-xs font-semibold uppercase tracking-wide text-content-muted">
        {title}
      </h3>
      {children}
    </section>
  )
}

interface TypingTestPaneSettingsPanelProps {
  typingTest: ReturnType<typeof useTypingTest>
  /** Language selector modal open state — lifted to TypingTestPane so it
   *  survives this panel unmounting/remounting across editor <-> view-only
   *  transitions (the panel itself is unmounted while view-only). */
  showLanguageModal: boolean
  onShowLanguageModal: (open: boolean) => void
  onConfigChange: (config: TypingTestConfig) => void
  monkeytypeConfig?: TypingTestConfig
  onLanguageChange: (lang: string) => Promise<void>
  layers: number
  layerNames?: string[]
  typingTestHistory?: TypingTestResult[]
  deviceName?: string
  displayLines?: number
  fontSize?: number
  onDisplayLinesChange?: (lines: number) => void
  onFontSizeChange?: (px: number) => void
  hideKeymap?: boolean
  hideStatsRow?: boolean
  hideControls?: boolean
  onToggleHideKeymap?: (hidden: boolean) => void
  onToggleHideStatsRow?: (hidden: boolean) => void
  onToggleHideControls?: (hidden: boolean) => void
  saveUnnamed: boolean
  onToggleSaveUnnamed?: (enabled: boolean) => void
  settingsPanelOpen: boolean
  onToggleSettingsPanel?: (open: boolean) => void
  onRenameTypingTestResult?: (date: string, name: string) => void
  onDeleteTypingTestResult?: (date: string) => void
  keyboardUid?: string
  timelineHandoff?: TimelineHandoff | null
  sameConditionResults: PooledTypingTestResult[]
  comparisonBaselineValue: TypingTestComparisonBaseline
  handleComparisonChange: (baseline: TypingTestComparisonBaseline) => void
}

/** Editor-mode left config sidebar (Settings / Data / View sections),
 *  split out of TypingTestPane (file-splitting.md cap) — see
 *  Task-split-typing-test-pane.md. Rendered only in editor mode — the
 *  caller keeps the `{!viewOnly && ...}` guard, this component always
 *  renders its content. */
export function TypingTestPaneSettingsPanel({
  typingTest,
  showLanguageModal,
  onShowLanguageModal,
  onConfigChange,
  monkeytypeConfig,
  onLanguageChange,
  layers,
  layerNames,
  typingTestHistory,
  deviceName,
  displayLines,
  fontSize,
  onDisplayLinesChange,
  onFontSizeChange,
  hideKeymap,
  hideStatsRow,
  hideControls,
  onToggleHideKeymap,
  onToggleHideStatsRow,
  onToggleHideControls,
  saveUnnamed,
  onToggleSaveUnnamed,
  settingsPanelOpen,
  onToggleSettingsPanel,
  onRenameTypingTestResult,
  onDeleteTypingTestResult,
  keyboardUid,
  timelineHandoff,
  sameConditionResults,
  comparisonBaselineValue,
  handleComparisonChange,
}: TypingTestPaneSettingsPanelProps) {
  const { t } = useTranslation()

  // Data Source / language. The mode kind (FileImport / Normal) goes in the label —
  // "Data Source(FileImport)" — and the button shows just the source (file name or
  // language), truncated to one line; the full text is on the title.
  let modeType: string
  if (typingTest.config.mode === 'fileImport') {
    modeType = t('editor.typingTest.language.tabFileImport')
  } else if (typingTest.config.mode === 'tatoeba') {
    modeType = t('editor.typingTest.language.tabTatoeba')
  } else {
    modeType = t('editor.typingTest.language.tabMonkeytype')
  }
  let modeLabel: string
  if (typingTest.isLanguageLoading) {
    modeLabel = t('editor.typingTest.language.loadingLanguage')
  } else if (typingTest.config.mode === 'fileImport') {
    modeLabel = typingTest.state.currentQuote?.source ?? t('editor.typingTest.language.fileImportText')
  } else if (typingTest.config.mode === 'tatoeba') {
    modeLabel = typingTest.config.language.replace(/_/g, ' ')
  } else {
    modeLabel = typingTest.language.replace(/_/g, ' ')
  }

  // Config controls, pinned to the window's top-left as a sidebar in editor
  // mode (view-only has no config UI). Lifted out of the keymap row so it sits
  // at the top-left instead of beside the centred keyboard.
  // Left Settings pane — collapsible like the keymap editor's LayerListPanel.
  // The outer box clips + transitions width; the content keeps its full width
  // and is hidden when collapsed (only the toggle rail remains).
  const settingsCollapsed = !settingsPanelOpen
  return (
    <div
      className="flex shrink-0 flex-col self-stretch overflow-hidden rounded-xl border border-edge bg-picker-bg transition-width duration-200 ease-out"
      style={{ width: settingsCollapsed ? PANEL_COLLAPSED_WIDTH : '18rem' }}
      data-testid={settingsCollapsed ? 'typing-settings-panel-collapsed' : 'typing-settings-panel'}
    >
      {!settingsCollapsed && (
      <div className="flex min-h-0 w-72 flex-1 flex-col gap-4 overflow-y-auto p-3">
      {/* Settings — language/mode, base layer, pattern / units / options. */}
      <PanelSection title={t('editor.typingTest.section.settings')}>
        {/* Mode / language — shown for every mode (words / time / quote /
            fileImport); quote uses it to pick the quote source language. */}
        <div className="flex w-full flex-col items-start gap-1">
          <span className="text-sm text-content-muted">{t('editor.typingTest.modeLabel')}({modeType})</span>
          <Tooltip content={modeLabel} wrapperClassName="w-full">
            <button
              type="button"
              data-testid="language-selector"
              className="flex h-8 w-full items-center rounded-md border border-edge px-2.5 text-sm text-content-secondary transition-colors hover:text-content"
              onClick={() => onShowLanguageModal(true)}
              disabled={typingTest.isLanguageLoading}
            >
              <span className="truncate">{modeLabel}</span>
            </button>
          </Tooltip>
        </div>
        {showLanguageModal && (
          <LanguageSelectorModal
            currentLanguage={typingTest.language}
            currentFileImportTextId={typingTest.config.mode === 'fileImport' ? typingTest.config.textId : undefined}
            currentTatoebaLanguage={typingTest.config.mode === 'tatoeba' ? typingTest.config.language : undefined}
            onSelectLanguage={(name) => {
              // Picking a MonkeyType language leaves fileImport / tatoeba mode —
              // restore the last normal (words/time/quote) config so its
              // Pattern/Units/Option settings survive the round trip; fall back
              // to the default if none saved.
              if (typingTest.config.mode === 'fileImport' || typingTest.config.mode === 'tatoeba') {
                onConfigChange(monkeytypeConfig ?? DEFAULT_CONFIG)
              }
              void onLanguageChange(name)
            }}
            onSelectImport={(textId) => onConfigChange({ mode: 'fileImport', textId, ...carryRomajiFields(typingTest.config) })}
            onSelectTatoeba={(language) => {
              // Carry the previous tatoeba Pattern/Units forward (switching
              // pack language shouldn't reset Lines/Time or their counts);
              // default to Lines/5/30 when not already in tatoeba mode.
              const cfg = typingTest.config
              const { pattern, lineCount, duration } = cfg.mode === 'tatoeba'
                ? cfg
                : { pattern: 'lines' as const, lineCount: 5, duration: 30 }
              onConfigChange({ mode: 'tatoeba', language, pattern, lineCount, duration, ...carryRomajiFields(cfg) })
            }}
            onCurrentTextDeleted={() => {
              // The selected imported text was deleted — fall back to
              // the default (words mode, English).
              onConfigChange(DEFAULT_CONFIG)
              void onLanguageChange(DEFAULT_LANGUAGE)
            }}
            onClose={() => onShowLanguageModal(false)}
          />
        )}
        {/* Base Layer / Lines / Font side by side. Lines + Font are the shared
            reading-window display settings (every mode); wraps if too narrow. */}
        <div className="flex w-full items-start gap-2">
          {layers > 1 && (
            <div className="flex flex-1 flex-col items-start gap-1">
              <span className="text-sm text-content-muted">{t('editor.typingTest.baseLayer')}</span>
              <select
                data-testid="base-layer-select"
                aria-label={t('editor.typingTest.baseLayer')}
                value={typingTest.baseLayer}
                onChange={(e) => typingTest.setBaseLayer(Number(e.target.value))}
                className="h-8 w-full rounded-md border border-edge bg-surface-alt px-2 text-sm text-content-secondary focus:border-accent focus:outline-none"
              >
                {Array.from({ length: layers }, (_, i) => (
                  <option key={i} value={i}>{layerNames?.[i] || i}</option>
                ))}
              </select>
            </div>
          )}
          <div className="flex flex-1 flex-col items-start gap-1">
            <span className="text-sm text-content-muted">{t('editor.typingTest.lines')}</span>
            <select
              data-testid="display-lines-select"
              aria-label={t('editor.typingTest.lines')}
              value={displayLines ?? DEFAULT_DISPLAY_LINES}
              onChange={(e) => onDisplayLinesChange?.(Number(e.target.value))}
              className="h-8 w-full rounded-md border border-edge bg-surface-alt px-2 text-sm text-content-secondary focus:border-accent focus:outline-none"
            >
              {LINE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <div className="flex flex-1 flex-col items-start gap-1">
            <span className="text-sm text-content-muted">{t('editor.typingTest.fontSize')}</span>
            <select
              data-testid="font-size-select"
              aria-label={t('editor.typingTest.fontSize')}
              value={fontSize ?? DEFAULT_FONT_SIZE}
              onChange={(e) => onFontSizeChange?.(Number(e.target.value))}
              className="h-8 w-full rounded-md border border-edge bg-surface-alt px-2 text-sm text-content-secondary focus:border-accent focus:outline-none"
            >
              {FONT_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        </div>
        {/* words/time/quote/tatoeba always get the full bar (tatoeba has its
            own Pattern/Units, see TypingTestSettingsBar); fileImport only
            gets it (Option row only) once its content is actually
            romaji-capable — otherwise there is nothing for the bar to show,
            same as before this mode's romaji support. */}
        {(typingTest.config.mode !== 'fileImport'
          || isRomajiCapable(typingTest.config, typingTest.language, typingTest.state.romajiCapable)) && (
          <TypingTestSettingsBar
            config={typingTest.config}
            onConfigChange={onConfigChange}
            language={typingTest.language}
            textRomajiCapable={typingTest.state.romajiCapable}
            weakSpotGate={typingTest.weakSpotGate}
          />
        )}
      </PanelSection>

      {/* Data — saved run history + comparison baseline settings. Always shown
          (even with no saved results yet) so History stays reachable and the
          comparison baseline can be set up before the first result. */}
      <PanelSection title={t('editor.typingTest.section.data')}>
        <HistoryToggle
          results={typingTestHistory ?? []}
          deviceName={deviceName}
          onRename={onRenameTypingTestResult}
          onDelete={onDeleteTypingTestResult}
          uid={keyboardUid}
          timelineHandoff={timelineHandoff}
        />
        <ComparisonToggle
          pool={sameConditionResults}
          baseline={comparisonBaselineValue}
          onChange={handleComparisonChange}
        />
        {/* Save Unnamed — when on (default), a finished result is auto-saved
            even without a name; when off, only named results are kept. */}
        <ToggleRow
          testid="typing-test-toggle-save-unnamed"
          label={t('editor.typingTest.saveUnnamedToggle')}
          on={saveUnnamed}
          onToggle={() => onToggleSaveUnnamed?.(!saveUnnamed)}
          title={t(saveUnnamed ? 'editor.typingTest.disableSaveUnnamed' : 'editor.typingTest.enableSaveUnnamed')}
        />
      </PanelSection>

      {/* View — toggles ordered top-to-bottom to match the editor layout:
          operation (controls row) → measurement (stats row) → keymap pane.
          The switch is on when the section is visible. */}
      <PanelSection title={t('editor.typingTest.section.view')}>
        <ToggleRow
          testid="typing-test-toggle-controls"
          label={t('editor.typingTest.controlsToggle')}
          on={!hideControls}
          onToggle={() => onToggleHideControls?.(!hideControls)}
          title={t(hideControls ? 'editor.typingTest.showControls' : 'editor.typingTest.hideControls')}
        />
        <ToggleRow
          testid="typing-test-toggle-stats"
          label={t('editor.typingTest.statsToggle')}
          on={!hideStatsRow}
          onToggle={() => onToggleHideStatsRow?.(!hideStatsRow)}
          title={t(hideStatsRow ? 'editor.typingTest.showStats' : 'editor.typingTest.hideStats')}
        />
        <ToggleRow
          testid="typing-test-toggle-keymap"
          label={t('editor.typingTest.keymapToggle')}
          on={!hideKeymap}
          onToggle={() => onToggleHideKeymap?.(!hideKeymap)}
          title={t(hideKeymap ? 'editor.typingTest.showKeymap' : 'editor.typingTest.hideKeymap')}
        />
      </PanelSection>
      </div>
      )}
      {/* Collapse / expand toggle — pinned to the bottom (mt-auto). */}
      <div className="mt-auto shrink-0 border-t border-edge p-2">
        <Tooltip content={t(settingsCollapsed ? 'editor.typingTest.expandSettings' : 'editor.typingTest.collapseSettings')}>
          <button
            type="button"
            data-testid="typing-settings-panel-toggle"
            aria-label={t(settingsCollapsed ? 'editor.typingTest.expandSettings' : 'editor.typingTest.collapseSettings')}
            className="flex items-center justify-center rounded-md p-1 text-content-muted transition-colors hover:bg-surface-dim hover:text-content"
            onClick={() => onToggleSettingsPanel?.(settingsCollapsed)}
          >
            {settingsCollapsed ? <ChevronsRight size={ICON_SM} aria-hidden="true" /> : <ChevronsLeft size={ICON_SM} aria-hidden="true" />}
          </button>
        </Tooltip>
      </div>
    </div>
  )
}
