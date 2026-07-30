// SPDX-License-Identifier: GPL-2.0-or-later
// Toolbar-row sub-components for the Analyze > Heatmap tab — the
// Count/Speed/Duration mode toggle, the per-layer selection row, and
// the "Frequently Used" ranking controls row. Split out of
// key-heatmap-panels.tsx (which itself was split out of
// KeyHeatmapChart.tsx) so neither file crosses the file-splitting size
// guideline as the tab gains more mode toggles.

import { useTranslation } from 'react-i18next'
import { SegmentedToggle } from './SegmentedToggle'
import { FILTER_SELECT, LIST_LIMIT_OPTIONS } from './analyze-filter-styles'
import { HEATMAP_NORMALIZATIONS, type HeatmapFilters } from '../../../shared/types/analyze-filters'
import type { HeatmapNormalization } from './analyze-types'
import { AGGREGATE_MODES, HEATMAP_MODES, KEY_GROUPS } from './key-heatmap-helpers'
import type { AggregateMode, HeatmapMode, KeyGroupFilter } from './key-heatmap-helpers'

const HEATMAP_MODE_LABEL_KEY: Record<HeatmapMode, string> = {
  count: 'analyze.keyHeatmap.modeToggle.count',
  speed: 'analyze.keyHeatmap.modeToggle.speed',
  duration: 'analyze.keyHeatmap.modeToggle.duration',
}

export interface HeatmapModeToggleProps {
  value: HeatmapMode
  onChange: (next: HeatmapMode) => void
}

/** Segmented Count / Speed / Duration switch — built from the same
 * `SegmentedToggle` primitive as the Bigrams gram toggle so the two
 * tabs' mode switches read as the same control family. */
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

export interface LayerToggleRowProps {
  layerOptions: readonly number[]
  selectedLayers: readonly number[]
  maxLayers: number
  onToggle: (layer: number) => void
}

/** The per-layer selection button row above the ranking controls.
 * Extracted from KeyHeatmapChart.tsx (pure presentation, no state of
 * its own) to keep the container component under the file-splitting
 * size guideline. */
export function LayerToggleRow({ layerOptions, selectedLayers, maxLayers, onToggle }: LayerToggleRowProps): JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      className="flex shrink-0 flex-wrap items-center justify-end gap-1 text-xs"
      role="group"
      aria-label={t('analyze.keyHeatmap.layer')}
      data-testid="analyze-keyheatmap-layers"
    >
      {layerOptions.map((i) => {
        const isSelected = selectedLayers.includes(i)
        const isDisabled = !isSelected && selectedLayers.length >= maxLayers
        return (
          <button
            key={i}
            type="button"
            aria-pressed={isSelected}
            aria-label={t('analyze.keyHeatmap.layerOption', { i })}
            onClick={() => onToggle(i)}
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
  )
}

export interface RankingControlsProps {
  mode: HeatmapMode
  normalization: HeatmapNormalization
  aggregateMode: AggregateMode
  keyGroupFilter: KeyGroupFilter
  frequentUsedN: number
  onHeatmapChange: (patch: Partial<HeatmapFilters>) => void
}

/** The "Frequently Used" ranking controls row — normalization +
 * aggregate (Count mode only), key-group filter, and Top-N select.
 * Extracted from KeyHeatmapChart.tsx for the same file-size reason as
 * `LayerToggleRow`. */
export function RankingControls({
  mode, normalization, aggregateMode, keyGroupFilter, frequentUsedN, onHeatmapChange,
}: RankingControlsProps): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-widest text-content-muted">
        {t('analyze.keyHeatmap.ranking.frequentUsed')}
      </h3>
      <div className="flex flex-wrap items-center gap-2">
        {mode === 'count' && (
          <>
            <select
              className={FILTER_SELECT}
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
              className={FILTER_SELECT}
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
          className={FILTER_SELECT}
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
          className={FILTER_SELECT}
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
  )
}
