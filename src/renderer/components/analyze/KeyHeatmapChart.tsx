// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze > Heatmap — per-physical-key press-count heatmap. Selecting
// layers shows one keyboard per layer (display is never merged); click
// two keyboards to bond them into a single ranking column while each
// keyboard keeps its own keymap visible. i18n-labelled border states
// highlight which keyboards are currently bonded.

import { memo, useEffect, useMemo, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { TypingHeatmapByCell, TypingKeymapSnapshot } from '../../../shared/types/typing-analytics'
import type { KeyboardLayout } from '../../../shared/kle/types'
import type { HeatmapFilters } from '../../../shared/types/analyze-filters'
import { HEATMAP_NORMALIZATIONS, scopeToSelectValue } from '../../../shared/types/analyze-filters'
import { KeyboardWidget } from '../keyboard/KeyboardWidget'
import { LIST_LIMIT_OPTIONS } from './analyze-filter-styles'
import type { DeviceScope, HeatmapNormalization, RangeMs } from './analyze-types'
import {
  AGGREGATE_MODES,
  KEY_GROUPS,
  buildGroupRankings,
  buildLayerKeycodes,
  filterCellsByGroup,
  layoutPositions,
  sumAndNormalizeGroupCells,
} from './key-heatmap-helpers'
import type { AggregateMode, KeyGroupFilter, LayerKeycodes, RankingEntry } from './key-heatmap-helpers'

const MAX_LAYERS = 4

interface Props {
  uid: string
  range: RangeMs
  deviceScope: DeviceScope
  /** App filter — see WpmChart.Props.appScopes. */
  appScopes: string[]
  snapshot: TypingKeymapSnapshot
  /** Persisted filter state for this tab — `selectedLayers` / `groups`
   * / ranking controls / normalization. Lifted to `TypingAnalyticsView`
   * so `useAnalyzeFilters` can round-trip the values through
   * `PipetteSettings.analyze.filters.heatmap`. */
  heatmap: Required<HeatmapFilters>
  onHeatmapChange: (patch: Partial<HeatmapFilters>) => void
}

interface LayerKeyboardProps {
  layer: number
  groupIdx: number
  layerCells: Map<number, TypingHeatmapByCell>
  layerKeycodes: Map<number, LayerKeycodes>
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

const LayerKeyboard = memo(function LayerKeyboard({
  layer,
  groupIdx,
  layerCells,
  layerKeycodes,
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
  const layerKc = layerKeycodes.get(layer)
  const keycodes = layerKc?.keycodes ?? new Map<string, string>()
  const labelOverrides = layerKc?.labelOverrides ?? new Map()
  const singletonGroup = useMemo(() => [layer], [layer])
  const groupHeatmapCells = useMemo(
    () => sumAndNormalizeGroupCells(singletonGroup, layerCells, range, normalization),
    [singletonGroup, layerCells, range, normalization],
  )
  const filteredHeatmapCells = useMemo(
    () => filterCellsByGroup(groupHeatmapCells, keycodes, keyGroupFilter),
    [groupHeatmapCells, keycodes, keyGroupFilter],
  )
  // A single unified max drives the outer rect colour so masked cells
  // (painted by `hold`) and non-masked cells (painted by `total`) share
  // the same scale. Otherwise an LT1 hovering at its own peak looks as
  // red as a character key at its peak despite having a much smaller
  // absolute count.
  const { heatmapMaxOuter, heatmapMaxTap } = useMemo(() => {
    let outer = 0
    let tap = 0
    for (const cell of filteredHeatmapCells.values()) {
      const outerVal = cell.hold > 0 ? cell.hold : cell.total
      if (outerVal > outer) outer = outerVal
      if (cell.tap > tap) tap = cell.tap
    }
    return { heatmapMaxOuter: outer, heatmapMaxTap: tap }
  }, [filteredHeatmapCells])

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
        heatmapCells={filteredHeatmapCells}
        heatmapMaxTotal={heatmapMaxOuter}
        heatmapMaxTap={heatmapMaxTap}
        heatmapMaxHold={heatmapMaxOuter}
        highlightedKeys={highlightedCells}
        readOnly
        scale={scale}
      />
      <span className="text-[11px] font-semibold uppercase tracking-widest text-content-muted">
        {t('analyze.keyHeatmap.layerOption', { i: layer })}
      </span>
    </button>
  )
})

interface RankingTableProps {
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

const RankingTable = memo(function RankingTable({
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
            className="grid text-[11px] font-semibold text-content-muted"
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
            className="grid border-b border-edge text-[10px] font-semibold uppercase tracking-wider text-content-muted"
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
          <div className="py-2 text-[12px] text-content-muted">
            {t('analyze.keyHeatmap.ranking.emptyFrequentUsed')}
          </div>
        ) : (
          Array.from({ length: rows }, (_, rankIdx) => (
            <div
              key={rankIdx}
              className={`grid text-[12px] ${rankIdx % 2 === 1 ? 'bg-surface-dim/40' : ''}`}
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
                      <span className="font-mono text-[11px] text-content-muted">{entry.layerLabel}</span>
                    )}
                    <span className="font-mono text-[11px] text-content-muted">{entry.matrixLabel}</span>
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

function groupOf(groups: number[][], layer: number): number {
  return groups.findIndex((g) => g.includes(layer))
}

export function KeyHeatmapChart({ uid, range, deviceScope, appScopes, snapshot, heatmap, onHeatmapChange }: Props) {
  const { t } = useTranslation()
  const { selectedLayers, groups, frequentUsedN, aggregateMode, normalization, keyGroupFilter } = heatmap
  const [layerCells, setLayerCells] = useState<Map<number, TypingHeatmapByCell>>(new Map())
  const [loading, setLoading] = useState(true)
  // `mergeCandidate` and `hoveredKey` stay component-local — they're
  // transient interaction state (pre-bond click, row hover) and don't
  // belong in per-keyboard persisted filters.
  const [mergeCandidate, setMergeCandidate] = useState<number | null>(null)
  const [hoveredKey, setHoveredKey] = useState<string | null>(null)

  const scopeKey = scopeToSelectValue(deviceScope)

  const selectedLayersKey = selectedLayers.join(',')
  useEffect(() => {
    // Fetch every selected layer in lock-step whenever any axis
    // changes (uid / range / device scope / app filter / selected
    // layer set). Splitting the cache-clear from the fetch into two
    // effects loses the second effect's stale-state read: clearing
    // schedules a layerCells={} update, but the fetch effect closes
    // over the previous (still-populated) cells, sees "nothing new
    // to fetch" and exits — leaving the rendered Map empty until the
    // user touches another input. Recompute the whole map atomically.
    let cancelled = false
    setLoading(true)
    void Promise.all(selectedLayers.map((layer) =>
      window.vialAPI
        .typingAnalyticsGetMatrixHeatmapForRange(uid, layer, range.fromMs, range.toMs, deviceScope, appScopes)
        .catch(() => ({} as TypingHeatmapByCell)),
    )).then((results) => {
      if (cancelled) return
      const next = new Map<number, TypingHeatmapByCell>()
      selectedLayers.forEach((layer, i) => next.set(layer, results[i] ?? {}))
      setLayerCells(next)
      setLoading(false)
    })
    return () => { cancelled = true }
    // selectedLayersKey carries the layer-set identity (joined string)
    // so an unchanged array doesn't refire on every render.
  }, [uid, range, scopeKey, selectedLayersKey, appScopes])

  const layout = snapshot.layout as KeyboardLayout | null

  const layerKeycodes = useMemo(() => {
    const m = new Map<number, LayerKeycodes>()
    for (const layer of selectedLayers) {
      m.set(layer, buildLayerKeycodes(snapshot, layer))
    }
    return m
  }, [snapshot, selectedLayersKey])

  const positions = useMemo(
    () => (layout ? layoutPositions(layout) : []),
    [layout],
  )

  const groupRankings = useMemo(
    () => groups.map((group) => buildGroupRankings(
      group, layerCells, layerKeycodes, positions, range, normalization,
      aggregateMode, keyGroupFilter, frequentUsedN,
    )),
    [groups, layerCells, layerKeycodes, positions, range, normalization, aggregateMode, keyGroupFilter, frequentUsedN],
  )

  const hoveredCellsByLayer = useMemo<Map<number, Set<string>>>(() => {
    const result = new Map<number, Set<string>>()
    if (!hoveredKey) return result
    const [idxStr, ...rest] = hoveredKey.split(':')
    const gIdx = Number.parseInt(idxStr, 10)
    const label = rest.join(':')
    const match = groupRankings[gIdx]?.find((e) => e.displayLabel === label)
    if (!match) return result
    for (const [layer, cells] of match.cellsByLayer) {
      result.set(layer, cells)
    }
    return result
  }, [hoveredKey, groupRankings])

  const formatCount = (n: number): string => {
    if (normalization === 'shareOfTotal') return `${n.toFixed(2)}%`
    if (normalization === 'perHour') return `${n.toFixed(1)}/h`
    return Math.round(n).toLocaleString()
  }

  const toggleLayer = (layer: number) => {
    if (selectedLayers.includes(layer)) {
      if (selectedLayers.length === 1) return
      const nextLayers = selectedLayers.filter((l) => l !== layer)
      const nextGroups = groups
        .map((g) => g.filter((l) => l !== layer))
        .filter((g) => g.length > 0)
      onHeatmapChange({ selectedLayers: nextLayers, groups: nextGroups })
      setMergeCandidate(null)
      return
    }
    if (selectedLayers.length >= MAX_LAYERS) return
    const nextLayers = [...selectedLayers, layer].sort((a, b) => a - b)
    const nextGroups = [...groups, [layer]]
    onHeatmapChange({ selectedLayers: nextLayers, groups: nextGroups })
  }

  const handleKeyboardClick = (layer: number) => {
    if (mergeCandidate !== null) {
      if (mergeCandidate === layer) {
        setMergeCandidate(null)
        return
      }
      const candidateGroupIdx = groups.findIndex((g) => g.includes(mergeCandidate))
      const targetGroupIdx = groups.findIndex((g) => g.includes(layer))
      if (candidateGroupIdx !== -1 && targetGroupIdx !== -1 && candidateGroupIdx !== targetGroupIdx) {
        const merged = [...new Set([...groups[candidateGroupIdx], ...groups[targetGroupIdx]])]
          .sort((x, y) => x - y)
        const result: number[][] = []
        const lower = Math.min(candidateGroupIdx, targetGroupIdx)
        for (let i = 0; i < groups.length; i += 1) {
          if (i === lower) result.push(merged)
          else if (i === candidateGroupIdx || i === targetGroupIdx) continue
          else result.push(groups[i])
        }
        onHeatmapChange({ groups: result })
      }
      setMergeCandidate(null)
      return
    }
    const currentGroupIdx = groupOf(groups, layer)
    const currentGroup = groups[currentGroupIdx]
    const isBonded = !!currentGroup && currentGroup.length > 1
    if (isBonded) {
      const result: number[][] = []
      for (const g of groups) {
        if (g.includes(layer)) {
          const without = g.filter((l) => l !== layer)
          if (without.length > 0) result.push(without)
          result.push([layer])
        } else {
          result.push(g)
        }
      }
      onHeatmapChange({ groups: result })
      return
    }
    // Standalone click with a single existing bonded group → auto-merge
    // into it so the user doesn't have to pre-select the bond first.
    const bondedGroupIdx = groups.findIndex((g) => g.length > 1)
    const multipleBonded = groups.filter((g) => g.length > 1).length > 1
    if (bondedGroupIdx !== -1 && !multipleBonded) {
      const merged = [...new Set([...groups[bondedGroupIdx], ...groups[currentGroupIdx]])]
        .sort((x, y) => x - y)
      const lower = Math.min(bondedGroupIdx, currentGroupIdx)
      const result: number[][] = []
      for (let i = 0; i < groups.length; i += 1) {
        if (i === lower) result.push(merged)
        else if (i === bondedGroupIdx || i === currentGroupIdx) continue
        else result.push(groups[i])
      }
      onHeatmapChange({ groups: result })
      return
    }
    setMergeCandidate(layer)
  }

  if (!layout || !Array.isArray(layout.keys)) {
    return (
      <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-keyheatmap-nolayout">
        {t('analyze.keyHeatmap.noLayout')}
      </div>
    )
  }

  if (loading && layerCells.size === 0) {
    return (
      <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-keyheatmap-loading">
        {t('common.loading')}
      </div>
    )
  }

  const layerOptions = Array.from({ length: Math.max(1, snapshot.layers) }, (_, i) => i)
  // Keep 1-2 keyboards inside the container (no scroll); from 3+ the
  // row starts to overflow and the user scrolls horizontally. 0.5 is
  // tuned so two side-by-side panels fit the typical Analyze column
  // width without clipping.
  const keyboardScale = selectedLayers.length === 1 ? 1 : 0.5

  return (
    <div className="flex h-full min-h-0 flex-col gap-3" data-testid="analyze-keyheatmap-chart">
      <div className="shrink-0" data-testid="analyze-keyheatmap-panels">
        <div
          className={`grid justify-center gap-2 ${
            selectedLayers.length === 1 ? 'grid-cols-1' : 'grid-cols-2'
          }`}
        >
        {selectedLayers.map((layer) => {
          const gIdx = groupOf(groups, layer)
          const isBonded = (groups[gIdx]?.length ?? 0) > 1
          return (
            <LayerKeyboard
              key={layer}
              layer={layer}
              groupIdx={gIdx}
              layerCells={layerCells}
              layerKeycodes={layerKeycodes}
              layout={layout}
              range={range}
              normalization={normalization}
              keyGroupFilter={keyGroupFilter}
              highlightedCells={hoveredCellsByLayer.get(layer)}
              isMergeCandidate={mergeCandidate === layer}
              isBonded={isBonded}
              scale={keyboardScale}
              onClick={() => handleKeyboardClick(layer)}
              t={t}
            />
          )
        })}
        </div>
      </div>
      <div
        className="flex shrink-0 flex-wrap items-center justify-end gap-1 text-[12px]"
        role="group"
        aria-label={t('analyze.keyHeatmap.layer')}
        data-testid="analyze-keyheatmap-layers"
      >
        {layerOptions.map((i) => {
          const isSelected = selectedLayers.includes(i)
          const isDisabled = !isSelected && selectedLayers.length >= MAX_LAYERS
          return (
            <button
              key={i}
              type="button"
              aria-pressed={isSelected}
              aria-label={t('analyze.keyHeatmap.layerOption', { i })}
              onClick={() => toggleLayer(i)}
              disabled={isDisabled}
              className={`flex w-8 shrink-0 items-center justify-center rounded-md border py-1.5 text-[12px] font-semibold tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                isSelected
                  ? 'border-accent bg-accent text-content-inverse'
                  : 'border-edge bg-surface/20 text-content-muted hover:bg-surface-dim'
              }`}
              data-testid={`analyze-keyheatmap-layer-${i}`}
            >
              {i}
            </button>
          )
        })}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-widest text-content-muted">
          {t('analyze.keyHeatmap.ranking.frequentUsed')}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="rounded-md border border-edge bg-surface px-2 py-1 text-[12px] text-content focus:border-accent focus:outline-none"
            value={normalization}
            onChange={(e) => onHeatmapChange({ normalization: e.target.value as HeatmapNormalization })}
            aria-label={t('analyze.filters.normalization')}
            data-testid="analyze-keyheatmap-normalization"
          >
            {HEATMAP_NORMALIZATIONS.map((n) => (
              <option key={n} value={n}>{t(`analyze.filters.normalizationOption.${n}`)}</option>
            ))}
          </select>
          <select
            className="rounded-md border border-edge bg-surface px-2 py-1 text-[12px] text-content focus:border-accent focus:outline-none"
            value={aggregateMode}
            onChange={(e) => onHeatmapChange({ aggregateMode: e.target.value as AggregateMode })}
            aria-label={t('analyze.keyHeatmap.ranking.aggregate')}
            data-testid="analyze-keyheatmap-aggregate"
          >
            {AGGREGATE_MODES.map((m) => (
              <option key={m} value={m}>{t(`analyze.keyHeatmap.ranking.aggregateOption.${m}`)}</option>
            ))}
          </select>
          <select
            className="rounded-md border border-edge bg-surface px-2 py-1 text-[12px] text-content focus:border-accent focus:outline-none"
            value={keyGroupFilter}
            onChange={(e) => onHeatmapChange({ keyGroupFilter: e.target.value as KeyGroupFilter })}
            aria-label={t('analyze.keyHeatmap.ranking.keyGroup')}
            data-testid="analyze-keyheatmap-keygroup"
          >
            {KEY_GROUPS.map((g) => (
              <option key={g} value={g}>{t(`analyze.keyHeatmap.ranking.keyGroupOption.${g}`)}</option>
            ))}
          </select>
          <select
            className="rounded-md border border-edge bg-surface px-2 py-1 text-[12px] text-content focus:border-accent focus:outline-none"
            value={frequentUsedN}
            onChange={(e) => onHeatmapChange({ frequentUsedN: Number.parseInt(e.target.value, 10) })}
            aria-label={t('analyze.keyHeatmap.ranking.frequentUsedN')}
            data-testid="analyze-keyheatmap-frequent-used-n"
          >
            {LIST_LIMIT_OPTIONS.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>
      </div>
      <RankingTable
        groups={groups}
        groupRankings={groupRankings}
        frequentUsedN={frequentUsedN}
        hoveredKey={hoveredKey}
        setHoveredKey={setHoveredKey}
        formatCount={formatCount}
        t={t}
      />
    </div>
  )
}
