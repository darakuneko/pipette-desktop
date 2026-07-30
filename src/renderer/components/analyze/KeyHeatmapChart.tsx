// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze > Heatmap — per-physical-key press-count heatmap. Selecting
// layers shows one keyboard per layer (display is never merged); click
// two keyboards to bond them into a single ranking column while each
// keyboard keeps its own keymap visible. i18n-labelled border states
// highlight which keyboards are currently bonded.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TypingBigramAggregateResult, TypingDurationCell, TypingHeatmapByCell, TypingKeymapSnapshot } from '../../../shared/types/typing-analytics'
import type { KeyboardLayout } from '../../../shared/kle/types'
import type { HeatmapFilters } from '../../../shared/types/analyze-filters'
import { scopeToSelectValue } from '../../../shared/types/analyze-filters'
import { fetchBigramAggregateForRange, fetchDurationCellsForRange } from './analyze-fetch'
import { ALL_PAIRS_LIMIT } from './analyze-constants'
import { useEffectiveTheme } from '../../hooks/useEffectiveTheme'
import { useModeFetch } from './use-mode-fetch'
import type { DeviceScope, RangeMs } from './analyze-types'
import {
  FlatRankingTable,
  LayerKeyboard,
  RankingTable,
} from './key-heatmap-panels'
import { HeatmapModeToggle, LayerToggleRow, RankingControls } from './key-heatmap-controls'
import {
  MIN_DURATION_SAMPLE_COUNT,
  MIN_SPEED_SAMPLE_COUNT,
  buildCellDurationStats,
  buildDurationFillByPos,
  buildDurationRanking,
  buildGroupRankings,
  buildKeycodeSpeedMap,
  buildLayerKeycodes,
  buildSpeedFillByPos,
  buildSpeedRanking,
  groupOf,
  layoutPositions,
  normalizeAvgIntensity,
  resolveKeyboardClick,
  toggleLayerSelection,
} from './key-heatmap-helpers'
import type {
  LayerKeycodes,
} from './key-heatmap-helpers'

const MAX_LAYERS = 4

// Stable empty fallbacks for useModeFetch's Speed/Duration instances —
// module-level so they're never a fresh reference the effect could
// mistake for a "changed" dependency (not that it matters for `key`,
// but keeps the initial-state value referentially stable across
// mounts of this component).
const EMPTY_BIGRAM_RESULT: TypingBigramAggregateResult = { view: 'top', entries: [], truncated: false }
const EMPTY_DURATION_CELLS: TypingDurationCell[] = []

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
  // Holds the key of the data currently in `layerCells`, or null when
  // that data came from a failed fetch — null forces a retry the next
  // time Count mode is entered instead of caching the failure. Speed
  // and Duration get the same cache-key contract from `useModeFetch`.
  const matrixFetchKeyRef = useRef<string | null>(null)

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

  // Speed mode's own fetch — the bigram aggregate, not the matrix
  // heatmap — kept independent of `layerCells` above so switching modes
  // doesn't force a refetch of whichever data the other mode already
  // has cached (see useModeFetch for the shared skip/retry contract).
  const speedFetch = useModeFetch(
    mode === 'speed',
    axesKey,
    () => fetchBigramAggregateForRange(
      uid, deviceScope, range.fromMs, range.toMs, 'top', { limit: ALL_PAIRS_LIMIT, gram: 2 },
      appScopes, typingTestScopes, runIdScopes,
    ),
    EMPTY_BIGRAM_RESULT,
  )
  const bigramEntries = speedFetch.data.entries
  const bigramTruncated = speedFetch.data.truncated
  const speedLoading = speedFetch.loading

  // Duration mode's own fetch — one call for the whole range/scope (the
  // per-cell rows already carry a layer tag, so unlike Count mode there
  // is no need to re-fetch per selected layer; layer filtering happens
  // in the memos below).
  const durationFetch = useModeFetch(
    mode === 'duration',
    axesKey,
    () => fetchDurationCellsForRange(uid, deviceScope, range.fromMs, range.toMs, appScopes, typingTestScopes, runIdScopes),
    EMPTY_DURATION_CELLS,
  )
  const durationCells = durationFetch.data
  const durationLoading = durationFetch.loading

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

  // Speed mode: fold the bigram aggregate into a per-keycode avgIki map.
  // Duration mode: the fetched cells already carry a (row, col, layer)
  // tag, no bigram-style keycode indirection needed. Both maps are
  // built once over the mode's full fetched data (not just the selected
  // layers) so the shared min-max normalization scale doesn't shift as
  // the user toggles layers on/off.
  const speedMap = useMemo(
    () => (mode === 'speed' ? buildKeycodeSpeedMap(bigramEntries) : new Map()),
    [mode, bigramEntries],
  )
  const speedIntensityByCode = useMemo(
    () => normalizeAvgIntensity(speedMap, (stat) => stat.avgIki),
    [speedMap],
  )
  const durationStats = useMemo(
    () => (mode === 'duration' ? buildCellDurationStats(durationCells) : new Map()),
    [mode, durationCells],
  )
  const durationIntensityByCellKey = useMemo(
    () => normalizeAvgIntensity(durationStats, (stat) => stat.avgMs),
    [durationStats],
  )
  // One fill-by-layer memo for both modes: resolves each selected
  // layer's own keymap into per-position fills, switching which builder
  // feeds it by `mode` (a keycode can sit at a different position — or
  // not exist at all — on another layer, so the fill map is per layer
  // even though the underlying stats are shared across layers).
  const fillsByLayer = useMemo(() => {
    const result = new Map<number, Map<string, string>>()
    if (mode !== 'speed' && mode !== 'duration') return result
    for (const layer of selectedLayers) {
      const layerKc = layerKeycodes.get(layer)
      if (!layerKc) continue
      const fill = mode === 'speed'
        ? buildSpeedFillByPos(layerKc, positions, speedIntensityByCode, keyGroupFilter, effectiveTheme, snapshot.vialProtocol)
        : buildDurationFillByPos(layer, layerKc, positions, durationIntensityByCellKey, keyGroupFilter, effectiveTheme)
      result.set(layer, fill)
    }
    return result
  }, [mode, selectedLayers, layerKeycodes, positions, speedIntensityByCode, durationIntensityByCellKey, keyGroupFilter, effectiveTheme, snapshot.vialProtocol])
  const speedRanking = useMemo(
    () => (mode === 'speed' ? buildSpeedRanking(speedMap, keyGroupFilter, frequentUsedN, snapshot.vialProtocol) : []),
    [mode, speedMap, keyGroupFilter, frequentUsedN, snapshot.vialProtocol],
  )
  // Gated the same way `groupRankings` (Count) is below: without the
  // `mode === 'duration'` guard this recomputed on every ranking-control
  // change even while parked in Count/Speed, since `layerKeycodes` /
  // `keyGroupFilter` / `frequentUsedN` are shared across all three modes.
  const durationRanking = useMemo(
    () => (mode === 'duration' ? buildDurationRanking(durationCells, layerKeycodes, keyGroupFilter, frequentUsedN) : []),
    [mode, durationCells, layerKeycodes, keyGroupFilter, frequentUsedN],
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

  // Layer selection / bonding rules are pure data transforms — see
  // `toggleLayerSelection` / `resolveKeyboardClick` in
  // key-heatmap-helpers.ts for the full interaction rationale.
  const toggleLayer = (layer: number) => {
    const result = toggleLayerSelection(selectedLayers, groups, layer, MAX_LAYERS)
    if (!result) return
    onHeatmapChange(result.patch)
    if (result.clearMergeCandidate) setMergeCandidate(null)
  }

  const handleKeyboardClick = (layer: number) => {
    const result = resolveKeyboardClick(groups, layer, mergeCandidate)
    if (result.patch) onHeatmapChange(result.patch)
    setMergeCandidate(result.mergeCandidate)
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
    : mode === 'duration'
      ? durationLoading && durationCells.length === 0
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
              keyFillByPos={fillsByLayer.get(layer)}
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
      <LayerToggleRow
        layerOptions={layerOptions}
        selectedLayers={selectedLayers}
        maxLayers={MAX_LAYERS}
        onToggle={toggleLayer}
      />
      <RankingControls
        mode={mode}
        normalization={normalization}
        aggregateMode={aggregateMode}
        keyGroupFilter={keyGroupFilter}
        frequentUsedN={frequentUsedN}
        onHeatmapChange={onHeatmapChange}
      />
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
      {mode === 'duration' && (
        <div className="shrink-0 flex flex-col gap-0.5 text-2xs text-content-muted">
          <div data-testid="analyze-keyheatmap-duration-min-sample-note">
            {t('analyze.keyHeatmap.duration.minSampleNote', { n: MIN_DURATION_SAMPLE_COUNT })}
          </div>
        </div>
      )}
      {mode === 'speed' ? (
        <FlatRankingTable
          entries={speedRanking}
          valueOf={(entry) => entry.avgIki}
          valueColumnKey="analyze.keyHeatmap.speed.colAvgIki"
          emptyKey="analyze.keyHeatmap.speed.empty"
          testIdPrefix="analyze-keyheatmap-speed"
        />
      ) : mode === 'duration' ? (
        <FlatRankingTable
          entries={durationRanking}
          valueOf={(entry) => entry.avgMs}
          valueColumnKey="analyze.keyHeatmap.duration.colAvgDuration"
          emptyKey="analyze.keyHeatmap.duration.empty"
          testIdPrefix="analyze-keyheatmap-duration"
        />
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
