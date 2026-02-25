// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { KEYBOARD_LAYOUTS } from '../../data/keyboard-layouts'
import type { KeyboardLayoutId } from '../../hooks/useKeyboardLayout'
import type { LayoutOption } from '../../../shared/layout-options'
import { LayoutOptionsPanel } from './LayoutOptionsPanel'
import { ROW_CLASS, toggleTrackClass, toggleKnobClass } from './modal-controls'

type OverlayTab = 'layout' | 'tools' | 'data'

const TAB_BASE = 'flex-1 py-1.5 text-[11px] font-medium transition-colors border-b-2'

function tabClass(active: boolean): string {
  if (active) return `${TAB_BASE} border-b-accent text-content`
  return `${TAB_BASE} border-b-transparent text-content-muted hover:text-content`
}

const ZOOM_BTN = 'rounded border border-edge px-2 py-1 text-xs text-content-secondary hover:text-content hover:bg-surface-dim disabled:opacity-30 disabled:pointer-events-none'

interface Props {
  // Layout options
  hasLayoutOptions: boolean
  layoutOptions?: LayoutOption[]
  layoutValues?: Map<number, number>
  onLayoutOptionChange?: (index: number, value: number) => void
  // Tools
  keyboardLayout: KeyboardLayoutId
  onKeyboardLayoutChange?: (layout: KeyboardLayoutId) => void
  scale: number
  onScaleChange?: (delta: number) => void
  autoAdvance: boolean
  onAutoAdvanceChange?: (enabled: boolean) => void
  basicViewType?: 'list' | 'keyboard'
  onBasicViewTypeChange?: (type: 'list' | 'keyboard') => void
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
}

export function KeycodesOverlayPanel({
  hasLayoutOptions,
  layoutOptions,
  layoutValues,
  onLayoutOptionChange,
  keyboardLayout,
  onKeyboardLayoutChange,
  scale,
  onScaleChange,
  autoAdvance,
  onAutoAdvanceChange,
  basicViewType,
  onBasicViewTypeChange,
  matrixMode,
  hasMatrixTester,
  onToggleMatrix,
  unlocked,
  onLock,
  isDummy,
  toolsExtra,
  dataPanel,
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
            className={`col-start-1 row-start-1 overflow-y-auto ${activeTab !== 'layout' ? 'invisible' : ''}`}
            inert={activeTab !== 'layout' || undefined}
          >
            <LayoutOptionsPanel
              options={layoutOptions}
              values={layoutValues}
              onChange={onLayoutOptionChange}
            />
          </div>
        )}

        <div
          className={`col-start-1 row-start-1 overflow-y-auto ${activeTab !== 'tools' ? 'invisible' : ''}`}
          inert={activeTab !== 'tools' || undefined}
        >
          <div className="flex flex-col gap-2 px-4 py-3">
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

            {/* Zoom controls */}
            <div className={ROW_CLASS} data-testid="overlay-zoom-row">
              <span className="text-[13px] font-medium text-content">
                {t('editor.keymap.zoomLabel')}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid="overlay-zoom-out"
                  aria-label={t('editor.keymap.zoomOut')}
                  className={ZOOM_BTN}
                  disabled={scale <= 0.3}
                  onClick={() => onScaleChange?.(-0.1)}
                >
                  &minus;
                </button>
                <span className="min-w-[3ch] text-center text-[13px] tabular-nums text-content-secondary" data-testid="overlay-zoom-value">
                  {Math.round(scale * 100)}%
                </span>
                <button
                  type="button"
                  data-testid="overlay-zoom-in"
                  aria-label={t('editor.keymap.zoomIn')}
                  className={ZOOM_BTN}
                  disabled={scale >= 2.0}
                  onClick={() => onScaleChange?.(0.1)}
                >
                  +
                </button>
              </div>
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

            {/* Basic tab view type */}
            {basicViewType != null && onBasicViewTypeChange && (
              <div className={ROW_CLASS} data-testid="overlay-basic-view-type-row">
                <label htmlFor="overlay-basic-view-type-selector" className="text-[13px] font-medium text-content">
                  {t('editorSettings.basicViewType')}
                </label>
                <select
                  id="overlay-basic-view-type-selector"
                  value={basicViewType}
                  onChange={(e) => onBasicViewTypeChange(e.target.value as 'list' | 'keyboard')}
                  className="rounded border border-edge bg-surface px-2.5 py-1.5 text-[13px] text-content focus:border-accent focus:outline-none"
                  data-testid="overlay-basic-view-type-selector"
                >
                  <option value="ansi">{t('settings.basicViewTypeAnsi')}</option>
                  <option value="iso">{t('settings.basicViewTypeIso')}</option>
                  <option value="list">{t('settings.basicViewTypeList')}</option>
                </select>
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
                <div className="flex flex-col gap-0.5">
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
