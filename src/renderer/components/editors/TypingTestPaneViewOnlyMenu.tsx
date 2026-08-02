// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
import { TYPING_HEATMAP_WINDOW_OPTIONS } from '../../../shared/types/app-config'
import type { TypingViewMenuTab } from '../../../shared/types/pipette-settings'
import { BTN_TOGGLE_ACTIVE, BTN_TOGGLE_INACTIVE } from '../../constants/ui-tokens'
import type { useTypingTest } from '../../typing-test/useTypingTest'
import type { AnalyticsOrigin } from './keymap-editor-types'

interface TypingTestPaneViewOnlyMenuProps {
  typingTest: ReturnType<typeof useTypingTest>
  mouseOver: boolean
  viewOnlyControlsOpen: boolean
  setViewOnlyControlsOpen: (open: boolean) => void
  menuTab: TypingViewMenuTab
  onMenuTabChange?: (tab: TypingViewMenuTab) => void
  getDefaultCompactSize: () => { width: number; height: number }
  onViewOnlyWindowSizeChange?: (size: { width: number; height: number }) => void
  alwaysOnTopSupported: boolean
  viewOnlyAlwaysOnTop?: boolean
  onViewOnlyAlwaysOnTopChange?: (enabled: boolean) => void
  recordEnabled?: boolean
  onRecordEnabledChange?: (enabled: boolean) => void
  handleRecordToggle: () => void
  monitorAppEnabled?: boolean
  onMonitorAppEnabledChange?: (enabled: boolean) => void
  trayResident?: boolean
  onTrayResidentChange?: (enabled: boolean) => void
  handleTrayResidentToggle: () => void
  startInTray?: boolean
  onStartInTrayChange?: (enabled: boolean) => void
  onViewAnalytics?: (origin: AnalyticsOrigin) => void
  heatmapWindowMin?: number
  onHeatmapWindowMinChange?: (minutes: number) => void
  layers: number
  layerNames?: string[]
  onViewOnlyChange?: (enabled: boolean) => void
  handleViewOnlyToggle: () => void
}

/** View-only mode's fixed bottom-right menu (hint bar + tab panel), split
 *  out of TypingTestPane (file-splitting.md cap) — see
 *  Task-split-typing-test-pane.md. Renders a bare fragment: the two fixed
 *  divs must stay siblings in source order (z-40 hint under z-50 panel). */
export function TypingTestPaneViewOnlyMenu({
  typingTest,
  mouseOver,
  viewOnlyControlsOpen,
  setViewOnlyControlsOpen,
  menuTab,
  onMenuTabChange,
  getDefaultCompactSize,
  onViewOnlyWindowSizeChange,
  alwaysOnTopSupported,
  viewOnlyAlwaysOnTop,
  onViewOnlyAlwaysOnTopChange,
  recordEnabled,
  onRecordEnabledChange,
  handleRecordToggle,
  monitorAppEnabled,
  onMonitorAppEnabledChange,
  trayResident,
  onTrayResidentChange,
  handleTrayResidentToggle,
  startInTray,
  onStartInTrayChange,
  onViewAnalytics,
  heatmapWindowMin,
  onHeatmapWindowMinChange,
  layers,
  layerNames,
  onViewOnlyChange,
  handleViewOnlyToggle,
}: TypingTestPaneViewOnlyMenuProps) {
  const { t } = useTranslation()

  return (
    <>
    <div
      className={`pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center py-1 transition-opacity duration-200 ${viewOnlyControlsOpen || (!mouseOver && !recordEnabled) ? 'opacity-0' : 'opacity-100'}`}
    >
      <span className={`text-2xs ${!mouseOver && recordEnabled ? 'text-accent' : 'text-content-muted'}`}>
        {mouseOver
          ? t('editor.typingTest.closeHint')
          : t('editor.typingTest.recordingIndicator')}
      </span>
    </div>
    <div className="fixed bottom-0 right-0 z-50">
      <div
        id="view-only-panel"
        role="menu"
        className={`absolute bottom-0 right-0 flex flex-col gap-1.5 rounded-tl-lg bg-surface-alt/95 px-3 pt-3 pb-2 text-xs shadow-lg backdrop-blur-sm transition-all duration-200 ease-out ${viewOnlyControlsOpen ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-full overflow-hidden opacity-0'}`}
        onClick={(e) => e.stopPropagation()}
        {...(!viewOnlyControlsOpen && { inert: '' } as Record<string, string>)}
      >
        {/* Tab row — Window (sizing + always-on-top) / REC
            (recording toggle + analytics entry) / Monitor App
            (active-app capture toggle). The active tab is
            persisted per keyboard via PipetteSettings. */}
        <div role="tablist" className="flex gap-1">
          <button
            type="button"
            role="tab"
            aria-selected={menuTab === 'window'}
            data-testid="menu-tab-window"
            className={`flex-1 whitespace-nowrap ${menuTab === 'window' ? BTN_TOGGLE_ACTIVE : BTN_TOGGLE_INACTIVE}`}
            onClick={() => onMenuTabChange?.('window')}
          >
            {t('editor.typingTest.tab.window')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={menuTab === 'rec'}
            data-testid="menu-tab-rec"
            className={`flex-1 whitespace-nowrap ${menuTab === 'rec' ? BTN_TOGGLE_ACTIVE : BTN_TOGGLE_INACTIVE}`}
            onClick={() => onMenuTabChange?.('rec')}
          >
            {t('editor.typingTest.tab.rec')}
          </button>
        </div>

        {/* Each tab body is wrapped in its own flex column so we can
            pin a shared min-h. REC currently has the most controls
            (Start/Stop, Monitor App, tray toggles, View Analytics,
            HeatMap window), so the other tabs match its natural
            height. Keep this in sync if any tab grows/shrinks
            meaningfully. */}
        {menuTab === 'window' && (
          <div className="flex min-h-word-list flex-col gap-1.5">
            <button
              type="button"
              role="menuitem"
              data-testid="reset-window-size"
              className={`whitespace-nowrap ${BTN_TOGGLE_INACTIVE}`}
              onClick={() => {
                const size = getDefaultCompactSize()
                window.vialAPI.setWindowCompactMode(true, size).catch(() => {})
                onViewOnlyWindowSizeChange?.(size)
                setViewOnlyControlsOpen(false)
              }}
            >
              {t('editor.typingTest.resetSize')}
            </button>
            <button
              type="button"
              role="menuitem"
              data-testid="fit-window-size"
              className={`whitespace-nowrap ${BTN_TOGGLE_INACTIVE}`}
              onClick={() => {
                const defaultSize = getDefaultCompactSize()
                const ratio = defaultSize.height / defaultSize.width
                const w = window.innerWidth
                const h = Math.round(w * ratio)
                const size = { width: w, height: h }
                window.vialAPI.setWindowCompactMode(true, size).catch(() => {})
                onViewOnlyWindowSizeChange?.(size)
                setViewOnlyControlsOpen(false)
              }}
            >
              {t('editor.typingTest.fitSize')}
            </button>
            {alwaysOnTopSupported && onViewOnlyAlwaysOnTopChange && (
              <button
                type="button"
                role="menuitem"
                data-testid="always-on-top-toggle"
                className={`whitespace-nowrap ${viewOnlyAlwaysOnTop ? BTN_TOGGLE_ACTIVE : BTN_TOGGLE_INACTIVE}`}
                onClick={() => onViewOnlyAlwaysOnTopChange(!viewOnlyAlwaysOnTop)}
              >
                {t('editor.typingTest.alwaysOnTop')}
              </button>
            )}
          </div>
        )}

        {menuTab === 'rec' && (
          <div className="flex min-h-word-list flex-col gap-1.5">
            {onRecordEnabledChange && (
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={recordEnabled ?? false}
                data-testid="typing-record-toggle"
                className={`whitespace-nowrap ${recordEnabled ? BTN_TOGGLE_ACTIVE : BTN_TOGGLE_INACTIVE}`}
                onClick={handleRecordToggle}
              >
                {recordEnabled ? t('editor.typingTest.recordStop') : t('editor.typingTest.recordStart')}
              </button>
            )}
            {/* Monitor App lives directly under the Start/Stop
                button so the recording-related toggles read top
                to bottom. The label is fixed; the on/off state
                only changes the border / background colour. The
                button is greyed out while REC is off so app-name
                capture has exactly one entry point. */}
            {onMonitorAppEnabledChange && (
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={monitorAppEnabled ?? false}
                aria-disabled={!recordEnabled}
                data-testid="monitor-app-toggle"
                className={
                  !recordEnabled
                    ? 'whitespace-nowrap rounded border border-edge px-2 py-1 text-content-muted opacity-60 cursor-not-allowed'
                    : `whitespace-nowrap ${monitorAppEnabled ? BTN_TOGGLE_ACTIVE : BTN_TOGGLE_INACTIVE}`
                }
                onClick={() => {
                  if (!recordEnabled) return
                  onMonitorAppEnabledChange(!monitorAppEnabled)
                }}
              >
                {t('editor.typingTest.monitorApp.label')}
              </button>
            )}
            {/* Tray toggles — same AppConfig fields and linked-clear
                semantics as Settings > Tools, surfaced here since the
                view-only window is often the last one open before the
                user reaches for the tray. */}
            {onTrayResidentChange && (
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={trayResident ?? false}
                data-testid="typing-tray-resident-toggle"
                className={`whitespace-nowrap ${trayResident ? BTN_TOGGLE_ACTIVE : BTN_TOGGLE_INACTIVE}`}
                onClick={handleTrayResidentToggle}
              >
                {t('settings.trayResident')}
              </button>
            )}
            {onStartInTrayChange && (
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={startInTray ?? false}
                aria-disabled={!trayResident}
                data-testid="typing-start-in-tray-toggle"
                className={
                  !trayResident
                    ? 'whitespace-nowrap rounded border border-edge px-2 py-1 text-content-muted opacity-60 cursor-not-allowed'
                    : `whitespace-nowrap ${startInTray ? BTN_TOGGLE_ACTIVE : BTN_TOGGLE_INACTIVE}`
                }
                onClick={() => {
                  if (!trayResident) return
                  onStartInTrayChange(!startInTray)
                }}
              >
                {t('settings.startInTray')}
              </button>
            )}
            {onViewAnalytics && (
              <button
                type="button"
                role="menuitem"
                data-testid="view-analytics"
                className={`whitespace-nowrap ${BTN_TOGGLE_INACTIVE}`}
                onClick={() => {
                  setViewOnlyControlsOpen(false)
                  onViewAnalytics('typingView')
                }}
              >
                {t('app.analyzeTab')}
              </button>
            )}
            {onHeatmapWindowMinChange && (
              <div className="flex items-center justify-between gap-1">
                <span className="text-content-muted">{t('editor.typingTest.heatmapWindowShort')}</span>
                <select
                  data-testid="heatmap-window-select"
                  aria-label={t('editor.typingTest.heatmapWindow')}
                  value={heatmapWindowMin ?? 5}
                  onChange={(e) => onHeatmapWindowMinChange(Number(e.target.value))}
                  className="rounded border border-edge bg-surface-alt px-1.5 py-0.5 text-xs text-content-secondary focus:border-accent focus:outline-none"
                >
                  {TYPING_HEATMAP_WINDOW_OPTIONS.map((m) => (
                    <option key={m} value={m}>{t('editor.typingTest.heatmapWindowOption', { minutes: m })}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}

        {/* Separator — what follows is always visible regardless of tab */}
        <div className="mt-1 border-t border-edge-subtle" aria-hidden="true" />

        {layers > 1 && (
          <div className="flex items-center justify-between gap-1">
            <span className="text-content-muted">{t('editor.typingTest.baseLayerShort')}</span>
            <select
              data-testid="base-layer-select"
              aria-label={t('editor.typingTest.baseLayer')}
              value={typingTest.baseLayer}
              onChange={(e) => typingTest.setBaseLayer(Number(e.target.value))}
              className="rounded border border-edge bg-surface-alt px-1.5 py-0.5 text-xs text-content-secondary focus:border-accent focus:outline-none"
            >
              {Array.from({ length: layers }, (_, i) => (
                <option key={i} value={i}>{layerNames?.[i] || i}</option>
              ))}
            </select>
          </div>
        )}

        {onViewOnlyChange && (
          <button
            type="button"
            role="menuitem"
            data-testid="view-only-toggle"
            // Mirrors the StatusBar disconnect button: red text on
            // a default-edge border so "exit" reads as the
            // destructive / out-of-mode action rather than the
            // accent-coloured primary path.
            className="whitespace-nowrap rounded border border-edge px-2 py-1 text-danger transition-colors hover:text-danger/80"
            onClick={handleViewOnlyToggle}
          >
            {t('editor.typingTest.exitViewOnly')}
          </button>
        )}
      </div>
    </div>
    </>
  )
}
