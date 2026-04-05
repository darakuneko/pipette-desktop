// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Globe, Equal } from 'lucide-react'
import { TypingTestView } from '../../typing-test/TypingTestView'
import { LanguageSelectorModal } from '../../typing-test/LanguageSelectorModal'
import { HistoryToggle } from './HistoryToggle'
import { KeyboardPane } from './KeyboardPane'
import { KEY_UNIT, KEYBOARD_PADDING } from '../keyboard/constants'
import { repositionLayoutKeys, filterVisibleKeys } from '../../../shared/kle/filter-keys'
import type { KleKey } from '../../../shared/kle/types'
import type { TypingTestResult } from '../../../shared/types/pipette-settings'
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
}: TypingTestPaneProps) {
  const { t } = useTranslation()
  const [showLanguageModal, setShowLanguageModal] = useState(false)
  const [viewOnlyControlsOpen, setViewOnlyControlsOpen] = useState(false)
  // Always-on-top not supported on Wayland
  const [alwaysOnTopSupported, setAlwaysOnTopSupported] = useState(false)
  useEffect(() => {
    window.vialAPI.isAlwaysOnTopSupported().then(setAlwaysOnTopSupported).catch(() => {})
  }, [])
  const controlsBarRef = useRef<HTMLDivElement>(null)
  const onViewOnlyWindowSizeChangeRef = useRef(onViewOnlyWindowSizeChange)
  onViewOnlyWindowSizeChangeRef.current = onViewOnlyWindowSizeChange

  // Close controls on Escape key or click outside
  useEffect(() => {
    if (!viewOnly || !viewOnlyControlsOpen) return
    const handleEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setViewOnlyControlsOpen(false)
    }
    const handleClickOutside = (e: MouseEvent): void => {
      if (controlsBarRef.current && !controlsBarRef.current.contains(e.target as Node)) {
        setViewOnlyControlsOpen(false)
      }
    }
    document.addEventListener('keydown', handleEsc)
    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('keydown', handleEsc)
      document.removeEventListener('mousedown', handleClickOutside)
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
      <div className={viewOnly ? 'flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden' : 'flex items-start justify-center overflow-auto'}>
        <div style={viewOnly && paneNaturalSizeRef.current.w > 0 ? { width: paneNaturalSizeRef.current.w * cssScale, height: paneNaturalSizeRef.current.h * cssScale, overflow: 'hidden' } : undefined}>
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
            scale={viewOnly ? 1 : scale}
            layerLabel={layerLabel}
            layerLabelTestId="layer-label"
            contentRef={contentRef}
          />
        </div>
        </div>
      </div>
      {viewOnly && (
        <>
        <div
          className={`pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center transition-all duration-200 ${viewOnlyControlsOpen ? '-translate-y-0 py-2 opacity-100' : '-translate-y-2 opacity-0'}`}
        >
          <span className="text-[10px] text-content-muted">{t('editor.typingTest.closeHint')}</span>
        </div>
        <div
          ref={controlsBarRef}
          className={`fixed inset-x-0 z-50 flex items-center justify-center px-4 transition-all duration-200 ease-out ${viewOnlyControlsOpen ? 'bottom-0 h-[42px] bg-surface-alt' : 'bottom-0 cursor-pointer py-0.5'}`}
          onClick={() => { if (!viewOnlyControlsOpen) setViewOnlyControlsOpen(true) }}
        >
          <div className={`absolute left-4 flex items-center gap-2 transition-all duration-200 ${viewOnlyControlsOpen ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-2 opacity-0'}`}>
              {layers > 1 && (
                <div className="flex items-center gap-1">
                  <span className="text-xs text-content-muted">{t('editor.typingTest.baseLayer')}:</span>
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
              {alwaysOnTopSupported && onViewOnlyAlwaysOnTopChange && (
                <button
                  type="button"
                  data-testid="always-on-top-toggle"
                  className={`rounded border px-1.5 py-0.5 text-xs transition-colors ${viewOnlyAlwaysOnTop ? 'border-accent bg-accent/10 text-accent' : 'border-edge text-content-secondary hover:text-content'}`}
                  onClick={() => onViewOnlyAlwaysOnTopChange(!viewOnlyAlwaysOnTop)}
                >
                  {t('editor.typingTest.alwaysOnTop')}
                </button>
              )}
              <button
                type="button"
                data-testid="reset-window-size"
                className="rounded border border-edge px-1.5 py-0.5 text-xs text-content-secondary transition-colors hover:text-content"
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
                data-testid="fit-window-size"
                className="rounded border border-edge px-1.5 py-0.5 text-xs text-content-secondary transition-colors hover:text-content"
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
          </div>
          {!viewOnlyControlsOpen && (
            <button
              type="button"
              className="px-4 py-0.5 text-content-muted transition-colors hover:text-content"
              onClick={() => setViewOnlyControlsOpen(true)}
            >
              <Equal size={12} />
            </button>
          )}
          {onViewOnlyChange && (
            <div className={`absolute right-4 flex items-center gap-2 transition-all duration-200 ${viewOnlyControlsOpen ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-2 opacity-0'}`}>
              <button
                type="button"
                data-testid="view-only-toggle"
                aria-label={t('editor.typingTest.viewOnly')}
                title={t('editor.typingTest.viewOnly')}
                className="flex items-center gap-1 rounded border border-accent bg-accent/10 px-2 py-0.5 text-xs text-accent transition-colors"
                onClick={handleViewOnlyToggle}
              >
                <span>Exit {t('editor.typingTest.viewOnly')}</span>
              </button>
            </div>
          )}
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
