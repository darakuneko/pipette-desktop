// SPDX-License-Identifier: GPL-2.0-or-later
// The Analyze pane's tab list + the filter-store slide-in panel's
// toggle button. Split out of AnalyzePane.tsx (Task-split-analyze-pane,
// mechanical follow-up pass to get the pane under the 500-line cap).

import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { SlidersHorizontal } from 'lucide-react'
import { ICON_MD } from '../../constants/ui-tokens'
import type { AnalysisTabKey } from './analyze-types'

const TAB_BTN_BASE =
  'rounded-md px-3 py-1.5 text-sm font-medium transition-colors'
const TAB_BTN_IDLE = 'text-content-muted hover:text-content-secondary'
const TAB_BTN_ACTIVE = 'bg-surface text-content'

// Grouped left → right: 全体像 (summary) / パフォーマンス (wpm,
// interval) / 行動分析 (activity, byApp) / 負荷分析 (keyHeatmap,
// ergonomics, bigrams, layer) / 最適化 (layoutComparison).
const ANALYSIS_TABS: AnalysisTabKey[] = [
  'summary',
  'wpm', 'interval',
  'activity', 'byApp',
  'keyHeatmap', 'ergonomics', 'bigrams', 'layer',
  'layoutComparison',
]

export interface AnalyzePaneTabBarProps {
  tid: (id: string) => string
  analysisTab: AnalysisTabKey
  setAnalysisTab: (tab: AnalysisTabKey) => void
  storePanelOpen: boolean
  storeToggleRef: RefObject<HTMLButtonElement | null>
  handleToggleStorePanel: () => void
}

export function AnalyzePaneTabBar({
  tid,
  analysisTab,
  setAnalysisTab,
  storePanelOpen,
  storeToggleRef,
  handleToggleStorePanel,
}: AnalyzePaneTabBarProps): JSX.Element {
  const { t } = useTranslation()

  return (
    <div className="flex items-center justify-between gap-2 rounded-lg bg-surface-dim p-1">
      <div
        className="flex gap-1"
        data-testid={tid("analyze-tabs")}
        role="tablist"
        aria-label={t('analyze.tablistLabel')}
      >
        {ANALYSIS_TABS.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={analysisTab === key}
            className={`${TAB_BTN_BASE} ${analysisTab === key ? TAB_BTN_ACTIVE : TAB_BTN_IDLE}`}
            onClick={() => setAnalysisTab(key)}
            data-testid={tid(`analyze-tab-${key}`)}
          >
            {t(`analyze.analysisTab.${key}`)}
          </button>
        ))}
      </div>
      <button
        ref={storeToggleRef}
        type="button"
        aria-label={t('analyzeFilterStore.title')}
        aria-expanded={storePanelOpen}
        aria-controls={tid("analyze-filter-store-panel-overlay")}
        className={`rounded p-1.5 transition-colors ${storePanelOpen ? 'bg-surface text-accent' : 'text-content-muted hover:bg-surface hover:text-content'}`}
        onClick={handleToggleStorePanel}
        data-testid={tid("analyze-filter-store-toggle")}
      >
        <SlidersHorizontal size={ICON_MD} aria-hidden="true" />
      </button>
    </div>
  )
}
