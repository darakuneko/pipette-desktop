// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { SplitKeyMode } from '../../../shared/types/app-config'
import { ZOOM_FACTOR_MIN, ZOOM_FACTOR_MAX, clampZoomFactor } from '../../../shared/types/app-config'
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
  autoAdvance: boolean
  onAutoAdvanceChange?: (enabled: boolean) => void
  splitKeyMode?: SplitKeyMode
  onSplitKeyModeChange?: (mode: SplitKeyMode) => void
  quickSelect?: boolean
  onQuickSelectChange?: (enabled: boolean) => void
  matrixMode: boolean
  hasMatrixTester: boolean
  onToggleMatrix?: () => void
  unlocked: boolean
  onLock?: () => void
  isDummy?: boolean
  keyEditorZoom?: number
  onKeyEditorZoomChange?: (zoom: number) => void
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
  autoAdvance,
  onAutoAdvanceChange,
  splitKeyMode,
  onSplitKeyModeChange,
  quickSelect,
  onQuickSelectChange,
  matrixMode,
  hasMatrixTester,
  onToggleMatrix,
  unlocked,
  onLock,
  isDummy,
  keyEditorZoom,
  onKeyEditorZoomChange,
  toolsExtra,
  dataPanel,
  onExportLayoutPdfAll,
  onExportLayoutPdfCurrent,
}: Props) {
  const { t } = useTranslation()
  const [zoomInput, setZoomInput] = useState(String(keyEditorZoom ?? ''))
  useEffect(() => {
    setZoomInput(String(keyEditorZoom ?? ''))
  }, [keyEditorZoom])
  const commitZoom = (val = zoomInput): void => {
    const raw = Number(val)
    if (!Number.isNaN(raw) && onKeyEditorZoomChange) {
      const clamped = clampZoomFactor(raw)
      setZoomInput(String(clamped))
      onKeyEditorZoomChange(clamped)
    } else {
      setZoomInput(String(keyEditorZoom ?? ''))
    }
  }
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
            {/* Key editor zoom */}
            {onKeyEditorZoomChange && (
              <div className={ROW_CLASS} data-testid="overlay-key-editor-zoom-row">
                <div className="flex flex-col gap-0.5">
                  <span className="text-[13px] font-medium text-content">
                    {t('editorSettings.keyEditorZoom')}
                  </span>
                  <span className="text-xs text-content-muted">
                    {t('settings.zoomLevelWarning')}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min={ZOOM_FACTOR_MIN}
                    max={ZOOM_FACTOR_MAX}
                    value={zoomInput}
                    onChange={(e) => { setZoomInput(e.target.value) }}
                    onBlur={() => commitZoom()}
                    onKeyDown={(e) => e.key === 'Enter' && commitZoom()}
                    className="zoom-factor-input w-16 rounded border border-edge bg-surface pl-2 pr-1 py-0.5 text-xs text-content text-right"
                    aria-label={t('editorSettings.keyEditorZoom')}
                    data-testid="overlay-key-editor-zoom-input"
                  />
                  <span className="text-xs text-content-muted">%</span>
                </div>
              </div>
            )}

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

            {/* Quick select toggle */}
            {quickSelect != null && onQuickSelectChange && (
              <div className={ROW_CLASS} data-testid="overlay-quick-select-row">
                <span className="text-[13px] font-medium text-content">
                  {t('editorSettings.quickSelect')}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={quickSelect}
                  aria-label={t('editorSettings.quickSelect')}
                  className={toggleTrackClass(quickSelect)}
                  onClick={() => onQuickSelectChange(!quickSelect)}
                  data-testid="overlay-quick-select-toggle"
                >
                  <span className={toggleKnobClass(quickSelect)} />
                </button>
              </div>
            )}

            {/* Key tester toggle */}
            {(hasMatrixTester || matrixMode) && onToggleMatrix && (
              <div className={ROW_CLASS} data-testid="overlay-matrix-row">
                <span className="text-[13px] font-medium text-content">
                  {t('editor.keyTester.title')}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={matrixMode}
                  aria-label={t('editor.keyTester.title')}
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
