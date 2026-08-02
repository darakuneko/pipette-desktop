// SPDX-License-Identifier: GPL-2.0-or-later
// Pure helpers for the Analyze > Heatmap tab. Keeps the component file
// readable and the math covered by dedicated tests.

import type { TypingBigramTopEntry, TypingDurationCell, TypingHeatmapByCell, TypingHeatmapCell, TypingKeymapSnapshot } from '../../../shared/types/typing-analytics'
import type { KeyboardLayout } from '../../../shared/kle/types'
import { resolveSnapshotLabel, keycodeGroup, deserialize, serialize, codeToLabel } from '../../../shared/keycodes/keycodes'
import type { KeycodeGroup } from '../../../shared/keycodes/keycodes'
import { posKey } from '../../../shared/kle/pos-key'
import { avgIkiFromHist, foldHist, HIST_BUCKETS, parseBigramId } from './analyze-bigram-heatmap'
import { PALETTE_MIN_T, paletteColorFromIntensity } from '../../utils/chart-palette'
import type { EffectiveTheme } from '../../hooks/useEffectiveTheme'
import type { HeatmapNormalization, RangeMs } from './analyze-types'
import type { AggregateMode, HeatmapFilters, KeyGroupFilter } from '../../../shared/types/analyze-filters'
import { withSnapshotProtocol, withSnapshotSerializeProtocol } from './analyze-protocol'

export { AGGREGATE_MODES, KEY_GROUPS, HEATMAP_MODES } from '../../../shared/types/analyze-filters'
export type { AggregateMode, KeyGroupFilter, HeatmapMode } from '../../../shared/types/analyze-filters'

const MASK_INNER_RE = /\((.+)\)$/
const COMPACT_LAYER_OP_RE = /^(LT|LM|MO|DF|PDF|TG|TT|OSL|TO)\s(\d+)$/

export type LabelOverride = { outer: string; inner: string; masked: boolean }

export type LayerKeycodes = {
  keycodes: Map<string, string>
  labelOverrides: Map<string, LabelOverride>
}

export function groupOf(groups: readonly number[][], layer: number): number {
  return groups.findIndex((g) => g.includes(layer))
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

/** Min-max normalizes a map of per-key stats to a [`PALETTE_MIN_T`, 1]
 * intensity (floor = lowest average, 1 = highest) for
 * `paletteColorFromIntensity`. Generic over both the map's key type and
 * its value type — `valueOf` picks the average out of whatever stat
 * shape the caller has (Speed mode's `KeySpeedStat.avgIki`, Duration
 * mode's `KeyDurationStat.avgMs`, ...) so both modes share one
 * normalization pass without either adapting its map into a common
 * shape first. The lower bound matters: the palette skips fills below
 * its visibility floor, but every key that cleared its mode's minimum
 * sample gate must stay distinguishable from a no-data key, so the
 * lowest-average key is pinned at the floor instead of 0. When every
 * qualifying key ties, everything renders at the remapped range's
 * midpoint instead of dividing by zero. */
export function normalizeAvgIntensity<K, V>(
  entries: ReadonlyMap<K, V>,
  valueOf: (value: V) => number,
): Map<K, number> {
  const result = new Map<K, number>()
  if (entries.size === 0) return result
  let min = Infinity
  let max = -Infinity
  for (const stat of entries.values()) {
    const avg = valueOf(stat)
    if (avg < min) min = avg
    if (avg > max) max = avg
  }
  const range = max - min
  for (const [key, stat] of entries) {
    const normalized = range > 0 ? (valueOf(stat) - min) / range : 0.5
    result.set(key, PALETTE_MIN_T + (1 - PALETTE_MIN_T) * normalized)
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
 * under the snapshot's protocol (see `withSnapshotSerializeProtocol`)
 * since the numeric codes were recorded under it — this body calls
 * `serialize`/`codeToLabel` (number → qmkId/label), unlike
 * `buildSpeedFillByPos` above which only `deserialize`s, so it needs
 * the RAWCODES_MAP-rebuilding variant rather than the plain one. */
export function buildSpeedRanking(
  speedMap: ReadonlyMap<number, KeySpeedStat>,
  keyGroupFilter: KeyGroupFilter,
  limit: number,
  vialProtocol?: number,
): SpeedRankingEntry[] {
  return withSnapshotSerializeProtocol(vialProtocol, () => {
    const entries: SpeedRankingEntry[] = []
    for (const [code, stat] of speedMap) {
      if (keyGroupFilter !== 'all' && keycodeGroup(serialize(code)) !== keyGroupFilter) continue
      entries.push({ keyLabel: codeToLabel(code), avgIki: stat.avgIki, count: stat.count })
    }
    entries.sort((a, b) => b.avgIki - a.avgIki)
    return entries.slice(0, Math.max(limit, 0))
  })
}

// --- Duration mode ---------------------------------------------------
// Colours the same keyboard by each key's average keypress duration
// (release ts - press ts). Unlike Speed mode, `TypingDurationCell`
// already carries a (row, col, layer) tag — the data was recorded per
// physical cell, not per keycode — so there is no bigram-style
// cross-layer keycode resolution step: a cell's data belongs to
// exactly the layer it was recorded on.

/** Minimum accumulated duration-sample count for a cell's average
 * duration to be considered reliable enough to paint or rank. Sibling
 * to `MIN_SPEED_SAMPLE_COUNT` (same threshold value today, named for
 * the metric it gates) — the two modes' minimums are independent
 * knobs, so this is a literal rather than a reference to the Speed
 * constant. */
export const MIN_DURATION_SAMPLE_COUNT = 5

export interface KeyDurationStat {
  avgMs: number
  count: number
}

/** `"layer:row,col"` — the composite key every Duration-mode map below
 * is keyed by, since (unlike Speed mode's keycode) the same physical
 * position can carry independent duration data on each layer. Exported
 * so the Heatmap CSV builder (analyze-csv-builders.ts) keys its own
 * duration lookup identically instead of hand-rolling the same string
 * format with nothing enforcing agreement between the two. */
export function durationCellKey(layer: number, pos: string): string {
  return `${layer}:${pos}`
}

/** One avgMs/count stat per (layer, position) from the raw per-cell
 * duration totals the IPC already returns folded across the range (see
 * TypingDurationCell). Cells below `MIN_DURATION_SAMPLE_COUNT` are
 * dropped entirely — same "invisible, not zero" convention as
 * `buildKeycodeSpeedMap`. */
export function buildCellDurationStats(
  cells: readonly TypingDurationCell[],
): Map<string, KeyDurationStat> {
  const result = new Map<string, KeyDurationStat>()
  for (const cell of cells) {
    if (cell.durationSamples < MIN_DURATION_SAMPLE_COUNT) continue
    const key = durationCellKey(cell.layer, posKey(cell.row, cell.col))
    result.set(key, { avgMs: cell.sum / cell.durationSamples, count: cell.durationSamples })
  }
  return result
}

/** Resolves the Duration-mode fill for every physical position on one
 * layer. Simpler than `buildSpeedFillByPos`: the duration stat is
 * already keyed by (layer, position) directly, so there is no
 * keycode-deserialize step — only the keyGroupFilter check needs the
 * position's keycode. */
export function buildDurationFillByPos(
  layer: number,
  layerKeycodes: LayerKeycodes,
  positions: readonly string[],
  intensityByCellKey: ReadonlyMap<string, number>,
  keyGroupFilter: KeyGroupFilter,
  theme: EffectiveTheme,
): Map<string, string> {
  const result = new Map<string, string>()
  for (const pos of positions) {
    const qmkId = layerKeycodes.keycodes.get(pos) ?? ''
    if (!qmkId) continue
    if (keyGroupFilter !== 'all' && keycodeGroup(qmkId) !== keyGroupFilter) continue
    const intensity = intensityByCellKey.get(durationCellKey(layer, pos))
    if (intensity === undefined) continue
    const fill = paletteColorFromIntensity(intensity, theme)
    if (fill) result.set(pos, fill)
  }
  return result
}

export interface DurationRankingEntry {
  keyLabel: string
  avgMs: number
  count: number
}

/** Flat "Key / Avg duration / Samples" ranking for Duration mode,
 * scoped to whichever layers are currently selected (`layerKeycodes`
 * only has entries for those — see KeyHeatmapChart's `layerKeycodes`
 * memo) so the ranking always matches the keyboards on screen. Unlike
 * Speed mode's ranking (which has no layer tag to scope by), Duration
 * data carries one, so this mirrors Count mode's per-selection scoping
 * instead. */
export function buildDurationRanking(
  cells: readonly TypingDurationCell[],
  layerKeycodes: ReadonlyMap<number, LayerKeycodes>,
  keyGroupFilter: KeyGroupFilter,
  limit: number,
): DurationRankingEntry[] {
  const entries: DurationRankingEntry[] = []
  for (const cell of cells) {
    if (cell.durationSamples < MIN_DURATION_SAMPLE_COUNT) continue
    const pos = posKey(cell.row, cell.col)
    const qmkId = layerKeycodes.get(cell.layer)?.keycodes.get(pos) ?? ''
    if (!qmkId) continue
    if (keyGroupFilter !== 'all' && keycodeGroup(qmkId) !== keyGroupFilter) continue
    const resolved = resolveSnapshotLabel(qmkId)
    entries.push({
      keyLabel: compactLayerOp(resolved.outer || qmkId || pos),
      avgMs: cell.sum / cell.durationSamples,
      count: cell.durationSamples,
    })
  }
  entries.sort((a, b) => b.avgMs - a.avgMs)
  return entries.slice(0, Math.max(limit, 0))
}

// --- Layer selection / bonding (pure state transitions) ---------------
// Extracted from KeyHeatmapChart.tsx so the component only wires
// callbacks to `onHeatmapChange` / `setMergeCandidate` — the merge/bond
// rules themselves are plain data transforms, independently testable.

export interface ToggleLayerResult {
  patch: Partial<HeatmapFilters>
  /** Whether the caller should also clear its local merge-candidate
   * state — true only when a layer was deselected (a bonded group it
   * was mid-merge into may no longer make sense). */
  clearMergeCandidate: boolean
}

/** Adds or removes `layer` from the selected-layers set, keeping
 * `groups` in sync (dropping the layer from any group it was bonded
 * into, discarding groups left empty). Returns `null` for a no-op:
 * deselecting the last remaining layer, or selecting past `maxLayers`. */
export function toggleLayerSelection(
  selectedLayers: readonly number[],
  groups: readonly number[][],
  layer: number,
  maxLayers: number,
): ToggleLayerResult | null {
  if (selectedLayers.includes(layer)) {
    if (selectedLayers.length === 1) return null
    const nextLayers = selectedLayers.filter((l) => l !== layer)
    const nextGroups = groups
      .map((g) => g.filter((l) => l !== layer))
      .filter((g) => g.length > 0)
    return { patch: { selectedLayers: nextLayers, groups: nextGroups }, clearMergeCandidate: true }
  }
  if (selectedLayers.length >= maxLayers) return null
  const nextLayers = [...selectedLayers, layer].sort((a, b) => a - b)
  const nextGroups = [...groups, [layer]]
  return { patch: { selectedLayers: nextLayers, groups: nextGroups }, clearMergeCandidate: false }
}

export interface KeyboardClickResult {
  /** Present only when the click changed the group bonding. */
  patch?: Partial<HeatmapFilters>
  /** Value the caller should pass to `setMergeCandidate` unconditionally. */
  mergeCandidate: number | null
}

/** Resolves a keyboard-panel click into a bonding change plus the next
 * merge-candidate state — the two-step "click a standalone panel to
 * arm it, click another to bond them" interaction, and the one-step
 * "click an already-bonded panel to split it back out" interaction.
 * See KeyHeatmapChart.tsx's original inline version for the
 * interaction's full rationale; this is a direct, behavior-preserving
 * extraction. */
export function resolveKeyboardClick(
  groups: readonly number[][],
  layer: number,
  mergeCandidate: number | null,
): KeyboardClickResult {
  if (mergeCandidate !== null) {
    if (mergeCandidate === layer) return { mergeCandidate: null }
    const candidateGroupIdx = groups.findIndex((g) => g.includes(mergeCandidate))
    const targetGroupIdx = groups.findIndex((g) => g.includes(layer))
    if (candidateGroupIdx !== -1 && targetGroupIdx !== -1 && candidateGroupIdx !== targetGroupIdx) {
      const merged = [...new Set([...groups[candidateGroupIdx], ...groups[targetGroupIdx]])]
        .sort((a, b) => a - b)
      const result: number[][] = []
      const lower = Math.min(candidateGroupIdx, targetGroupIdx)
      for (let i = 0; i < groups.length; i += 1) {
        if (i === lower) result.push(merged)
        else if (i === candidateGroupIdx || i === targetGroupIdx) continue
        else result.push(groups[i])
      }
      return { patch: { groups: result }, mergeCandidate: null }
    }
    return { mergeCandidate: null }
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
    return { patch: { groups: result }, mergeCandidate: null }
  }
  // Standalone click with a single existing bonded group → auto-merge
  // into it so the user doesn't have to pre-select the bond first.
  const bondedGroupIdx = groups.findIndex((g) => g.length > 1)
  const multipleBonded = groups.filter((g) => g.length > 1).length > 1
  if (bondedGroupIdx !== -1 && !multipleBonded) {
    const merged = [...new Set([...groups[bondedGroupIdx], ...groups[currentGroupIdx]])]
      .sort((a, b) => a - b)
    const lower = Math.min(bondedGroupIdx, currentGroupIdx)
    const result: number[][] = []
    for (let i = 0; i < groups.length; i += 1) {
      if (i === lower) result.push(merged)
      else if (i === bondedGroupIdx || i === currentGroupIdx) continue
      else result.push(groups[i])
    }
    return { patch: { groups: result }, mergeCandidate: null }
  }
  return { mergeCandidate: layer }
}
