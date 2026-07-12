// SPDX-License-Identifier: GPL-2.0-or-later
// Presentational sub-components for the Analyze > Heatmap tab —
// the per-layer keyboard panel, the Count-mode ranking table, the
// Speed-mode ranking table, and the Count/Speed mode toggle. Split out
// of KeyHeatmapChart.tsx so the container component (state, effects,
// data plumbing) stays under the file-splitting size guideline.

import { memo, useMemo } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { TypingHeatmapByCell, TypingHeatmapCell } from '../../../shared/types/typing-analytics'
import type { KeyboardLayout } from '../../../shared/kle/types'
import { KeyboardWidget } from '../keyboard/KeyboardWidget'
import { SegmentedToggle } from './SegmentedToggle'
import { fmtMs } from './analyze-format'
import type { HeatmapNormalization, RangeMs } from './analyze-types'
import {
  HEATMAP_MODES,
  filterCellsByGroup,
  sumAndNormalizeGroupCells,
} from './key-heatmap-helpers'
import type {
  HeatmapMode,
  KeyGroupFilter,
  LayerKeycodes,
  RankingEntry,
  SpeedRankingEntry,
} from './key-heatmap-helpers'

// Stable empty-map reference for Speed mode, where the Count-mode-only
// cell memos below are skipped entirely — avoids allocating a fresh
// Map every render just to hand KeyboardWidget "no data".
const EMPTY_HEATMAP_CELLS = new Map<string, TypingHeatmapCell>()

export interface LayerKeyboardProps {
  layer: number
  groupIdx: number
  mode: HeatmapMode
  layerCells: Map<number, TypingHeatmapByCell>
  layerKeycodes: Map<number, LayerKeycodes>
  /** Precomputed Speed-mode fill per position — only meaningful (and
   * only computed by the parent) when `mode === 'speed'`. */
  speedFillByPos?: Map<string, string>
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
  speedFillByPos,
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
  const isSpeed = mode === 'speed'
  const layerKc = layerKeycodes.get(layer)
  const keycodes = layerKc?.keycodes ?? new Map<string, string>()
  const labelOverrides = layerKc?.labelOverrides ?? new Map()
  const singletonGroup = useMemo(() => [layer], [layer])
  // Count-mode-only: Speed mode paints from `speedFillByPos` instead
  // (via `keyColors` below), so skip summing/filtering/scanning cells
  // no one reads while the user stays in Speed mode.
  const groupHeatmapCells = useMemo(
    () => isSpeed
      ? EMPTY_HEATMAP_CELLS
      : sumAndNormalizeGroupCells(singletonGroup, layerCells, range, normalization),
    [isSpeed, singletonGroup, layerCells, range, normalization],
  )
  const filteredHeatmapCells = useMemo(
    () => isSpeed
      ? EMPTY_HEATMAP_CELLS
      : filterCellsByGroup(groupHeatmapCells, keycodes, keyGroupFilter),
    [isSpeed, groupHeatmapCells, keycodes, keyGroupFilter],
  )
  // A single unified max drives the outer rect colour so masked cells
  // (painted by `hold`) and non-masked cells (painted by `total`) share
  // the same scale. Otherwise an LT1 hovering at its own peak looks as
  // red as a character key at its peak despite having a much smaller
  // absolute count.
  const { heatmapMaxOuter, heatmapMaxTap } = useMemo(() => {
    if (isSpeed) return { heatmapMaxOuter: 0, heatmapMaxTap: 0 }
    let outer = 0
    let tap = 0
    for (const cell of filteredHeatmapCells.values()) {
      const outerVal = cell.hold > 0 ? cell.hold : cell.total
      if (outerVal > outer) outer = outerVal
      if (cell.tap > tap) tap = cell.tap
    }
    return { heatmapMaxOuter: outer, heatmapMaxTap: tap }
  }, [isSpeed, filteredHeatmapCells])

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
        heatmapCells={isSpeed ? undefined : filteredHeatmapCells}
        heatmapMaxTotal={heatmapMaxOuter}
        heatmapMaxTap={heatmapMaxTap}
        heatmapMaxHold={heatmapMaxOuter}
        keyColors={isSpeed ? speedFillByPos : undefined}
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

export interface SpeedRankingTableProps {
  entries: SpeedRankingEntry[]
}

const SPEED_GRID = { gridTemplateColumns: '2.5rem minmax(0, 7rem) 6rem 6rem' }

/** Flat "Key / Avg IKI / Samples" ranking for Speed mode. Unlike
 * `RankingTable`, this isn't scoped to layer groups — the bigram
 * aggregate the ranking is built from carries no layer tag (see
 * `buildSpeedRanking`), so there is exactly one ranking regardless of
 * how many layer panels are selected/bonded above. */
export const SpeedRankingTable = memo(function SpeedRankingTable({ entries }: SpeedRankingTableProps) {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-0 w-fit flex-1 flex-col" data-testid="analyze-keyheatmap-speed-ranking">
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        <div className="sticky top-0 z-10 bg-surface">
          <div
            className="grid border-b border-edge text-2xs font-semibold uppercase tracking-wider text-content-muted"
            style={SPEED_GRID}
          >
            <div />
            <span className="truncate px-2 py-1">{t('analyze.keyHeatmap.ranking.colKey')}</span>
            <span className="px-2 py-1 text-right">{t('analyze.keyHeatmap.speed.colAvgIki')}</span>
            <span className="px-2 py-1 text-right">{t('analyze.keyHeatmap.ranking.colCount')}</span>
          </div>
        </div>
        {entries.length === 0 ? (
          <div className="py-2 text-xs text-content-muted" data-testid="analyze-keyheatmap-speed-empty">
            {t('analyze.keyHeatmap.speed.empty')}
          </div>
        ) : (
          entries.map((entry, rankIdx) => (
            <div
              key={`${entry.keyLabel}-${rankIdx}`}
              className={`grid text-xs ${rankIdx % 2 === 1 ? 'bg-surface-dim/40' : ''}`}
              style={SPEED_GRID}
            >
              <span className="px-2 py-1 text-right text-content-muted">{rankIdx + 1}</span>
              <span className="min-w-0 truncate px-2 py-1 font-mono text-content">{entry.keyLabel}</span>
              <span className="px-2 py-1 text-right font-mono text-content-secondary">
                {fmtMs(entry.avgIki)}
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
})

const HEATMAP_MODE_LABEL_KEY: Record<HeatmapMode, string> = {
  count: 'analyze.keyHeatmap.modeToggle.count',
  speed: 'analyze.keyHeatmap.modeToggle.speed',
}

export interface HeatmapModeToggleProps {
  value: HeatmapMode
  onChange: (next: HeatmapMode) => void
}

/** Segmented Count / Speed switch — built from the same `SegmentedToggle`
 * primitive as the Bigrams gram toggle so the two tabs' mode switches
 * read as the same control family. */
export function HeatmapModeToggle({ value, onChange }: HeatmapModeToggleProps): JSX.Element {
  const { t } = useTranslation()
  return (
    <SegmentedToggle
      options={HEATMAP_MODES}
      value={value}
      onChange={onChange}
      labelFor={(option) => t(HEATMAP_MODE_LABEL_KEY[option])}
      ariaLabel={t('analyze.keyHeatmap.modeToggle.ariaLabel')}
      testId="analyze-keyheatmap-mode-toggle"
    />
  )
}

export function groupOf(groups: number[][], layer: number): number {
  return groups.findIndex((g) => g.includes(layer))
}
