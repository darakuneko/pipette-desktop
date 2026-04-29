// SPDX-License-Identifier: GPL-2.0-or-later
//
// Per-physical-position heatmap of the load shift between the user's
// current layout (treated as `targets[0]`) and a candidate target
// (`targets[1]`). Each cell is coloured by the signed share-of-events
// delta — red shades when the candidate puts MORE work on that
// physical key, blue shades when it puts less. Intensity is scaled
// against the largest absolute delta so the picture stays readable
// regardless of total event volume.

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { posKey } from '../../../shared/kle/pos-key'
import type { KleKey } from '../../../shared/kle/types'
import type { LayoutComparisonTargetResult } from '../../../shared/types/typing-analytics'
import { KeyboardWidget } from '../keyboard/KeyboardWidget'

interface Props {
  current: LayoutComparisonTargetResult
  target: LayoutComparisonTargetResult
  kleKeys: readonly KleKey[]
  /** Display name for the candidate target column. */
  targetLabel: string
}

const ZERO_EPSILON = 1e-6
// Tailwind red-500 / blue-500 RGB triplets. Held as bare numbers so
// `colorFor` and the legend Swatches share one source of truth and
// the alpha gradient stays consistent with the painted cells.
const INCREASE_RGB = '239, 68, 68'
const DECREASE_RGB = '59, 130, 246'
// Floor on alpha so faintly-different keys still register; the rest
// scales linearly with normalized magnitude up to the peak alpha.
const MIN_ALPHA = 0.15
const ALPHA_RANGE = 0.7
// Solid swatches in the legend should still hit the peak intensity
// the painted cells reach, not full saturation, so the legend
// matches what the user actually sees.
const LEGEND_ALPHA = MIN_ALPHA + ALPHA_RANGE

/**
 * Build per-position diffs as a *share of total resolved events* on
 * each side, so a small device with few events doesn't drown out a
 * large device. Returns `null` when totals are zero (no useful
 * intensity scale possible).
 */
function buildDiffShares(
  current: LayoutComparisonTargetResult,
  target: LayoutComparisonTargetResult,
): { diffs: Map<string, number>; maxAbs: number } | null {
  if (current.totalEvents <= 0 && target.totalEvents <= 0) return null
  const positions = new Set<string>()
  // cellCounts is optional in the wire type; treat absent as empty.
  for (const pos of Object.keys(current.cellCounts ?? {})) positions.add(pos)
  for (const pos of Object.keys(target.cellCounts ?? {})) positions.add(pos)
  const currTotal = current.totalEvents
  const tgtTotal = target.totalEvents
  const diffs = new Map<string, number>()
  let maxAbs = 0
  for (const pos of positions) {
    const currShare = currTotal > 0 ? (current.cellCounts?.[pos] ?? 0) / currTotal : 0
    const tgtShare = tgtTotal > 0 ? (target.cellCounts?.[pos] ?? 0) / tgtTotal : 0
    const diff = tgtShare - currShare
    diffs.set(pos, diff)
    const abs = Math.abs(diff)
    if (abs > maxAbs) maxAbs = abs
  }
  return { diffs, maxAbs }
}

/** Returns `null` when the diff is below visual threshold; caller
 * skips painting that cell. */
function colorFor(diff: number, maxAbs: number): string | null {
  if (maxAbs <= ZERO_EPSILON) return null
  if (Math.abs(diff) <= ZERO_EPSILON) return null
  const intensity = Math.min(Math.abs(diff) / maxAbs, 1)
  const alpha = (MIN_ALPHA + ALPHA_RANGE * intensity).toFixed(3)
  const rgb = diff > 0 ? INCREASE_RGB : DECREASE_RGB
  return `rgba(${rgb}, ${alpha})`
}

export function LayoutComparisonHeatmapDiff({
  current,
  target,
  kleKeys,
  targetLabel,
}: Props): JSX.Element {
  const { t } = useTranslation()
  const keyColors = useMemo<Map<string, string> | null>(() => {
    const built = buildDiffShares(current, target)
    if (!built) return null
    const out = new Map<string, string>()
    for (const k of kleKeys) {
      const pos = posKey(k.row, k.col)
      const fill = colorFor(built.diffs.get(pos) ?? 0, built.maxAbs)
      if (fill !== null) out.set(pos, fill)
    }
    return out
  }, [current, target, kleKeys])

  // KeyboardWidget requires a `keycodes` Map; the diff view doesn't
  // care about labels, so we hand it a stable empty Map.
  const emptyKeycodes = useMemo(() => new Map<string, string>(), [])

  return (
    <div className="flex w-full flex-col gap-1" data-testid="analyze-layout-comparison-heatmap-diff">
      <h4 className="text-[13px] font-semibold text-content-secondary">
        {t('analyze.layoutComparison.heatmapDiffTitle', { target: targetLabel })}
      </h4>
      <div className="flex items-center gap-3 text-[11px] text-content-muted" aria-hidden="true">
        <Swatch color={`rgba(${DECREASE_RGB}, ${LEGEND_ALPHA})`} label={t('analyze.layoutComparison.heatmapDiffLegend.decrease')} />
        <Swatch color={`rgba(${INCREASE_RGB}, ${LEGEND_ALPHA})`} label={t('analyze.layoutComparison.heatmapDiffLegend.increase')} />
      </div>
      <div className="flex min-h-0 justify-center overflow-auto">
        <KeyboardWidget
          keys={[...kleKeys]}
          keycodes={emptyKeycodes}
          keyColors={keyColors ?? undefined}
          readOnly
        />
      </div>
    </div>
  )
}

function Swatch({ color, label }: { color: string; label: string }): JSX.Element {
  return (
    <span className="flex items-center gap-1">
      <span
        className="inline-block h-3 w-3 rounded-sm border border-edge"
        style={{ backgroundColor: color }}
      />
      <span>{label}</span>
    </span>
  )
}
