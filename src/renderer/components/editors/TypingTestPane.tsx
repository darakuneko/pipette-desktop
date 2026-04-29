// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Globe } from 'lucide-react'
import { TypingTestView } from '../../typing-test/TypingTestView'
import { LanguageSelectorModal } from '../../typing-test/LanguageSelectorModal'
import { TypingRecordingConsentModal } from '../../typing-test/TypingRecordingConsentModal'
import { useTypingHeatmap } from '../../typing-test/useTypingHeatmap'
import { TYPING_HEATMAP_WINDOW_OPTIONS } from '../../../shared/types/app-config'
import { HistoryToggle } from './HistoryToggle'
import { KeyboardPane } from './KeyboardPane'
import { KEY_UNIT, KEYBOARD_PADDING } from '../keyboard/constants'
import { repositionLayoutKeys, filterVisibleKeys } from '../../../shared/kle/filter-keys'
import type { KleKey } from '../../../shared/kle/types'
import type { TypingTestResult, TypingViewMenuTab } from '../../../shared/types/pipette-settings'
import type { TypingTestConfig } from '../../typing-test/types'
import type { useTypingTest } from '../../typing-test/useTypingTest'

export interface TypingTestPaneProps {
  typingTest: ReturnType<typeof useTypingTest>
  onConfigChange: (config: TypingTestConfig) => void
  onLanguageChange: (lang: string) => Promise<void>
  layers: number
  layerNames?: string[]
  typingTestHistory?: TypingTestResult[]
  deviceName?: string
  pressedKeys: Set<string>
  keycodes: Map<string, string>
  encoderKeycodes: Map<string, [string, string]>
  remappedKeys: Set<string>
  layoutOptions: Map<number, number>
  scale: number
  keys: KleKey[]
  layerLabel: string
  contentRef?: React.RefObject<HTMLDivElement | null>
  viewOnly?: boolean
  onViewOnlyChange?: (enabled: boolean) => void
  viewOnlyWindowSize?: { width: number; height: number }
  onViewOnlyWindowSizeChange?: (size: { width: number; height: number }) => void
  viewOnlyAlwaysOnTop?: boolean
  onViewOnlyAlwaysOnTopChange?: (enabled: boolean) => void
  recordEnabled?: boolean
  onRecordEnabledChange?: (enabled: boolean) => void
  /** Whether the user has accepted the typing-recording disclosure.
   * The REC tab Start button gates on this — first-time enable opens
   * the consent modal, subsequent enables skip it. */
  recordingConsentAccepted?: boolean
  onRecordingConsentAccepted?: () => void
  /** Window length in minutes for the typing-view heatmap overlay.
   * Exposed as a REC-tab dropdown so the user can dial how far back
   * the overlay reaches; data older than the window is dropped, data
   * within decays smoothly. Backed by
   * AppConfig.typingHeatmapWindowMin. */
  heatmapWindowMin?: number
  onHeatmapWindowMinChange?: (minutes: number) => void
  /** AppConfig flag — when on (and REC running), the analytics
   * service tags every minute payload with the active application
   * name. Toggle is intentionally inert until REC starts so the user
   * controls one switch at a time. */
  monitorAppEnabled?: boolean
  onMonitorAppEnabledChange?: (enabled: boolean) => void
  /** Which tab of the view-only menu is currently open. Window shows
   * size / always-on-top controls; REC shows the recording toggle and
   * the entry point to the analytics page; Monitor App shows the
   * active-application capture toggle. Persisted per keyboard via
   * PipetteSettings. */
  menuTab?: TypingViewMenuTab
  onMenuTabChange?: (tab: TypingViewMenuTab) => void
  /** Called when the user picks "View Analytics" from the REC tab.
   * The parent owns the navigation — the pane only surfaces the
   * entry point. */
  onViewAnalytics?: () => void
  /** Keyboard uid used for the typing-view heatmap query. The heatmap
   * stays hidden while this is unset or recording is off so a session
   * without a device never sees stale overlay data. */
  keyboardUid?: string
}

export function TypingTestPane({
  typingTest,
  onConfigChange,
  onLanguageChange,
  layers,
  layerNames,
  typingTestHistory,
  deviceName,
  pressedKeys,
  keycodes,
  encoderKeycodes,
  remappedKeys,
  layoutOptions,
  scale,
  keys,
  layerLabel,
  contentRef,
  viewOnly,
  onViewOnlyChange,
  viewOnlyWindowSize,
  onViewOnlyWindowSizeChange,
  viewOnlyAlwaysOnTop,
  onViewOnlyAlwaysOnTopChange,
  recordEnabled,
  onRecordEnabledChange,
  recordingConsentAccepted,
  onRecordingConsentAccepted,
  heatmapWindowMin,
  onHeatmapWindowMinChange,
  monitorAppEnabled,
  onMonitorAppEnabledChange,
  menuTab = 'window',
  onMenuTabChange,
  onViewAnalytics,
  keyboardUid,
}: TypingTestPaneProps) {
  const { t } = useTranslation()

  // Heatmap overlay for view-only + record mode. Gated on both flags
  // so the overlay never shows up in editor mode and never lingers
  // after the user toggles record off.
  const {
    cells: heatmapCells,
    maxTotal: heatmapMaxTotal,
    maxTap: heatmapMaxTap,
    maxHold: heatmapMaxHold,
  } = useTypingHeatmap({
    uid: keyboardUid ?? null,
    layer: typingTest.effectiveLayer,
    enabled: !!viewOnly && !!recordEnabled,
    windowMs: (heatmapWindowMin ?? 5) * 60 * 1_000,
  })
  const heatmapActive = heatmapMaxTotal > 0
  const [showLanguageModal, setShowLanguageModal] = useState(false)
  const [showConsentModal, setShowConsentModal] = useState(false)

  const handleRecordToggle = useCallback(() => {
    if (!onRecordEnabledChange) return
    // Stopping is always allowed without re-prompting; only the
    // first transition from "off → on" needs the disclosure.
    if (recordEnabled) {
      onRecordEnabledChange(false)
      return
    }
    if (!recordingConsentAccepted) {
      // Hide the REC overlay so the modal isn't visually overlapped
      // by the popover; the cancel/accept handlers reopen it so the
      // user lands back where they started.
      setViewOnlyControlsOpen(false)
      setShowConsentModal(true)
      return
    }
    onRecordEnabledChange(true)
  }, [onRecordEnabledChange, recordEnabled, recordingConsentAccepted])

  const handleConsentAccept = useCallback(() => {
    onRecordingConsentAccepted?.()
    setShowConsentModal(false)
    setViewOnlyControlsOpen(true)
    onRecordEnabledChange?.(true)
  }, [onRecordingConsentAccepted, onRecordEnabledChange])

  const handleConsentCancel = useCallback(() => {
    setShowConsentModal(false)
    setViewOnlyControlsOpen(true)
  }, [])
  const [viewOnlyControlsOpen, setViewOnlyControlsOpen] = useState(false)
  const [mouseOver, setMouseOver] = useState(false)

  // Show hint text only when mouse is over the window
  useEffect(() => {
    if (!viewOnly) return
    const onEnter = (): void => setMouseOver(true)
    const onLeave = (): void => setMouseOver(false)
    document.documentElement.addEventListener('mouseenter', onEnter)
    document.documentElement.addEventListener('mouseleave', onLeave)
    return () => {
      document.documentElement.removeEventListener('mouseenter', onEnter)
      document.documentElement.removeEventListener('mouseleave', onLeave)
    }
  }, [viewOnly])
  // Always-on-top not supported on Wayland
  const [alwaysOnTopSupported, setAlwaysOnTopSupported] = useState(false)
  useEffect(() => {
    window.vialAPI.isAlwaysOnTopSupported().then(setAlwaysOnTopSupported).catch(() => {})
  }, [])
  const controlsBarRef = useRef<HTMLDivElement>(null)
  const onViewOnlyWindowSizeChangeRef = useRef(onViewOnlyWindowSizeChange)
  onViewOnlyWindowSizeChangeRef.current = onViewOnlyWindowSizeChange

  // Close controls on Escape key
  useEffect(() => {
    if (!viewOnly || !viewOnlyControlsOpen) return
    const handleEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setViewOnlyControlsOpen(false)
    }
    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('keydown', handleEsc)
    }
  }, [viewOnly, viewOnlyControlsOpen])

  const [cssScale, setCssScale] = useState(1)
  const paneWrapperRef = useRef<HTMLDivElement>(null)
  const paneNaturalSizeRef = useRef({ w: 0, h: 0 })
  const MARGIN = 20

  // Calculate default compact window size: keyboard at 100% + pane padding + margins
  const getDefaultCompactSize = useCallback(() => {
    const visibleKeys = filterVisibleKeys(repositionLayoutKeys(keys, layoutOptions), layoutOptions)
    let maxRight = 0
    let maxBottom = 0
    for (const key of visibleKeys) {
      const right = key.x + key.width
      const bottom = key.y + key.height
      if (right > maxRight) maxRight = right
      if (bottom > maxBottom) maxBottom = bottom
    }
    // SVG size at scale=1 + pane padding (px-5=40, border=4, pt-3=12, pb-2=8, label~18) + margins
    const svgW = maxRight * KEY_UNIT + KEYBOARD_PADDING * 2
    const svgH = maxBottom * KEY_UNIT + KEYBOARD_PADDING * 2
    const paneW = svgW + 44
    const paneH = svgH + 42
    let w = paneW + MARGIN * 2
    let h = paneH + MARGIN * 2
    // Cap to 80% of screen if keyboard at 100% exceeds it
    const maxW = window.screen.availWidth * 0.8
    const maxH = window.screen.availHeight * 0.8
    const capScale = Math.min(1, maxW / w, maxH / h)
    if (capScale < 1) {
      w = Math.round(w * capScale)
      h = Math.round(h * capScale)
    }
    return { width: w, height: h }
  }, [keys, layoutOptions])

  // Auto-fit using CSS transform + aspect ratio lock
  useEffect(() => {
    if (!viewOnly) return
    let paneNaturalW = 0
    let paneNaturalH = 0

    const computeCssScale = (): void => {
      if (paneNaturalW <= 0 || paneNaturalH <= 0) return
      const availW = window.innerWidth - MARGIN * 2
      const availH = window.innerHeight - MARGIN * 2
      const fitW = availW / paneNaturalW
      const fitH = availH / paneNaturalH
      const fitted = Math.min(fitW, fitH)
      setCssScale(Math.max(0.05, fitted))
    }

    requestAnimationFrame(() => {
      const el = paneWrapperRef.current
      if (!el) return
      paneNaturalW = el.scrollWidth
      paneNaturalH = el.scrollHeight
      paneNaturalSizeRef.current = { w: paneNaturalW, h: paneNaturalH }
      if (paneNaturalW <= 0 || paneNaturalH <= 0) return

      const totalW = paneNaturalW + MARGIN * 2
      const totalH = paneNaturalH + MARGIN * 2
      window.vialAPI.setWindowAspectRatio(totalW / totalH).catch(() => {})

      computeCssScale()
    })

    // Save window size on resize (debounced)
    let saveTimer: ReturnType<typeof setTimeout> | null = null
    const onResize = (): void => {
      computeCssScale()
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(() => {
        onViewOnlyWindowSizeChangeRef.current?.({ width: window.innerWidth, height: window.innerHeight })
      }, 500)
    }

    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      if (saveTimer) clearTimeout(saveTimer)
      window.vialAPI.setWindowAspectRatio(0).catch(() => {})
    }
  }, [viewOnly, keys, layoutOptions])

  // Sync always-on-top state
  useEffect(() => {
    if (!viewOnly) return
    window.vialAPI.setWindowAlwaysOnTop(viewOnlyAlwaysOnTop ?? false).catch(() => {})
    return () => { window.vialAPI.setWindowAlwaysOnTop(false).catch(() => {}) }
  }, [viewOnly, viewOnlyAlwaysOnTop])

  // Compact mode is managed by App.tsx onViewOnlyChange handler

  const handleViewOnlyToggle = useCallback(() => {
    if (!onViewOnlyChange) return
    const next = !viewOnly
    if (next) {
      const compactSize = viewOnlyWindowSize ?? getDefaultCompactSize()
      window.vialAPI.setWindowCompactMode(true, compactSize).then(() => {
        onViewOnlyChange(true)
      }).catch(() => {})
    } else {
      onViewOnlyChange(false)
    }
  }, [viewOnly, viewOnlyWindowSize, getDefaultCompactSize, onViewOnlyChange, typingTest])

  return (
    <>
      {showConsentModal && (
        <TypingRecordingConsentModal
          onAccept={handleConsentAccept}
          onCancel={handleConsentCancel}
        />
      )}
      {!viewOnly && (
        <TypingTestView
          state={typingTest.state}
          wpm={typingTest.wpm}
          accuracy={typingTest.accuracy}
          elapsedSeconds={typingTest.elapsedSeconds}
          remainingSeconds={typingTest.remainingSeconds}
          config={typingTest.config}
          paused={typingTest.state.status === 'running' && !typingTest.windowFocused}
          onRestart={typingTest.restart}
          onConfigChange={onConfigChange}
          onCompositionStart={typingTest.processCompositionStart}
          onCompositionUpdate={typingTest.processCompositionUpdate}
          onCompositionEnd={typingTest.processCompositionEnd}
          onImeSpaceKey={() => typingTest.processKeyEvent(' ', false, false, false)}
        />
      )}
      <div
        className={viewOnly ? 'flex min-h-0 w-full flex-1 cursor-pointer items-center justify-center overflow-hidden' : 'flex items-start justify-center overflow-auto'}
        onClick={viewOnly ? () => setViewOnlyControlsOpen((v) => !v) : undefined}
      >
        <div className="relative" style={viewOnly && paneNaturalSizeRef.current.w > 0 ? { width: paneNaturalSizeRef.current.w * cssScale, height: paneNaturalSizeRef.current.h * cssScale, overflow: 'hidden' } : undefined}>
          {viewOnly && <div className="absolute inset-0 z-10" />}
          <div
            ref={viewOnly ? paneWrapperRef : undefined}
            style={viewOnly ? { transform: `scale(${cssScale})`, transformOrigin: 'top left' } : undefined}
          >
          {!viewOnly && (
            <div className="mb-3 flex items-center justify-between px-5">
              <div className="flex items-center gap-4">
                {layers > 1 && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm text-content-muted">{t('editor.typingTest.baseLayer')}:</span>
                    <select
                      data-testid="base-layer-select"
                      aria-label={t('editor.typingTest.baseLayer')}
                      value={typingTest.baseLayer}
                      onChange={(e) => typingTest.setBaseLayer(Number(e.target.value))}
                      className="rounded-md border border-edge bg-surface-alt px-2 py-1 text-sm text-content-secondary"
                    >
                      {Array.from({ length: layers }, (_, i) => (
                        <option key={i} value={i}>{layerNames?.[i] || i}</option>
                      ))}
                    </select>
                  </div>
                )}
                {typingTest.config.mode !== 'quote' && (
                  <button
                    type="button"
                    data-testid="language-selector"
                    className="flex items-center gap-1.5 rounded-md border border-edge px-2.5 py-1 text-sm text-content-secondary transition-colors hover:text-content"
                    onClick={() => setShowLanguageModal(true)}
                    disabled={typingTest.isLanguageLoading}
                  >
                    {typingTest.isLanguageLoading ? (
                      <span>{t('editor.typingTest.language.loadingLanguage')}</span>
                    ) : (
                      <>
                        <Globe size={14} aria-hidden="true" />
                        <span>{typingTest.language.replace(/_/g, ' ')}</span>
                      </>
                    )}
                  </button>
                )}
                {showLanguageModal && (
                  <LanguageSelectorModal
                    currentLanguage={typingTest.language}
                    onSelectLanguage={onLanguageChange}
                    onClose={() => setShowLanguageModal(false)}
                  />
                )}
              </div>
              <div className="flex items-center gap-3">
                {typingTestHistory && typingTestHistory.length > 0 && (
                  <HistoryToggle results={typingTestHistory} deviceName={deviceName} />
                )}
              </div>
            </div>
          )}
          <KeyboardPane
            paneId="primary"
            isActive={false}
            keys={keys}
            keycodes={keycodes}
            encoderKeycodes={encoderKeycodes}
            selectedKey={null}
            selectedEncoder={null}
            selectedMaskPart={false}
            selectedKeycode={null}
            pressedKeys={pressedKeys}
            everPressedKeys={undefined}
            remappedKeys={remappedKeys}
            layoutOptions={layoutOptions}
            heatmapCells={heatmapCells}
            heatmapMaxTotal={heatmapMaxTotal}
            heatmapMaxTap={heatmapMaxTap}
            heatmapMaxHold={heatmapMaxHold}
            scale={viewOnly ? 1 : scale}
            layerLabel={layerLabel}
            layerLabelTestId="layer-label"
            contentRef={contentRef}
          />
          {heatmapActive && (
            <p
              data-testid="typing-test-heatmap-legend"
              className="mt-1 text-center text-[11px] text-content-muted"
            >
              {t('editor.typingTest.heatmap.legend')}
            </p>
          )}
        </div>
        </div>
      </div>
      {viewOnly && (
        <>
        <div
          className={`pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center py-1 transition-opacity duration-200 ${viewOnlyControlsOpen || (!mouseOver && !recordEnabled) ? 'opacity-0' : 'opacity-100'}`}
        >
          <span className={`text-[10px] ${!mouseOver && recordEnabled ? 'text-accent' : 'text-content-muted'}`}>
            {mouseOver
              ? t('editor.typingTest.closeHint')
              : t('editor.typingTest.recordingIndicator')}
          </span>
        </div>
        <div ref={controlsBarRef} className="fixed bottom-0 right-0 z-50">
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
                className={`flex-1 whitespace-nowrap rounded border px-2 py-1 transition-colors ${menuTab === 'window' ? 'border-accent bg-accent/10 text-accent' : 'border-edge text-content-secondary hover:text-content'}`}
                onClick={() => onMenuTabChange?.('window')}
              >
                {t('editor.typingTest.tab.window')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={menuTab === 'rec'}
                data-testid="menu-tab-rec"
                className={`flex-1 whitespace-nowrap rounded border px-2 py-1 transition-colors ${menuTab === 'rec' ? 'border-accent bg-accent/10 text-accent' : 'border-edge text-content-secondary hover:text-content'}`}
                onClick={() => onMenuTabChange?.('rec')}
              >
                {t('editor.typingTest.tab.rec')}
              </button>
            </div>

            {/* Each tab body is wrapped in its own flex column so we can
                pin a shared min-h. REC currently has the most controls
                (Start/Stop, View Analytics, HeatMap window), so the
                other tabs match its natural height. Keep this in sync
                if any tab grows/shrinks meaningfully. */}
            {menuTab === 'window' && (
              <div className="flex min-h-[100px] flex-col gap-1.5">
                <button
                  type="button"
                  role="menuitem"
                  data-testid="reset-window-size"
                  className="whitespace-nowrap rounded border border-edge px-2 py-1 text-content-secondary transition-colors hover:text-content"
                  onClick={() => {
                    const size = getDefaultCompactSize()
                    window.vialAPI.setWindowCompactMode(true, size).catch(() => {})
                    if (onViewOnlyWindowSizeChange) onViewOnlyWindowSizeChange(size)
                    setViewOnlyControlsOpen(false)
                  }}
                >
                  {t('editor.typingTest.resetSize')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="fit-window-size"
                  className="whitespace-nowrap rounded border border-edge px-2 py-1 text-content-secondary transition-colors hover:text-content"
                  onClick={() => {
                    const defaultSize = getDefaultCompactSize()
                    const ratio = defaultSize.height / defaultSize.width
                    const w = window.innerWidth
                    const h = Math.round(w * ratio)
                    const size = { width: w, height: h }
                    window.vialAPI.setWindowCompactMode(true, size).catch(() => {})
                    if (onViewOnlyWindowSizeChange) onViewOnlyWindowSizeChange(size)
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
                    className={`whitespace-nowrap rounded border px-2 py-1 transition-colors ${viewOnlyAlwaysOnTop ? 'border-accent bg-accent/10 text-accent' : 'border-edge text-content-secondary hover:text-content'}`}
                    onClick={() => onViewOnlyAlwaysOnTopChange(!viewOnlyAlwaysOnTop)}
                  >
                    {t('editor.typingTest.alwaysOnTop')}
                  </button>
                )}
              </div>
            )}

            {menuTab === 'rec' && (
              <div className="flex min-h-[100px] flex-col gap-1.5">
                {onRecordEnabledChange && (
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={recordEnabled ?? false}
                    data-testid="typing-record-toggle"
                    className={`whitespace-nowrap rounded border px-2 py-1 transition-colors ${recordEnabled ? 'border-accent bg-accent/10 text-accent' : 'border-edge text-content-secondary hover:text-content'}`}
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
                        : `whitespace-nowrap rounded border px-2 py-1 transition-colors ${monitorAppEnabled ? 'border-accent bg-accent/10 text-accent' : 'border-edge text-content-secondary hover:text-content'}`
                    }
                    onClick={() => {
                      if (!recordEnabled) return
                      onMonitorAppEnabledChange(!monitorAppEnabled)
                    }}
                  >
                    {t('editor.typingTest.monitorApp.label')}
                  </button>
                )}
                {onViewAnalytics && (
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="view-analytics"
                    className="whitespace-nowrap rounded border border-edge px-2 py-1 text-content-secondary transition-colors hover:text-content"
                    onClick={() => {
                      setViewOnlyControlsOpen(false)
                      onViewAnalytics()
                    }}
                  >
                    {t('editor.typingTest.viewAnalytics')}
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
                      className="rounded border border-edge bg-surface-alt px-1.5 py-0.5 text-xs text-content-secondary"
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
                  className="rounded border border-edge bg-surface-alt px-1.5 py-0.5 text-xs text-content-secondary"
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
                className="whitespace-nowrap rounded border border-edge px-2 py-1 text-red-500 transition-colors hover:text-red-600"
                onClick={handleViewOnlyToggle}
              >
                {t('editor.typingTest.exitViewOnly')}
              </button>
            )}
          </div>
        </div>
        </>
      )}
      {!viewOnly && (
        <p data-testid="typing-test-layer-note" className="text-center text-xs text-content-muted">
          {t('editor.typingTest.layerNote')}
        </p>
      )}
    </>
  )
}
