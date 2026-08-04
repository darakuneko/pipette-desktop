// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
import { BTN_TOGGLE_ACTIVE, BTN_TOGGLE_INACTIVE } from '../../constants/ui-tokens'
import type { useTypingTest } from '../../typing-test/useTypingTest'

interface TypingTestPaneViewOnlyMenuProps {
  typingTest: ReturnType<typeof useTypingTest>
  mouseOver: boolean
  viewOnlyControlsOpen: boolean
  setViewOnlyControlsOpen: (open: boolean) => void
  getDefaultCompactSize: () => { width: number; height: number }
  onViewOnlyWindowSizeChange?: (size: { width: number; height: number }) => void
  alwaysOnTopSupported: boolean
  viewOnlyAlwaysOnTop?: boolean
  onViewOnlyAlwaysOnTopChange?: (enabled: boolean) => void
  recordEnabled?: boolean
  layers: number
  layerNames?: string[]
  onViewOnlyChange?: (enabled: boolean) => void
  handleViewOnlyToggle: () => void
}

/** View-only mode's fixed bottom-right menu (hint bar + panel), split
 *  out of TypingTestPane (file-splitting.md cap) — see
 *  Task-split-typing-test-pane.md. Renders a bare fragment: the two fixed
 *  divs must stay siblings in source order (z-40 hint under z-50 panel).
 *  The REC tab (recording toggle, Monitor App, tray toggles, HeatMap
 *  window select) moved to the footer's Record button/modal
 *  (Task-typing-record-footer) — this panel now only ever shows the
 *  former Window tab's content, so the tab strip is gone too. */
export function TypingTestPaneViewOnlyMenu({
  typingTest,
  mouseOver,
  viewOnlyControlsOpen,
  setViewOnlyControlsOpen,
  getDefaultCompactSize,
  onViewOnlyWindowSizeChange,
  alwaysOnTopSupported,
  viewOnlyAlwaysOnTop,
  onViewOnlyAlwaysOnTopChange,
  recordEnabled,
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
        inert={!viewOnlyControlsOpen}
      >
        {/* Window controls — sizing + always-on-top. */}
        <div className="flex flex-col gap-1.5">
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

        {/* Separator — what follows is always visible */}
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
