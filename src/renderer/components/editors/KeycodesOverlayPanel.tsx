// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { KEYBOARD_LAYOUTS } from '../../data/keyboard-layouts'
import type { KeyboardLayoutId } from '../../hooks/useKeyboardLayout'
import type { BasicViewType, SplitKeyMode } from '../../../shared/types/app-config'
import type { LayoutOption } from '../../../shared/layout-options'
import { LayoutOptionsPanel } from './LayoutOptionsPanel'
import { ROW_CLASS, toggleTrackClass, toggleKnobClass } from './modal-controls'

type OverlayTab = 'layout' | 'tools' | 'data'

const TAB_BASE = 'flex-1 py-1.5 text-[11px] font-medium transition-colors border-b-2'
const FOOTER_BTN = 'rounded border border-edge px-2.5 py-1 text-[11px] text-content-secondary hover:text-content hover:bg-surface-dim transition-colors'

function tabClass(active: boolean): string {
  if (active) return `${TAB_BASE} border-b-accent text-content`
  return `${TAB_BASE} border-b-transparent text-content-muted hover:text-content`
}


interface Props {
  // Layout options
  hasLayoutOptions: boolean
  layoutOptions?: LayoutOption[]
  layoutValues?: Map<number, number>
  onLayoutOptionChange?: (index: number, value: number) => void
  // Tools
  keyboardLayout: KeyboardLayoutId
  onKeyboardLayoutChange?: (layout: KeyboardLayoutId) => void
  autoAdvance: boolean
  onAutoAdvanceChange?: (enabled: boolean) => void
  basicViewType?: BasicViewType
  onBasicViewTypeChange?: (type: BasicViewType) => void
  splitKeyMode?: SplitKeyMode
  onSplitKeyModeChange?: (mode: SplitKeyMode) => void
  matrixMode: boolean
  hasMatrixTester: boolean
  onToggleMatrix?: () => void
  unlocked: boolean
  onLock?: () => void
  isDummy?: boolean
  // Extra content appended to Tools tab (e.g. Import, Reset)
  toolsExtra?: React.ReactNode
  // Save tab (formerly Data)
  dataPanel?: React.ReactNode
  // Layout PDF export callbacks
  onExportLayoutPdfAll?: () => void
  onExportLayoutPdfCurrent?: () => void
}

export function KeycodesOverlayPanel({
  hasLayoutOptions,
  layoutOptions,
  layoutValues,
  onLayoutOptionChange,
  keyboardLayout,
  onKeyboardLayoutChange,
  autoAdvance,
  onAutoAdvanceChange,
  basicViewType,
  onBasicViewTypeChange,
  splitKeyMode,
  onSplitKeyModeChange,
  matrixMode,
  hasMatrixTester,
  onToggleMatrix,
  unlocked,
  onLock,
  isDummy,
  toolsExtra,
  dataPanel,
  onExportLayoutPdfAll,
  onExportLayoutPdfCurrent,
}: Props) {
  const { t } = useTranslation()
  const hasData = dataPanel != null
  const [activeTab, setActiveTab] = useState<OverlayTab>(hasLayoutOptions ? 'layout' : hasData ? 'data' : 'tools')

  // Reset to next leftmost tab if current tab disappears at runtime
  useEffect(() => {
    if (!hasLayoutOptions && activeTab === 'layout') {
      setActiveTab(hasData ? 'data' : 'tools')
    }
  }, [hasLayoutOptions, hasData, activeTab])

  const tabs = useMemo<{ id: OverlayTab; labelKey: string }[]>(() => {
    const result: { id: OverlayTab; labelKey: string }[] = []
    if (hasLayoutOptions) result.push({ id: 'layout', labelKey: 'editorSettings.tabLayout' })
    if (hasData) result.push({ id: 'data', labelKey: 'editorSettings.tabSave' })
    result.push({ id: 'tools', labelKey: 'editorSettings.tabTools' })
    return result
  }, [hasLayoutOptions, hasData])

  const showTabs = tabs.length > 1

  return (
    <div className="flex h-full flex-col" data-testid="keycodes-overlay-panel">
      {/* Top tab bar */}
      {showTabs && (
        <div role="tablist" className="flex border-b border-edge shrink-0" data-testid="overlay-tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              id={`overlay-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              aria-controls={activeTab === tab.id ? `overlay-panel-${tab.id}` : undefined}
              className={tabClass(activeTab === tab.id)}
              onClick={() => setActiveTab(tab.id)}
              data-testid={`overlay-tab-${tab.id}`}
            >
              {t(tab.labelKey)}
            </button>
          ))}
        </div>
      )}

      {/* Content area — grid overlay keeps both tabs in DOM for stable width */}
      <div className="flex-1 grid min-h-0">
        {hasLayoutOptions && layoutOptions && layoutValues && onLayoutOptionChange && (
          <div
            className={`col-start-1 row-start-1 flex flex-col min-h-0 ${activeTab !== 'layout' ? 'invisible' : ''}`}
            inert={activeTab !== 'layout' || undefined}
          >
            <div className="flex-1 overflow-y-auto">
              <LayoutOptionsPanel
                options={layoutOptions}
                values={layoutValues}
                onChange={onLayoutOptionChange}
              />
            </div>
            {(onExportLayoutPdfAll || onExportLayoutPdfCurrent) && (
              <div className="shrink-0 border-t border-edge px-4 py-2 flex items-center gap-2" data-testid="layout-pdf-footer">
                <span className="text-[11px] text-content-muted">{t('layout.pdfFooterLabel')}</span>
                {onExportLayoutPdfAll && (
                  <button
                    type="button"
                    className={FOOTER_BTN}
                    onClick={onExportLayoutPdfAll}
                    data-testid="layout-pdf-all-button"
                  >
                    {t('layout.exportAllPdf')}
                  </button>
                )}
                {onExportLayoutPdfCurrent && (
                  <button
                    type="button"
                    className={FOOTER_BTN}
                    onClick={onExportLayoutPdfCurrent}
                    data-testid="layout-pdf-current-button"
                  >
                    {t('layout.exportCurrentPdf')}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        <div
          className={`col-start-1 row-start-1 overflow-y-auto ${activeTab !== 'tools' ? 'invisible' : ''}`}
          inert={activeTab !== 'tools' || undefined}
        >
          <div className="flex flex-col gap-2 px-4 py-3">
            {/* Basic tab view type */}
            {basicViewType != null && onBasicViewTypeChange && (
              <div className={ROW_CLASS} data-testid="overlay-basic-view-type-row">
                <label htmlFor="overlay-basic-view-type-selector" className="text-[13px] font-medium text-content">
                  {t('editorSettings.basicViewType')}
                </label>
                <select
                  id="overlay-basic-view-type-selector"
                  value={basicViewType}
                  onChange={(e) => onBasicViewTypeChange(e.target.value as BasicViewType)}
                  className="rounded border border-edge bg-surface px-2.5 py-1.5 text-[13px] text-content focus:border-accent focus:outline-none"
                  data-testid="overlay-basic-view-type-selector"
                >
                  <option value="ansi">{t('settings.basicViewTypeAnsi')}</option>
                  <option value="iso">{t('settings.basicViewTypeIso')}</option>
                  <option value="list">{t('settings.basicViewTypeList')}</option>
                </select>
              </div>
            )}

            {/* Keyboard layout selector */}
            <div className={ROW_CLASS} data-testid="overlay-layout-row">
              <label htmlFor="overlay-layout-selector" className="text-[13px] font-medium text-content">
                {t('layout.keyboardLayout')}
              </label>
              <select
                id="overlay-layout-selector"
                value={keyboardLayout}
                onChange={(e) => onKeyboardLayoutChange?.(e.target.value as KeyboardLayoutId)}
                className="rounded border border-edge bg-surface px-2.5 py-1.5 text-[13px] text-content focus:border-accent focus:outline-none"
                data-testid="overlay-layout-selector"
              >
                {KEYBOARD_LAYOUTS.map((layoutDef) => (
                  <option key={layoutDef.id} value={layoutDef.id}>
                    {layoutDef.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Auto-advance toggle */}
            <div className={ROW_CLASS} data-testid="overlay-auto-advance-row">
              <span className="text-[13px] font-medium text-content">
                {t('editor.autoAdvance')}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={autoAdvance}
                aria-label={t('editor.autoAdvance')}
                className={toggleTrackClass(autoAdvance)}
                onClick={() => onAutoAdvanceChange?.(!autoAdvance)}
                data-testid="overlay-auto-advance-toggle"
              >
                <span className={toggleKnobClass(autoAdvance)} />
              </button>
            </div>

            {/* Split key toggle */}
            {splitKeyMode != null && onSplitKeyModeChange && (
              <div className={ROW_CLASS} data-testid="overlay-split-key-mode-row">
                <span className="text-[13px] font-medium text-content">
                  {t('editorSettings.splitKeyMode')}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={splitKeyMode === 'split'}
                  aria-label={t('editorSettings.splitKeyMode')}
                  className={toggleTrackClass(splitKeyMode === 'split')}
                  onClick={() => onSplitKeyModeChange(splitKeyMode === 'split' ? 'flat' : 'split')}
                  data-testid="overlay-split-key-mode-toggle"
                >
                  <span className={toggleKnobClass(splitKeyMode === 'split')} />
                </button>
              </div>
            )}

            {/* Key tester toggle */}
            {(hasMatrixTester || matrixMode) && onToggleMatrix && (
              <div className={ROW_CLASS} data-testid="overlay-matrix-row">
                <span className="text-[13px] font-medium text-content">
                  {t('editor.matrixTester.title')}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={matrixMode}
                  aria-label={t('editor.matrixTester.title')}
                  className={toggleTrackClass(matrixMode)}
                  onClick={onToggleMatrix}
                  data-testid="overlay-matrix-toggle"
                >
                  <span className={toggleKnobClass(matrixMode)} />
                </button>
              </div>
            )}

            {/* Lock button + status */}
            {!isDummy && (
              <div className={ROW_CLASS} data-testid="overlay-lock-row">
                <div className="flex items-center gap-1.5">
                  <span className="text-[13px] font-medium text-content">
                    {t('settings.security')}
                  </span>
                  <span
                    className={`text-xs ${unlocked ? 'text-warning' : 'text-accent'}`}
                    data-testid="overlay-lock-status"
                  >
                    {unlocked ? t('statusBar.unlocked') : t('statusBar.locked')}
                  </span>
                </div>
                <button
                  type="button"
                  disabled={!unlocked}
                  className={`rounded border border-edge px-3 py-1 text-sm ${unlocked ? 'text-content-secondary hover:bg-surface-dim' : 'text-content-muted opacity-50'}`}
                  onClick={onLock}
                  data-testid="overlay-lock-button"
                >
                  {t('security.lock')}
                </button>
              </div>
            )}

            {toolsExtra}
          </div>
        </div>

        {hasData && (
          <div
            className={`col-start-1 row-start-1 overflow-y-auto ${activeTab !== 'data' ? 'invisible' : ''}`}
            inert={activeTab !== 'data' || undefined}
            data-testid="overlay-data-panel"
          >
            {dataPanel}
          </div>
        )}
      </div>
    </div>
  )
}
