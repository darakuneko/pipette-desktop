// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze page orchestrator. Owns the keyboards fetch (one per page)
// and the page chrome (back / split-view toggle footer) so multiple
// `AnalyzePane`s can share a single keyboards list while keeping fully
// independent uid / filter / tab state. Split View renders a second
// pane behind a per-machine AppConfig toggle so the user can compare
// keyboards / ranges / sub-tabs side-by-side
// (Plan-P2-analyze-split-view).

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TypingKeyboardSummary } from '../../../shared/types/typing-analytics'
import { useAppConfig } from '../../hooks/useAppConfig'
import { AnalyzePane } from './AnalyzePane'

// Below this viewport width the two panes can't fit side-by-side
// without crushing the per-tab filter row, so the toggle is disabled
// and an enabled split is suppressed visually (the AppConfig flag
// stays so resizing wider restores split immediately).
const SPLIT_MIN_WIDTH_PX = 1280

// Keep both footer buttons identical in size — they only differ in
// color/state classes.
const FOOTER_BUTTON_BASE =
  'inline-flex items-center justify-center whitespace-nowrap rounded border px-2.5 py-1 text-xs leading-none transition-colors'

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
  const { config, set: setAppConfigKey } = useAppConfig()
  const splitView = config.analyzeSplitView
  const splitEnabled = splitView?.enabled ?? false
  const persistedPaneBUid = splitView?.paneBUid

  const [keyboards, setKeyboards] = useState<TypingKeyboardSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedUidA, setSelectedUidA] = useState<string | null>(initialUid ?? null)
  const [selectedUidB, setSelectedUidB] = useState<string | null>(persistedPaneBUid ?? null)
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

  // Capture the persisted Pane B uid once at mount via ref so a later
  // user-driven Pane B switch (which writes back to AppConfig) doesn't
  // change the `refresh` identity and re-fire the keyboards list IPC.
  // The handleSelectUidB path keeps `selectedUidB` and storage in sync
  // without any list re-fetch.
  const persistedPaneBUidAtMountRef = useRef<string | undefined>(persistedPaneBUid)

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
      const persistedB = persistedPaneBUidAtMountRef.current
      setSelectedUidB((prev) => {
        if (prev && list.some((kb) => kb.uid === prev)) return prev
        if (persistedB && list.some((kb) => kb.uid === persistedB)) return persistedB
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

  // First-time toggle on with no persisted Pane B uid: seed it from
  // Pane A so the compare view starts on the same keyboard the user
  // is currently looking at.
  const handleToggleSplit = useCallback(() => {
    const next = !splitEnabled
    const shouldSeedFromPaneA = next
      && persistedPaneBUid === undefined
      && selectedUidB === null
      && selectedUidA !== null
    if (shouldSeedFromPaneA) {
      setSelectedUidB(selectedUidA)
    }
    const seededPaneBUid = shouldSeedFromPaneA
      ? selectedUidA ?? undefined
      : (selectedUidB ?? undefined)
    setAppConfigKey('analyzeSplitView', { enabled: next, paneBUid: seededPaneBUid })
  }, [splitEnabled, persistedPaneBUid, selectedUidA, selectedUidB, setAppConfigKey])

  const handleSelectUidB = useCallback((uid: string | null) => {
    setSelectedUidB(uid)
    setAppConfigKey('analyzeSplitView', {
      enabled: splitEnabled,
      paneBUid: uid ?? undefined,
    })
  }, [splitEnabled, setAppConfigKey])

  return (
    <div
      className="flex h-full min-h-[70vh] flex-col gap-3"
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
        />
        {splitVisible && (
          <AnalyzePane
            paneKey="B"
            splitMode
            keyboards={keyboards}
            loading={loading}
            selectedUid={selectedUidB}
            onSelectUid={handleSelectUidB}
          />
        )}
      </div>
      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-edge pt-2">
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
