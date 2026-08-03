// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
import type { TypingTestResult } from '../../shared/types/pipette-settings'
import type { TypingTestStats } from './history-stats'
import { WpmSparkline } from './WpmSparkline'
import { AccuracyTrendSection } from './AccuracyTrendSection'
import { MistakeRankingSection } from './MistakeRankingSection'
import { ErrorMixSection } from './ErrorMixSection'

interface Props {
  /** Active tab's unfiltered results (mode filter doesn't apply — each
   *  section below scopes/filters independently, matching their own
   *  prop docs in AccuracyTrendSection/MistakeRankingSection/ErrorMixSection). */
  tabResults: TypingTestResult[]
  /** Stats computed from the mode-filtered `filtered` set (not `tabResults`). */
  stats: TypingTestStats
  /** Sparkline series, already sliced/reversed from `filtered`. */
  sparklineResults: TypingTestResult[]
}

interface StatItemProps {
  label: string
  value: number | string
  highlight?: boolean
}

function StatItem({ label, value, highlight }: StatItemProps) {
  return (
    // Baseline-align so the mono value digits sit level with the sans label
    // (their font metrics differ, so items-center looks vertically off).
    <div className="flex items-baseline gap-1.5">
      <span className="text-content-muted">{label}:</span>
      <span className={`font-mono font-semibold ${highlight ? 'text-accent' : ''}`}>{value}</span>
    </div>
  )
}

/** Everything between the History modal's top tabs and its results table:
 *  sparkline, stats summary, accuracy trend, mistake ranking, error mix.
 *  Split out of `TypingTestHistory` purely to keep that file under the
 *  500-line component cap (`.claude/rules/file-splitting.md`) — this wraps
 *  in its own `min-h-0 shrink overflow-y-auto` container so a tall stack
 *  (e.g. many mistake-ranking rows) scrolls independently instead of
 *  pushing the results table past the modal's bottom edge (flex children
 *  don't shrink below their content height otherwise). */
export function HistorySections({ tabResults, stats, sparklineResults }: Props) {
  const { t } = useTranslation()

  return (
    <div className="flex min-h-0 shrink flex-col gap-3 overflow-y-auto" data-testid="history-sections">
      {/* Sparkline — chart-above-stats, matching every other Analyze section's order */}
      {sparklineResults.length >= 2 && (
        <div className="flex justify-center" data-testid="history-sparkline">
          <WpmSparkline results={sparklineResults} width={400} height={50} />
        </div>
      )}

      {/* Stats summary */}
      <div className="flex flex-wrap items-center gap-6 text-sm" data-testid="history-stats">
        <StatItem label={t('editor.typingTest.history.bestWpm')} value={stats.bestWpm} highlight />
        <StatItem label={t('editor.typingTest.history.avgWpm')} value={stats.avgWpm} />
        <StatItem label={t('editor.typingTest.history.last10Avg')} value={stats.last10Avg} />
        <StatItem label={t('editor.typingTest.history.totalTests')} value={stats.totalTests} />
        <StatItem label={t('editor.typingTest.history.avgAccuracy')} value={`${stats.avgAccuracy}%`} />
      </div>

      <AccuracyTrendSection results={tabResults} />
      <MistakeRankingSection results={tabResults} />
      <ErrorMixSection results={tabResults} />
    </div>
  )
}
