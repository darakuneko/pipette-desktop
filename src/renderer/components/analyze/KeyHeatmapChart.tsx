// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze > Heatmap — per-physical-key press-count heatmap. Selecting
// layers shows one keyboard per layer (display is never merged); click
// two keyboards to bond them into a single ranking column while each
// keyboard keeps its own keymap visible. i18n-labelled border states
// highlight which keyboards are currently bonded.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TypingBigramTopEntry, TypingHeatmapByCell, TypingKeymapSnapshot } from '../../../shared/types/typing-analytics'
import type { KeyboardLayout } from '../../../shared/kle/types'
import type { HeatmapFilters, HeatmapNormalization } from '../../../shared/types/analyze-filters'
import { HEATMAP_NORMALIZATIONS, scopeToSelectValue } from '../../../shared/types/analyze-filters'
import { LIST_LIMIT_OPTIONS } from './analyze-filter-styles'
import { fetchBigramAggregateForRange } from './analyze-fetch'
import { ALL_PAIRS_LIMIT } from './analyze-constants'
import { useEffectiveTheme } from '../../hooks/useEffectiveTheme'
import type { DeviceScope, RangeMs } from './analyze-types'
import {
  HeatmapModeToggle,
  LayerKeyboard,
  RankingTable,
  SpeedRankingTable,
  groupOf,
} from './key-heatmap-panels'
import {
  AGGREGATE_MODES,
  KEY_GROUPS,
  MIN_SPEED_SAMPLE_COUNT,
  buildGroupRankings,
  buildKeycodeSpeedMap,
  buildLayerKeycodes,
  buildSpeedFillByPos,
  buildSpeedRanking,
  layoutPositions,
  normalizeKeySpeedIntensity,
} from './key-heatmap-helpers'
import type {
  AggregateMode,
  KeyGroupFilter,
  LayerKeycodes,
} from './key-heatmap-helpers'

const MAX_LAYERS = 4

interface Props {
  uid: string
  range: RangeMs
  deviceScope: DeviceScope
  /** App filter — see WpmChart.Props.appScopes. */
  appScopes: string[]
  typingTestScopes: string[]
  runIdScopes: string[]
  snapshot: TypingKeymapSnapshot
  /** Persisted filter state for this tab — `selectedLayers` / `groups`
   * / ranking controls / normalization. Lifted to `TypingAnalyticsView`
   * so `useAnalyzeFilters` can round-trip the values through
   * `PipetteSettings.analyze.filters.heatmap`. */
  heatmap: Required<HeatmapFilters>
  onHeatmapChange: (patch: Partial<HeatmapFilters>) => void
}

export function KeyHeatmapChart({ uid, range, deviceScope, appScopes, typingTestScopes, runIdScopes, snapshot, heatmap, onHeatmapChange }: Props) {
  const { t } = useTranslation()
  const { selectedLayers, groups, frequentUsedN, aggregateMode, normalization, keyGroupFilter, mode } = heatmap
  const effectiveTheme = useEffectiveTheme()
  const [layerCells, setLayerCells] = useState<Map<number, TypingHeatmapByCell>>(new Map())
  const [loading, setLoading] = useState(true)
  // `mergeCandidate` and `hoveredKey` stay component-local — they're
  // transient interaction state (pre-bond click, row hover) and don't
  // belong in per-keyboard persisted filters.
  const [mergeCandidate, setMergeCandidate] = useState<number | null>(null)
  const [hoveredKey, setHoveredKey] = useState<string | null>(null)
  // Speed mode's own fetch — the bigram aggregate, not the matrix
  // heatmap. Kept separate from `layerCells` above so switching modes
  // doesn't force a refetch of whichever data the other mode already
  // has cached.
  const [bigramEntries, setBigramEntries] = useState<TypingBigramTopEntry[]>([])
  const [bigramTruncated, setBigramTruncated] = useState(false)
  const [speedLoading, setSpeedLoading] = useState(true)

  const scopeKey = scopeToSelectValue(deviceScope)
  const selectedLayersKey = selectedLayers.join(',')

  // Axes shared by both fetches (uid / range / device scope / app
  // filter). The matrix fetch additionally depends on which layers are
  // selected; the bigram (speed) fetch doesn't, since the aggregate
  // carries no layer tag. Tracking "have I already fetched for this
  // key" per mode lets a Count↔Speed toggle skip re-fetching data it
  // already has, while a filter change made while parked in the other
  // mode still triggers a fresh fetch the next time that mode is
  // entered (see the two effects below). JSON keeps the array parts
  // collision-free — a delimiter join would give ['a|b'] and
  // ['a','b'] the same key and wrongly reuse stale data.
  const axesKey = JSON.stringify([
    uid, range.fromMs, range.toMs, scopeKey,
    appScopes, typingTestScopes, runIdScopes,
  ])
  const matrixFetchKey = `${axesKey}~${selectedLayersKey}`
  // Each ref holds the key of the data currently in state, or null when
  // that data came from a failed fetch — null forces a retry the next
  // time the owning mode is entered instead of caching the failure.
  const matrixFetchKeyRef = useRef<string | null>(null)
  const speedFetchKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (mode !== 'count') return
    if (matrixFetchKeyRef.current === matrixFetchKey) {
      setLoading(false)
      return
    }
    // Fetch every selected layer in lock-step whenever any axis
    // changes (uid / range / device scope / app filter / selected
    // layer set). Splitting the cache-clear from the fetch into two
    // effects loses the second effect's stale-state read: clearing
    // schedules a layerCells={} update, but the fetch effect closes
    // over the previous (still-populated) cells, sees "nothing new
    // to fetch" and exits — leaving the rendered Map empty until the
    // user touches another input. Recompute the whole map atomically.
    let cancelled = false
    let anyFailed = false
    setLoading(true)
    void Promise.all(selectedLayers.map((layer) =>
      window.vialAPI
        .typingAnalyticsGetMatrixHeatmapForRange(uid, layer, range.fromMs, range.toMs, deviceScope, appScopes, typingTestScopes, runIdScopes)
        .catch(() => {
          anyFailed = true
          return {} as TypingHeatmapByCell
        }),
    )).then((results) => {
      if (cancelled) return
      const next = new Map<number, TypingHeatmapByCell>()
      selectedLayers.forEach((layer, i) => next.set(layer, results[i] ?? {}))
      setLayerCells(next)
      matrixFetchKeyRef.current = anyFailed ? null : matrixFetchKey
      setLoading(false)
    })
    return () => { cancelled = true }
    // selectedLayersKey carries the layer-set identity (joined string)
    // so an unchanged array doesn't refire on every render.
  }, [mode, uid, range, scopeKey, selectedLayersKey, appScopes, typingTestScopes, runIdScopes, matrixFetchKey])

  useEffect(() => {
    if (mode !== 'speed') return
    if (speedFetchKeyRef.current === axesKey) {
      setSpeedLoading(false)
      return
    }
    let cancelled = false
    setSpeedLoading(true)
    fetchBigramAggregateForRange(
      uid, deviceScope, range.fromMs, range.toMs, 'top', { limit: ALL_PAIRS_LIMIT, gram: 2 },
      appScopes, typingTestScopes, runIdScopes,
    )
      .then((result) => {
        if (cancelled) return
        setBigramEntries(result.entries)
        setBigramTruncated(result.truncated)
        speedFetchKeyRef.current = axesKey
        setSpeedLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setBigramEntries([])
        setBigramTruncated(false)
        speedFetchKeyRef.current = null
        setSpeedLoading(false)
      })
    return () => { cancelled = true }
  }, [mode, uid, range, scopeKey, appScopes, typingTestScopes, runIdScopes, axesKey])

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

  // Speed mode: fold the bigram aggregate into a per-keycode avgIki map,
  // then resolve it into per-position fills for each selected layer's
  // own keymap (a keycode can sit at a different position — or not
  // exist at all — on another layer, so the fill map is per layer even
  // though the underlying speed stats are shared).
  const speedMap = useMemo(
    () => (mode === 'speed' ? buildKeycodeSpeedMap(bigramEntries) : new Map()),
    [mode, bigramEntries],
  )
  const speedIntensityByCode = useMemo(
    () => normalizeKeySpeedIntensity(speedMap),
    [speedMap],
  )
  const speedFillsByLayer = useMemo(() => {
    const result = new Map<number, Map<string, string>>()
    if (mode !== 'speed') return result
    for (const layer of selectedLayers) {
      const layerKc = layerKeycodes.get(layer)
      if (!layerKc) continue
      result.set(layer, buildSpeedFillByPos(layerKc, positions, speedIntensityByCode, keyGroupFilter, effectiveTheme, snapshot.vialProtocol))
    }
    return result
  }, [mode, selectedLayers, layerKeycodes, positions, speedIntensityByCode, keyGroupFilter, effectiveTheme, snapshot.vialProtocol])
  const speedRanking = useMemo(
    () => buildSpeedRanking(speedMap, keyGroupFilter, frequentUsedN, snapshot.vialProtocol),
    [speedMap, keyGroupFilter, frequentUsedN, snapshot.vialProtocol],
  )

  // Only Count mode renders the group ranking table — skip the
  // computation entirely in Speed mode instead of building rankings
  // no one reads.
  const groupRankings = useMemo(
    () => mode === 'count' ? groups.map((group) => buildGroupRankings(
      group, layerCells, layerKeycodes, positions, range, normalization,
      aggregateMode, keyGroupFilter, frequentUsedN,
    )) : [],
    [mode, groups, layerCells, layerKeycodes, positions, range, normalization, aggregateMode, keyGroupFilter, frequentUsedN],
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
      <div className="py-4 text-center text-sm text-content-muted" data-testid="analyze-keyheatmap-nolayout">
        {t('analyze.keyHeatmap.noLayout')}
      </div>
    )
  }

  const showLoading = mode === 'speed'
    ? speedLoading && bigramEntries.length === 0
    : loading && layerCells.size === 0
  if (showLoading) {
    return (
      <div className="py-4 text-center text-sm text-content-muted" data-testid="analyze-keyheatmap-loading">
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
      <div className="flex shrink-0 justify-end">
        <HeatmapModeToggle value={mode} onChange={(next) => onHeatmapChange({ mode: next })} />
      </div>
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
              mode={mode}
              layerCells={layerCells}
              layerKeycodes={layerKeycodes}
              speedFillByPos={speedFillsByLayer.get(layer)}
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
        className="flex shrink-0 flex-wrap items-center justify-end gap-1 text-xs"
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
              className={`flex w-8 shrink-0 items-center justify-center rounded-md border py-1.5 text-xs font-semibold tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
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
        <h3 className="text-xs font-semibold uppercase tracking-widest text-content-muted">
          {t('analyze.keyHeatmap.ranking.frequentUsed')}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          {mode === 'count' && (
            <>
              <select
                className="rounded-md border border-edge bg-surface px-2 py-1 text-xs text-content focus:border-accent focus:outline-none"
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
                className="rounded-md border border-edge bg-surface px-2 py-1 text-xs text-content focus:border-accent focus:outline-none"
                value={aggregateMode}
                onChange={(e) => onHeatmapChange({ aggregateMode: e.target.value as AggregateMode })}
                aria-label={t('analyze.keyHeatmap.ranking.aggregate')}
                data-testid="analyze-keyheatmap-aggregate"
              >
                {AGGREGATE_MODES.map((m) => (
                  <option key={m} value={m}>{t(`analyze.keyHeatmap.ranking.aggregateOption.${m}`)}</option>
                ))}
              </select>
            </>
          )}
          <select
            className="rounded-md border border-edge bg-surface px-2 py-1 text-xs text-content focus:border-accent focus:outline-none"
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
            className="rounded-md border border-edge bg-surface px-2 py-1 text-xs text-content focus:border-accent focus:outline-none"
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
      {mode === 'speed' && (
        <div className="shrink-0 flex flex-col gap-0.5 text-2xs text-content-muted">
          <div data-testid="analyze-keyheatmap-speed-min-sample-note">
            {t('analyze.keyHeatmap.speed.minSampleNote', { n: MIN_SPEED_SAMPLE_COUNT })}
          </div>
          {bigramTruncated && (
            <div data-testid="analyze-keyheatmap-speed-capped-notice">
              {t('analyze.keyHeatmap.speed.cappedNotice', { limit: ALL_PAIRS_LIMIT })}
            </div>
          )}
        </div>
      )}
      {mode === 'speed' ? (
        <SpeedRankingTable entries={speedRanking} />
      ) : (
        <RankingTable
          groups={groups}
          groupRankings={groupRankings}
          frequentUsedN={frequentUsedN}
          hoveredKey={hoveredKey}
          setHoveredKey={setHoveredKey}
          formatCount={formatCount}
          t={t}
        />
      )}
    </div>
  )
}
