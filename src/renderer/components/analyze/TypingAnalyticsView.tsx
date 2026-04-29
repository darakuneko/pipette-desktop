// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze page orchestrator. Owns the keyboards fetch (one per page)
// and the page chrome (back / split-view toggle footer) so multiple
// `AnalyzePane`s can share a single keyboards list while keeping fully
// independent uid / filter / tab state. Split View renders a second
// pane so the user can compare keyboards / ranges / sub-tabs
// side-by-side. The toggle is intentionally session-only — re-opening
// the Analyze page resets to the single-pane view so the user starts
// from a known state.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TypingKeyboardSummary } from '../../../shared/types/typing-analytics'
import { AnalyzePane } from './AnalyzePane'
import { formatSharePercent } from './analyze-format'

// Below this viewport width the two panes can't fit side-by-side
// without crushing the per-tab filter row, so the toggle is disabled
// and an enabled split is suppressed visually (the AppConfig flag
// stays so resizing wider restores split immediately).
const SPLIT_MIN_WIDTH_PX = 1280

// Keep both footer buttons identical in size — they only differ in
// color/state classes.
const FOOTER_BUTTON_BASE =
  'inline-flex items-center justify-center whitespace-nowrap rounded border px-2.5 py-1 text-xs leading-none transition-colors'

// Hide the skip-rate warning until the unmappable share is meaningful;
// matches the threshold the LayoutComparisonView used to apply inline.
const SKIP_RATE_WARNING_THRESHOLD = 0.05

interface TypingAnalyticsViewProps {
  /** Pre-select this keyboard on mount if it exists in the current
   * analytics data. Used when entering the Analyze page from the
   * typing view — the user has already committed to one keyboard and
   * shouldn't have to re-pick it. */
  initialUid?: string
  /** When provided, the page footer renders a Back button that invokes
   * this handler. Omit to hide the button (e.g. when the Analyze view
   * is embedded somewhere without a meaningful "back" destination). */
  onBack?: () => void
}

export function TypingAnalyticsView({ initialUid, onBack }: TypingAnalyticsViewProps = {}) {
  const { t } = useTranslation()
  const [splitEnabled, setSplitEnabled] = useState(false)

  const [keyboards, setKeyboards] = useState<TypingKeyboardSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedUidA, setSelectedUidA] = useState<string | null>(initialUid ?? null)
  const [selectedUidB, setSelectedUidB] = useState<string | null>(null)
  const [skipPercentA, setSkipPercentA] = useState<number | null>(null)
  const [skipPercentB, setSkipPercentB] = useState<number | null>(null)
  const [isWideViewport, setIsWideViewport] = useState<boolean>(
    () => typeof window === 'undefined' || window.innerWidth >= SPLIT_MIN_WIDTH_PX,
  )

  useEffect(() => {
    if (typeof window === 'undefined') return
    const handler = (): void => setIsWideViewport(window.innerWidth >= SPLIT_MIN_WIDTH_PX)
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [])

  const splitVisible = splitEnabled && isWideViewport

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const list = await window.vialAPI.typingAnalyticsListKeyboards()
      setKeyboards(list)
      setSelectedUidA((prev) => {
        if (prev && list.some((kb) => kb.uid === prev)) return prev
        if (initialUid && list.some((kb) => kb.uid === initialUid)) return initialUid
        return list[0]?.uid ?? null
      })
      setSelectedUidB((prev) => {
        if (prev && list.some((kb) => kb.uid === prev)) return prev
        return null
      })
    } catch {
      setKeyboards([])
      setSelectedUidA(null)
      setSelectedUidB(null)
    } finally {
      setLoading(false)
    }
  }, [initialUid])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // First-time toggle on with no Pane B uid yet: seed it from Pane A
  // so the compare view starts on the same keyboard the user is
  // currently looking at.
  const handleToggleSplit = useCallback(() => {
    setSplitEnabled((prev) => {
      const next = !prev
      if (next && selectedUidB === null && selectedUidA !== null) {
        setSelectedUidB(selectedUidA)
      }
      return next
    })
  }, [selectedUidA, selectedUidB])

  const handleSelectUidB = setSelectedUidB

  // Combine the per-pane skip rates into a single footer line. The
  // pane prefix only appears when split-view is on so single-pane
  // users see the bare percentage they used to get inside the panel.
  const skipWarningMessage = useMemo(() => {
    const aOver = skipPercentA !== null && skipPercentA > SKIP_RATE_WARNING_THRESHOLD
    const bOver = splitVisible && skipPercentB !== null && skipPercentB > SKIP_RATE_WARNING_THRESHOLD
    if (!aOver && !bOver) return ''
    const formatOne = (percent: number): string =>
      t('analyze.layoutComparison.skipWarning', { percent: formatSharePercent(percent) })
    if (aOver && bOver && skipPercentA !== null && skipPercentB !== null) {
      return [
        `A: ${formatOne(skipPercentA)}`,
        `B: ${formatOne(skipPercentB)}`,
      ].join('  ·  ')
    }
    if (aOver && skipPercentA !== null) {
      return splitVisible ? `A: ${formatOne(skipPercentA)}` : formatOne(skipPercentA)
    }
    if (bOver && skipPercentB !== null) return `B: ${formatOne(skipPercentB)}`
    return ''
  }, [skipPercentA, skipPercentB, splitVisible, t])

  return (
    <div
      className="flex h-full min-h-[70vh] flex-col"
      data-testid="analyze-view"
    >
      <div className="flex flex-1 min-h-0 min-w-0 gap-4">
        <AnalyzePane
          paneKey="A"
          splitMode={splitVisible}
          keyboards={keyboards}
          loading={loading}
          selectedUid={selectedUidA}
          onSelectUid={setSelectedUidA}
          onSkipPercentChange={setSkipPercentA}
        />
        {splitVisible && (
          <AnalyzePane
            paneKey="B"
            splitMode
            keyboards={keyboards}
            loading={loading}
            selectedUid={selectedUidB}
            onSelectUid={handleSelectUidB}
            onSkipPercentChange={setSkipPercentB}
          />
        )}
      </div>
      <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-edge pt-2">
        <div
          className="min-w-0 flex-1 truncate text-left text-[12px] text-content-muted"
          data-testid="analyze-skip-warning"
        >
          {skipWarningMessage}
        </div>
        <button
          type="button"
          role="switch"
          className={`${FOOTER_BUTTON_BASE} disabled:cursor-not-allowed disabled:opacity-50 ${
            splitVisible
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-edge text-content-secondary hover:text-content'
          }`}
          onClick={handleToggleSplit}
          disabled={!isWideViewport}
          aria-checked={splitEnabled}
          title={!isWideViewport ? t('analyze.splitView.narrowWindow') : undefined}
          data-testid="analyze-split-toggle"
        >
          {t('analyze.splitView.toggle')}
        </button>
        {onBack && (
          <button
            type="button"
            className={`${FOOTER_BUTTON_BASE} border-edge text-red-500 hover:text-red-600`}
            onClick={onBack}
            data-testid="analyze-back"
          >
            {t('common.back')}
          </button>
        )}
      </footer>
    </div>
  )
}
