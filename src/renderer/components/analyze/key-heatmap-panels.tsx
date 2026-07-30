// SPDX-License-Identifier: GPL-2.0-or-later
// Presentational sub-components for the Analyze > Heatmap tab — the
// per-layer keyboard panel, and the Count/Speed/Duration ranking
// tables. Split out of KeyHeatmapChart.tsx so the container component
// (state, effects, data plumbing) stays under the file-splitting size
// guideline; the mode toggle and toolbar-row controls live alongside
// in key-heatmap-controls.tsx for the same reason.

import { memo, useMemo } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { TypingHeatmapByCell, TypingHeatmapCell } from '../../../shared/types/typing-analytics'
import type { KeyboardLayout } from '../../../shared/kle/types'
import { KeyboardWidget } from '../keyboard/KeyboardWidget'
import { fmtMs } from './analyze-format'
import type { HeatmapNormalization, RangeMs } from './analyze-types'
import {
  filterCellsByGroup,
  sumAndNormalizeGroupCells,
} from './key-heatmap-helpers'
import type {
  HeatmapMode,
  KeyGroupFilter,
  LayerKeycodes,
  RankingEntry,
} from './key-heatmap-helpers'

// Stable empty-map reference for Speed and Duration mode, where the
// Count-mode-only cell memos below are skipped entirely — avoids
// allocating a fresh Map every render just to hand KeyboardWidget
// "no data".
const EMPTY_HEATMAP_CELLS = new Map<string, TypingHeatmapCell>()

export interface LayerKeyboardProps {
  layer: number
  groupIdx: number
  mode: HeatmapMode
  layerCells: Map<number, TypingHeatmapByCell>
  layerKeycodes: Map<number, LayerKeycodes>
  /** Precomputed Speed/Duration-mode fill per position — only
   * meaningful (and only computed by the parent) when `mode` is one of
   * those two; the parent picks which builder fed it (see
   * KeyHeatmapChart's `fillsByLayer` memo). */
  keyFillByPos?: Map<string, string>
  layout: KeyboardLayout
  range: RangeMs
  normalization: HeatmapNormalization
  keyGroupFilter: KeyGroupFilter
  highlightedCells?: Set<string>
  isMergeCandidate: boolean
  isBonded: boolean
  scale: number
  onClick: () => void
  t: TFunction
}

export const LayerKeyboard = memo(function LayerKeyboard({
  layer,
  groupIdx,
  mode,
  layerCells,
  layerKeycodes,
  keyFillByPos,
  layout,
  range,
  normalization,
  keyGroupFilter,
  highlightedCells,
  isMergeCandidate,
  isBonded,
  scale,
  onClick,
  t,
}: LayerKeyboardProps) {
  // Both Speed and Duration paint from a single precomputed keyColors
  // map (`keyFillByPos`) instead of the Count-mode heatmapCells path —
  // see the memos below.
  const usesKeyColors = mode === 'speed' || mode === 'duration'
  const layerKc = layerKeycodes.get(layer)
  const keycodes = layerKc?.keycodes ?? new Map<string, string>()
  const labelOverrides = layerKc?.labelOverrides ?? new Map()
  const singletonGroup = useMemo(() => [layer], [layer])
  // Count-mode-only: Speed/Duration mode paints from their own
  // precomputed fill map instead (via `keyColors` below), so skip
  // summing/filtering/scanning cells no one reads outside Count mode.
  const groupHeatmapCells = useMemo(
    () => usesKeyColors
      ? EMPTY_HEATMAP_CELLS
      : sumAndNormalizeGroupCells(singletonGroup, layerCells, range, normalization),
    [usesKeyColors, singletonGroup, layerCells, range, normalization],
  )
  const filteredHeatmapCells = useMemo(
    () => usesKeyColors
      ? EMPTY_HEATMAP_CELLS
      : filterCellsByGroup(groupHeatmapCells, keycodes, keyGroupFilter),
    [usesKeyColors, groupHeatmapCells, keycodes, keyGroupFilter],
  )
  // A single unified max drives the outer rect colour so masked cells
  // (painted by `hold`) and non-masked cells (painted by `total`) share
  // the same scale. Otherwise an LT1 hovering at its own peak looks as
  // red as a character key at its peak despite having a much smaller
  // absolute count.
  const { heatmapMaxOuter, heatmapMaxTap } = useMemo(() => {
    if (usesKeyColors) return { heatmapMaxOuter: 0, heatmapMaxTap: 0 }
    let outer = 0
    let tap = 0
    for (const cell of filteredHeatmapCells.values()) {
      const outerVal = cell.hold > 0 ? cell.hold : cell.total
      if (outerVal > outer) outer = outerVal
      if (cell.tap > tap) tap = cell.tap
    }
    return { heatmapMaxOuter: outer, heatmapMaxTap: tap }
  }, [usesKeyColors, filteredHeatmapCells])

  const borderClass = isMergeCandidate
    ? 'border-accent bg-accent/5'
    : isBonded
      ? 'border-accent'
      : 'border-edge'

  return (
    <button
      type="button"
      className={`flex shrink-0 flex-col items-center gap-1 rounded-md border-2 p-1 transition-colors ${borderClass}`}
      onClick={onClick}
      aria-pressed={isMergeCandidate}
      aria-label={t('analyze.keyHeatmap.bondToggle', { i: layer })}
      data-testid={`analyze-keyheatmap-layer-panel-${layer}`}
      data-group-idx={groupIdx}
    >
      <KeyboardWidget
        keys={layout.keys}
        keycodes={keycodes}
        labelOverrides={labelOverrides}
        heatmapCells={usesKeyColors ? undefined : filteredHeatmapCells}
        heatmapMaxTotal={heatmapMaxOuter}
        heatmapMaxTap={heatmapMaxTap}
        heatmapMaxHold={heatmapMaxOuter}
        keyColors={usesKeyColors ? keyFillByPos : undefined}
        highlightedKeys={highlightedCells}
        readOnly
        scale={scale}
      />
      <span className="text-xs font-semibold uppercase tracking-widest text-content-muted">
        {t('analyze.keyHeatmap.layerOption', { i: layer })}
      </span>
    </button>
  )
})

export interface RankingTableProps {
  groups: number[][]
  groupRankings: RankingEntry[][]
  frequentUsedN: number
  hoveredKey: string | null
  setHoveredKey: Dispatch<SetStateAction<string | null>>
  formatCount: (n: number) => string
  t: TFunction
}

// Fixed sub-column widths so header and data rows align. The `Layer`
// sub-column is dropped when no group contains multiple layers — the
// group header already pins the layer in that case.
const SUB_GRID_WITH_LAYER = {
  gridTemplateColumns: 'minmax(0, 7rem) 4.5rem 8rem 5rem',
}
const SUB_GRID_NO_LAYER = {
  gridTemplateColumns: 'minmax(0, 7rem) 8rem 5rem',
}

export const RankingTable = memo(function RankingTable({
  groups,
  groupRankings,
  frequentUsedN,
  hoveredKey,
  setHoveredKey,
  formatCount,
  t,
}: RankingTableProps) {
  const maxRank = Math.max(1, ...groupRankings.map((r) => r.length))
  const rows = Math.min(frequentUsedN, maxRank)
  const showLayerCol = groups.some((g) => g.length > 1)
  const subGrid = showLayerCol ? SUB_GRID_WITH_LAYER : SUB_GRID_NO_LAYER
  // Each group cell is `sub-grid content + px-2 padding` wide; plus the
  // rank column. Compute the explicit total so the grid rows don't grow
  // to fill the parent's extra space.
  const perGroupRem = showLayerCol ? 27 : 22
  const totalWidthRem = 2.5 + groups.length * perGroupRem
  const outerGrid = {
    gridTemplateColumns: `2.5rem repeat(${groups.length}, auto)`,
    width: `${totalWidthRem}rem`,
  }
  const groupLabelFor = (group: number[]): string => group.length === 1
    ? t('analyze.keyHeatmap.layerOption', { i: group[0] })
    : t('analyze.keyHeatmap.layerOptionMulti', { layers: group.join(', ') })
  const anyEntry = rows > 0 && groupRankings.some((r) => r.length > 0)
  return (
    <div className="flex min-h-0 w-fit flex-1 flex-col" data-testid="analyze-keyheatmap-ranking">
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        <div className="sticky top-0 z-10 bg-surface">
          <div
            className="grid text-xs font-semibold text-content-muted"
            style={outerGrid}
          >
            <div />
            {groups.map((group, i) => (
              <div key={group.join('-')} className="truncate px-2 py-1" data-testid={`analyze-keyheatmap-ranking-head-${i}`}>
                {groupLabelFor(group)}
              </div>
            ))}
          </div>
          <div
            className="grid border-b border-edge text-2xs font-semibold uppercase tracking-wider text-content-muted"
            style={outerGrid}
          >
            <div />
            {groups.map((group) => (
              <div key={group.join('-')} className="grid items-center gap-2 px-2 py-1" style={subGrid}>
                <span className="truncate">{t('analyze.keyHeatmap.ranking.colKey')}</span>
                {showLayerCol && <span>{t('analyze.keyHeatmap.ranking.colLayer')}</span>}
                <span>{t('analyze.keyHeatmap.ranking.colMatrix')}</span>
                <span className="text-right">{t('analyze.keyHeatmap.ranking.colCount')}</span>
              </div>
            ))}
          </div>
        </div>
        {!anyEntry ? (
          <div className="py-2 text-xs text-content-muted">
            {t('analyze.keyHeatmap.ranking.emptyFrequentUsed')}
          </div>
        ) : (
          Array.from({ length: rows }, (_, rankIdx) => (
            <div
              key={rankIdx}
              className={`grid text-xs ${rankIdx % 2 === 1 ? 'bg-surface-dim/40' : ''}`}
              style={outerGrid}
            >
              <span className="px-2 py-1 text-right text-content-muted">{rankIdx + 1}</span>
              {groups.map((group, gIdx) => {
                const entry = groupRankings[gIdx]?.[rankIdx]
                if (!entry) return <span key={group.join('-')} />
                const key = `${gIdx}:${entry.displayLabel}`
                return (
                  <div
                    key={group.join('-')}
                    className={`grid cursor-pointer items-center gap-2 px-2 py-1 ${
                      hoveredKey === key ? 'bg-accent/10' : ''
                    }`}
                    style={subGrid}
                    onMouseEnter={() => setHoveredKey(() => key)}
                    onMouseLeave={() => setHoveredKey((prev) => (prev === key ? null : prev))}
                  >
                    <span className="min-w-0 truncate font-mono text-content">{entry.keyLabel}</span>
                    {showLayerCol && (
                      <span className="font-mono text-xs text-content-muted">{entry.layerLabel}</span>
                    )}
                    <span className="font-mono text-xs text-content-muted">{entry.matrixLabel}</span>
                    <span className="text-right font-mono text-content-secondary">{formatCount(entry.count)}</span>
                  </div>
                )
              })}
            </div>
          ))
        )}
      </div>
    </div>
  )
})

export interface FlatRankingTableProps<E extends { keyLabel: string; count: number }> {
  entries: E[]
  /** Pulls the value column's number out of whatever entry shape the
   * caller has (Speed's `avgIki`, Duration's `avgMs`, ...) — same
   * accessor-over-adapter-map approach as `normalizeAvgIntensity`. */
  valueOf: (entry: E) => number
  /** i18n key for the value column header (e.g. "Avg IKI" / "Avg Duration"). */
  valueColumnKey: string
  /** i18n key for the empty-state message. */
  emptyKey: string
  /** `data-testid` prefix — the table gets `${testIdPrefix}-ranking`,
   * the empty state `${testIdPrefix}-empty`. */
  testIdPrefix: string
}

const FLAT_RANKING_GRID = { gridTemplateColumns: '2.5rem minmax(0, 7rem) 6rem 6rem' }

/** Flat "Key / <value> / Samples" ranking shared by Speed and Duration
 * mode — neither is scoped to layer groups the way Count's
 * `RankingTable` is (Speed's bigram aggregate carries no layer tag at
 * all; Duration's `buildDurationRanking` already pre-scopes to the
 * selected layers itself), so both render as one flat list regardless
 * of how many layer panels are selected/bonded above. Both call sites'
 * value columns are milliseconds by construction, so `fmtMs` is called
 * directly here rather than threaded through as a `formatValue` prop.
 * Wrapped in `memo`, matching the pre-refactor `SpeedRankingTable` this
 * component generalized (that wrapper was silently dropped by the
 * extraction). `valueOf` is still an inline closure at every call site
 * today, so this alone still defeats memo's shallow prop comparison on
 * every parent render — unlike the removed `formatValue`, dropping it
 * doesn't fix that; a stable `valueOf` reference at the call sites
 * would be needed for `memo` to actually skip renders. */
function FlatRankingTableImpl<E extends { keyLabel: string; count: number }>({
  entries, valueOf, valueColumnKey, emptyKey, testIdPrefix,
}: FlatRankingTableProps<E>): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-0 w-fit flex-1 flex-col" data-testid={`${testIdPrefix}-ranking`}>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        <div className="sticky top-0 z-10 bg-surface">
          <div
            className="grid border-b border-edge text-2xs font-semibold uppercase tracking-wider text-content-muted"
            style={FLAT_RANKING_GRID}
          >
            <div />
            <span className="truncate px-2 py-1">{t('analyze.keyHeatmap.ranking.colKey')}</span>
            <span className="px-2 py-1 text-right">{t(valueColumnKey)}</span>
            <span className="px-2 py-1 text-right">{t('analyze.keyHeatmap.ranking.colCount')}</span>
          </div>
        </div>
        {entries.length === 0 ? (
          <div className="py-2 text-xs text-content-muted" data-testid={`${testIdPrefix}-empty`}>
            {t(emptyKey)}
          </div>
        ) : (
          entries.map((entry, rankIdx) => (
            <div
              key={`${entry.keyLabel}-${rankIdx}`}
              className={`grid text-xs ${rankIdx % 2 === 1 ? 'bg-surface-dim/40' : ''}`}
              style={FLAT_RANKING_GRID}
            >
              <span className="px-2 py-1 text-right text-content-muted">{rankIdx + 1}</span>
              <span className="min-w-0 truncate px-2 py-1 font-mono text-content">{entry.keyLabel}</span>
              <span className="px-2 py-1 text-right font-mono text-content-secondary">
                {fmtMs(valueOf(entry))}
              </span>
              <span className="px-2 py-1 text-right font-mono text-content-secondary">
                {entry.count.toLocaleString()}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export const FlatRankingTable = memo(FlatRankingTableImpl) as typeof FlatRankingTableImpl

// Mode toggle + toolbar-row controls (HeatmapModeToggle, LayerToggleRow,
// RankingControls) now live in key-heatmap-controls.tsx.
