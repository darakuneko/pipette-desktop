// SPDX-License-Identifier: GPL-2.0-or-later
// Pure helpers for the Analyze > Heatmap tab. Keeps the component file
// readable and the math covered by dedicated tests.

import type { TypingBigramTopEntry, TypingHeatmapByCell, TypingHeatmapCell, TypingKeymapSnapshot } from '../../../shared/types/typing-analytics'
import type { KeyboardLayout } from '../../../shared/kle/types'
import { resolveSnapshotLabel, keycodeGroup, deserialize, serialize, codeToLabel } from '../../../shared/keycodes/keycodes'
import type { KeycodeGroup } from '../../../shared/keycodes/keycodes'
import { posKey } from '../../../shared/kle/pos-key'
import { avgIkiFromHist, foldHist, HIST_BUCKETS, parseBigramId } from './analyze-bigram-heatmap'
import { PALETTE_MIN_T, paletteColorFromIntensity } from '../../utils/chart-palette'
import type { EffectiveTheme } from '../../hooks/useEffectiveTheme'
import type { HeatmapNormalization, RangeMs } from './analyze-types'
import { withSnapshotProtocol } from './analyze-protocol'

export { AGGREGATE_MODES, KEY_GROUPS, HEATMAP_MODES } from '../../../shared/types/analyze-filters'
export type { AggregateMode, KeyGroupFilter, HeatmapMode } from '../../../shared/types/analyze-filters'

const MASK_INNER_RE = /\((.+)\)$/
const COMPACT_LAYER_OP_RE = /^(LT|LM|MO|DF|PDF|TG|TT|OSL|TO)\s(\d+)$/

export type LabelOverride = { outer: string; inner: string; masked: boolean }

export type LayerKeycodes = {
  keycodes: Map<string, string>
  labelOverrides: Map<string, LabelOverride>
}

export function compactLayerOp(label: string): string {
  const m = label.match(COMPACT_LAYER_OP_RE)
  return m ? `${m[1]}${m[2]}` : label
}

export function buildLayerKeycodes(snapshot: TypingKeymapSnapshot, layer: number): LayerKeycodes {
  const keycodes = new Map<string, string>()
  const labelOverrides = new Map<string, LabelOverride>()
  const rows = Array.isArray(snapshot.keymap) ? snapshot.keymap[layer] : undefined
  if (!Array.isArray(rows)) return { keycodes, labelOverrides }
  for (let r = 0; r < snapshot.matrix.rows; r += 1) {
    const rowArr = rows[r]
    if (!Array.isArray(rowArr)) continue
    for (let c = 0; c < snapshot.matrix.cols; c += 1) {
      const qmkId = rowArr[c] ?? ''
      const pos = posKey(r, c)
      keycodes.set(pos, qmkId)
      labelOverrides.set(pos, resolveSnapshotLabel(qmkId))
    }
  }
  return { keycodes, labelOverrides }
}

export function makeScale(
  rawTotal: number,
  range: RangeMs,
  normalization: HeatmapNormalization,
): (v: number) => number {
  const rangeHours = Math.max(1 / 60, (range.toMs - range.fromMs) / 3_600_000)
  if (normalization === 'perHour') return (v: number) => v / rangeHours
  if (normalization === 'shareOfTotal') return (v: number) => rawTotal > 0 ? (v / rawTotal) * 100 : 0
  return (v: number) => v
}

export function layoutPositions(layout: KeyboardLayout): string[] {
  if (!Array.isArray(layout.keys)) return []
  return layout.keys
    .filter((k) => !k.decal && !k.ghost)
    .map((k) => posKey(k.row, k.col))
}

export function sumAndNormalizeGroupCells(
  group: number[],
  layerCells: Map<number, TypingHeatmapByCell>,
  range: RangeMs,
  normalization: HeatmapNormalization,
): Map<string, TypingHeatmapCell> {
  const raw: Record<string, { total: number; tap: number; hold: number }> = {}
  for (const layerId of group) {
    const cells = layerCells.get(layerId)
    if (!cells) continue
    for (const [pos, c] of Object.entries(cells)) {
      const e = raw[pos] ?? { total: 0, tap: 0, hold: 0 }
      e.total += c.total
      e.tap += c.tap
      e.hold += c.hold
      raw[pos] = e
    }
  }
  const rawTotal = Object.values(raw).reduce((s, c) => s + c.total, 0)
  const scale = makeScale(rawTotal, range, normalization)
  const m = new Map<string, TypingHeatmapCell>()
  for (const [pos, cell] of Object.entries(raw)) {
    m.set(pos, { total: scale(cell.total), tap: scale(cell.tap), hold: scale(cell.hold) })
  }
  return m
}

export function filterCellsByGroup(
  heatmapCells: Map<string, TypingHeatmapCell>,
  keycodes: Map<string, string>,
  filter: KeyGroupFilter,
): Map<string, TypingHeatmapCell> {
  if (filter === 'all') return heatmapCells
  const m = new Map<string, TypingHeatmapCell>()
  for (const [pos, cell] of heatmapCells) {
    const qmkId = keycodes.get(pos) ?? ''
    const masked = resolveSnapshotLabel(qmkId).masked
    const outerMatch = keycodeGroup(qmkId) === filter
    let innerMatch = false
    if (masked) {
      const innerExec = MASK_INNER_RE.exec(qmkId)
      const innerQmkId = innerExec ? innerExec[1] : ''
      innerMatch = keycodeGroup(innerQmkId) === filter
    }
    if (!outerMatch && !innerMatch) continue
    if (!masked) {
      m.set(pos, cell)
      continue
    }
    m.set(pos, {
      total: outerMatch ? cell.total : 0,
      tap: innerMatch ? cell.tap : 0,
      hold: outerMatch ? cell.hold : 0,
    })
  }
  return m
}

export type RankingEntry = {
  displayLabel: string
  keyLabel: string
  layerLabel: string
  matrixLabel: string
  count: number
  cellsByLayer: Map<number, Set<string>>
}

function addCell(entry: RankingEntry, layer: number, pos: string): void {
  let set = entry.cellsByLayer.get(layer)
  if (!set) {
    set = new Set<string>()
    entry.cellsByLayer.set(layer, set)
  }
  set.add(pos)
}

export function buildGroupRankings(
  group: number[],
  layerCells: Map<number, TypingHeatmapByCell>,
  layerKeycodes: Map<number, LayerKeycodes>,
  positions: string[],
  range: RangeMs,
  normalization: HeatmapNormalization,
  aggregateMode: AggregateMode,
  keyGroupFilter: KeyGroupFilter,
  frequentUsedN: number,
): RankingEntry[] {
  type RawEntry = {
    baseLabel: string
    layer: number
    cell: string
    count: number
    group: KeycodeGroup
  }
  const groupSum: Record<string, { total: number; tap: number; hold: number }> = {}
  for (const layerId of group) {
    const cells = layerCells.get(layerId)
    if (!cells) continue
    for (const [pos, c] of Object.entries(cells)) {
      const e = groupSum[pos] ?? { total: 0, tap: 0, hold: 0 }
      e.total += c.total
      e.tap += c.tap
      e.hold += c.hold
      groupSum[pos] = e
    }
  }
  const rawTotal = Object.values(groupSum).reduce((s, c) => s + c.total, 0)
  const scale = makeScale(rawTotal, range, normalization)

  const raw: RawEntry[] = []
  for (const layerId of group) {
    const keycodesForLayer = layerKeycodes.get(layerId)?.keycodes ?? new Map()
    const cells = layerCells.get(layerId) ?? {}
    for (const pos of positions) {
      const qmkId = keycodesForLayer.get(pos) ?? ''
      const resolved = resolveSnapshotLabel(qmkId)
      const rawCell = cells[pos] ?? { total: 0, tap: 0, hold: 0 }
      const total = scale(rawCell.total)
      const tap = scale(rawCell.tap)
      if (resolved.masked) {
        if (resolved.outer) {
          raw.push({
            baseLabel: compactLayerOp(resolved.outer),
            layer: layerId,
            cell: pos,
            count: total - tap,
            group: keycodeGroup(qmkId),
          })
        }
        if (resolved.inner) {
          const innerExec = MASK_INNER_RE.exec(qmkId)
          const innerQmkId = innerExec ? innerExec[1] : ''
          raw.push({
            baseLabel: resolved.inner,
            layer: layerId,
            cell: pos,
            count: tap,
            group: keycodeGroup(innerQmkId),
          })
        }
      } else {
        raw.push({
          baseLabel: compactLayerOp(resolved.outer || qmkId || pos),
          layer: layerId,
          cell: pos,
          count: total,
          group: keycodeGroup(qmkId),
        })
      }
    }
  }
  const filtered = keyGroupFilter === 'all'
    ? raw
    : raw.filter((r) => r.group === keyGroupFilter)

  let entries: RankingEntry[]
  if (aggregateMode === 'char') {
    const byBase = new Map<string, RankingEntry>()
    for (const r of filtered) {
      let e = byBase.get(r.baseLabel)
      if (!e) {
        e = {
          displayLabel: r.baseLabel,
          keyLabel: r.baseLabel,
          layerLabel: '',
          matrixLabel: '',
          count: 0,
          cellsByLayer: new Map(),
        }
        byBase.set(r.baseLabel, e)
      }
      e.count += r.count
      addCell(e, r.layer, r.cell)
    }
    entries = Array.from(byBase.values())
  } else {
    const isMultiLayer = group.length > 1
    const freq = new Map<string, number>()
    for (const r of filtered) freq.set(r.baseLabel, (freq.get(r.baseLabel) ?? 0) + 1)
    entries = filtered.map((r) => {
      const [row, col] = r.cell.split(',')
      const matrixLabel = `Row:${row} Col:${col}`
      const layerLabel = isMultiLayer ? `L${r.layer}` : ''
      const displayLabel = isMultiLayer
        ? `${r.baseLabel} Layer${r.layer} Row:${row} Col:${col}`
        : (freq.get(r.baseLabel) ?? 0) > 1
          ? `${r.baseLabel} Row:${row} Col:${col}`
          : r.baseLabel
      const cellsByLayer = new Map<number, Set<string>>()
      cellsByLayer.set(r.layer, new Set([r.cell]))
      return {
        displayLabel,
        keyLabel: r.baseLabel,
        layerLabel,
        matrixLabel,
        count: r.count,
        cellsByLayer,
      }
    })
  }
  return [...entries].sort((a, b) => b.count - a.count).slice(0, frequentUsedN)
}

// --- Speed mode ----------------------------------------------------------
// Colours the same keyboard by "how slow is the average reach into this
// key" instead of press count. Reuses the bigram aggregate (already
// fetched by the Bigrams tab) rather than a dedicated per-key query: each
// bigram's "to" keycode gets its histogram folded into a per-keycode
// total, mirroring `aggregateFingerPairs` in analyze-bigram-finger.ts but
// keyed by a single keycode instead of a (from, to) finger pair.

/** Minimum accumulated reach count for a keycode's average IKI to be
 * considered reliable enough to paint or rank. Below this the key
 * renders exactly like a key with zero data — no fill, no ranking row. */
export const MIN_SPEED_SAMPLE_COUNT = 5

export interface KeySpeedStat {
  avgIki: number
  count: number
}

/** Accumulate every bigram pair's histogram onto its "to" (second)
 * keycode, then resolve each keycode's count-weighted average reach
 * IKI. Folding histograms first and running `avgIkiFromHist` once is
 * mathematically identical to a count-weighted average of the
 * individual pairs' `avgIki` values (both reduce to
 * `sum(bucket_count * bucket_center) / sum(bucket_count)`), so this
 * reuses the existing bucket-center estimator instead of re-deriving
 * the weighting. Keycodes below `MIN_SPEED_SAMPLE_COUNT` are dropped
 * entirely. */
export function buildKeycodeSpeedMap(
  entries: readonly TypingBigramTopEntry[],
): Map<number, KeySpeedStat> {
  const accByCode = new Map<number, { hist: number[]; count: number }>()
  for (const entry of entries) {
    const pair = parseBigramId(entry.ngramId)
    if (!pair) continue
    let acc = accByCode.get(pair.curr)
    if (!acc) {
      acc = { hist: new Array<number>(HIST_BUCKETS).fill(0), count: 0 }
      accByCode.set(pair.curr, acc)
    }
    foldHist(acc.hist, entry.hist)
    acc.count += entry.count
  }
  const result = new Map<number, KeySpeedStat>()
  for (const [code, acc] of accByCode) {
    if (acc.count < MIN_SPEED_SAMPLE_COUNT) continue
    const avgIki = avgIkiFromHist(acc.hist)
    if (avgIki === null) continue
    result.set(code, { avgIki, count: acc.count })
  }
  return result
}

/** Min-max normalizes each qualifying keycode's avgIki to a
 * [`PALETTE_MIN_T`, 1] intensity (floor = fastest reach, 1 = slowest)
 * for `paletteColorFromIntensity`. The lower bound matters: the palette
 * skips fills below its visibility floor, but every key that cleared
 * `MIN_SPEED_SAMPLE_COUNT` must stay distinguishable from a no-data
 * key, so the fastest key is pinned at the floor instead of 0. When
 * every qualifying key ties, everything renders at the remapped range's
 * midpoint instead of dividing by zero. */
export function normalizeKeySpeedIntensity(
  speedMap: ReadonlyMap<number, KeySpeedStat>,
): Map<number, number> {
  const result = new Map<number, number>()
  if (speedMap.size === 0) return result
  let min = Infinity
  let max = -Infinity
  for (const stat of speedMap.values()) {
    if (stat.avgIki < min) min = stat.avgIki
    if (stat.avgIki > max) max = stat.avgIki
  }
  const range = max - min
  for (const [code, stat] of speedMap) {
    const normalized = range > 0 ? (stat.avgIki - min) / range : 0.5
    result.set(code, PALETTE_MIN_T + (1 - PALETTE_MIN_T) * normalized)
  }
  return result
}

/** Resolves the Speed-mode fill for every physical position on one
 * layer: look up that position's keycode on the layer's keymap, decode
 * it to the numeric code the bigram aggregate uses (under the
 * snapshot's own protocol — see `withSnapshotProtocol`), then paint
 * from the shared intensity map. Positions whose keycode has no
 * qualifying speed data (below `MIN_SPEED_SAMPLE_COUNT`, or never seen
 * as the "to" side of a bigram) are omitted so the caller's default key
 * fill shows through — same "no data" convention as the Count-mode
 * heatmap. */
export function buildSpeedFillByPos(
  layerKeycodes: LayerKeycodes,
  positions: readonly string[],
  intensityByCode: ReadonlyMap<number, number>,
  keyGroupFilter: KeyGroupFilter,
  theme: EffectiveTheme,
  vialProtocol?: number,
): Map<string, string> {
  return withSnapshotProtocol(vialProtocol, () => {
    const result = new Map<string, string>()
    for (const pos of positions) {
      const qmkId = layerKeycodes.keycodes.get(pos) ?? ''
      if (!qmkId) continue
      if (keyGroupFilter !== 'all' && keycodeGroup(qmkId) !== keyGroupFilter) continue
      let code: number
      try {
        code = deserialize(qmkId)
      } catch {
        continue
      }
      if (!Number.isFinite(code)) continue
      const intensity = intensityByCode.get(code)
      if (intensity === undefined) continue
      const fill = paletteColorFromIntensity(intensity, theme)
      if (fill) result.set(pos, fill)
    }
    return result
  })
}

export interface SpeedRankingEntry {
  keyLabel: string
  avgIki: number
  count: number
}

/** Ranks qualifying keycodes slowest-reach-first for the Speed
 * ranking table. Unlike the Count ranking, this isn't scoped to a
 * layer group — the bigram aggregate carries no layer tag, so one flat
 * ranking covers every selected layer. Labels and group filtering run
 * under the snapshot's protocol (see `withSnapshotProtocol`) since the
 * numeric codes were recorded under it. */
export function buildSpeedRanking(
  speedMap: ReadonlyMap<number, KeySpeedStat>,
  keyGroupFilter: KeyGroupFilter,
  limit: number,
  vialProtocol?: number,
): SpeedRankingEntry[] {
  return withSnapshotProtocol(vialProtocol, () => {
    const entries: SpeedRankingEntry[] = []
    for (const [code, stat] of speedMap) {
      if (keyGroupFilter !== 'all' && keycodeGroup(serialize(code)) !== keyGroupFilter) continue
      entries.push({ keyLabel: codeToLabel(code), avgIki: stat.avgIki, count: stat.count })
    }
    entries.sort((a, b) => b.avgIki - a.avgIki)
    return entries.slice(0, Math.max(limit, 0))
  })
}
