// SPDX-License-Identifier: GPL-2.0-or-later
// Display-label plumbing for the Analyze pane: run-id labels (History
// name, or a formatted fallback date), the AnalyzeExportModal /
// Hub-upload context snapshot, and the Row 1 summary chip's labels.
// Split out of AnalyzePane.tsx (Task-split-analyze-pane, item ⑦ — the
// pane still landed over the 500-line UI-component cap after the
// snapshot / prefs / sync / store-actions hooks and the two
// subcomponents, so this last slice was extracted too).

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { isAllScope, isHashScope, type DeviceScope, type FilterDimension } from '../../../shared/types/analyze-filters'
import { useRunLabels } from '../../hooks/useRunLabels'
import type { AnalyzeDeviceInfos } from '../../hooks/useAnalyzeScopeOptions'
import type { AnalyzeFiltersState } from '../../hooks/useAnalyzeFilters'
import type { TypingKeyboardSummary, TypingKeymapSnapshot, TypingKeymapSnapshotSummary } from '../../../shared/types/typing-analytics'
import type { FingerType } from '../../../shared/kle/kle-ergonomics'
import type { RangeMs } from './analyze-types'
import { buildDeviceLabel, buildFilterConditionLabels, buildPeriodLabel, type FilterConditionLabels } from './filter-labels'
import { formatDateTime } from '../editors/store-modal-shared'
import type { AnalyzeExportContext } from './AnalyzeExportModal'

export interface UseAnalyzePaneLabelsOptions {
  selectedUid: string | null
  selected: TypingKeyboardSummary | null
  range: RangeMs
  deviceScopes: DeviceScope[]
  appScopes: string[]
  typingTestScopes: string[]
  rawTypingTestScopes: string[]
  runIdScopes: string[]
  filterDimension: FilterDimension
  deviceInfos: AnalyzeDeviceInfos
  effectiveSnapshot: TypingKeymapSnapshot | null
  selectedSnapshotSavedAt: number | null
  snapshotSummaries: TypingKeymapSnapshotSummary[]
  heatmapFilter: AnalyzeFiltersState['heatmap']
  wpmFilter: AnalyzeFiltersState['wpm']
  intervalFilter: AnalyzeFiltersState['interval']
  activityFilter: AnalyzeFiltersState['activity']
  layerFilter: AnalyzeFiltersState['layer']
  bigramsFilter: AnalyzeFiltersState['bigrams']
  layoutComparisonFilter: AnalyzeFiltersState['layoutComparison']
  fingerAssignments: Record<string, FingerType>
}

export interface UseAnalyzePaneLabelsReturn {
  exportCtx: AnalyzeExportContext | null
  chipLabels: FilterConditionLabels
}

export function useAnalyzePaneLabels({
  selectedUid,
  selected,
  range,
  deviceScopes,
  appScopes,
  typingTestScopes,
  rawTypingTestScopes,
  runIdScopes,
  filterDimension,
  deviceInfos,
  effectiveSnapshot,
  selectedSnapshotSavedAt,
  snapshotSummaries,
  heatmapFilter,
  wpmFilter,
  intervalFilter,
  activityFilter,
  layerFilter,
  bigramsFilter,
  layoutComparisonFilter,
  fingerAssignments,
}: UseAnalyzePaneLabelsOptions): UseAnalyzePaneLabelsReturn {
  const { t } = useTranslation()

  // Display names for the currently-filtered runs so the summary chip's
  // Source segment can show "words · <run name>" instead of a bare run
  // id. History-less runs fall back to their first analytics minute via
  // the same run-rows query RunSelect uses, so the chip and the modal's
  // Results dropdown always agree. Both fetches stay lazy: nothing runs
  // until a run filter is actually active.
  const runLabelsQuery = useMemo(
    () => runIdScopes.length > 0
      ? { range, deviceScopes, materialScopes: rawTypingTestScopes }
      : null,
    [runIdScopes, range, deviceScopes, rawTypingTestScopes],
  )
  const { labelFor: runLabelFor } = useRunLabels(
    runIdScopes.length > 0 ? selectedUid : null,
    runLabelsQuery,
  )

  // Snapshot the filter state in the shape AnalyzeExportModal needs.
  // The modal calls per-category builders directly with these values
  // so the exported CSV reflects the same conditions the visible
  // chart is using; keep the deps focused on filter primitives so the
  // memo doesn't churn on unrelated rerenders.
  const exportCtx = useMemo<AnalyzeExportContext | null>(() => {
    if (!selected) return null
    const scope = deviceScopes[0] ?? 'own'
    const machineHashOrAll = isHashScope(scope)
      ? scope.machineHash
      : isAllScope(scope)
        ? 'all'
        : (deviceInfos.own?.machineHash ?? 'own')

    // Reuse the same label builders the summary chip uses so the modal
    // reads as a context echo, not a separate source of truth.
    const deviceLabel = buildDeviceLabel(t, scope, deviceInfos)
    // KeymapSnapshotTimeline labels the newest snapshot as "current",
    // so mirror that here: if the explicit pick matches the latest
    // savedAt the row is logically still "current keymap" — printing
    // a literal timestamp would diverge from the filter row.
    const latestSnapshotSavedAt = snapshotSummaries.length > 0
      ? Math.max(...snapshotSummaries.map((s) => s.savedAt))
      : null
    const keymapLabel = effectiveSnapshot === null
      ? '—'
      : selectedSnapshotSavedAt === null || selectedSnapshotSavedAt === latestSnapshotSavedAt
        ? t('analyze.snapshotTimeline.current')
        : formatDateTime(selectedSnapshotSavedAt)
    const rangeLabel = buildPeriodLabel(range)
    const appLabel = appScopes.length === 0
      ? t('analyze.filters.appOption.none')
      : appScopes.join(', ')

    return {
      uid: selected.uid,
      keyboardName: selected.productName,
      machineHashOrAll,
      range,
      deviceScope: scope,
      appScopes,
      typingTestScopes,
      runIdScopes,
      snapshot: effectiveSnapshot,
      heatmap: heatmapFilter,
      wpm: {
        granularity: wpmFilter.granularity,
        viewMode: wpmFilter.viewMode,
        minActiveMs: wpmFilter.minActiveMs,
      },
      interval: {
        viewMode: intervalFilter.viewMode,
        granularity: wpmFilter.granularity,
      },
      activity: {
        metric: activityFilter.metric,
        minActiveMs: wpmFilter.minActiveMs,
      },
      layer: { baseLayer: layerFilter.baseLayer },
      bigrams: { gram: bigramsFilter.gram },
      layoutComparison: layoutComparisonFilter,
      fingerOverrides: fingerAssignments,
      conditions: { device: deviceLabel, app: appLabel, keymap: keymapLabel, range: rangeLabel },
    }
  }, [
    selected, deviceScopes, appScopes, typingTestScopes, runIdScopes, deviceInfos, range, effectiveSnapshot, selectedSnapshotSavedAt,
    snapshotSummaries, heatmapFilter, wpmFilter, intervalFilter, activityFilter, layerFilter, bigramsFilter.gram,
    layoutComparisonFilter, fingerAssignments, t,
  ])

  const chipRunLabels = useMemo(
    () => runIdScopes.map(runLabelFor),
    [runIdScopes, runLabelFor],
  )

  // Summary chip labels — dimension-aware, built from the *effective*
  // (already-zeroed) filter state so the chip always echoes what the
  // active chart is actually querying, not raw edit-in-progress picks.
  const chipLabels = useMemo(
    () => buildFilterConditionLabels(t, {
      keyboardName: selected ? selected.productName : null,
      deviceScope: deviceScopes[0] ?? 'own',
      deviceInfos: { own: deviceInfos.own, remotes: deviceInfos.remotes },
      filterDimension,
      appScopes,
      typingTestScopes,
      runLabels: chipRunLabels,
      range,
    }),
    [t, selected, deviceScopes, deviceInfos, filterDimension, appScopes, typingTestScopes, chipRunLabels, range],
  )

  return { exportCtx, chipLabels }
}
