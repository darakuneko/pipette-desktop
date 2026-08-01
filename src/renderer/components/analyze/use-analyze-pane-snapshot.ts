// SPDX-License-Identifier: GPL-2.0-or-later
// Keymap-snapshot state for the Analyze pane: the snapshot fetched for
// the current range, the snapshot-picker (`selectedSnapshotSavedAt`),
// the device/snapshot option lists, and every value derived from them
// (`effectiveSnapshot`, tap-hold availability, the Interval distribution
// section switcher, and the snapshot's active-window boundaries used to
// clamp `range`). Split out of AnalyzePane.tsx (Task-split-analyze-pane)
// so the pane's own hook call stays a single line.

import type { Dispatch, SetStateAction } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { TypingKeymapSnapshot, TypingKeymapSnapshotSummary } from '../../../shared/types/typing-analytics'
import {
  DISTRIBUTION_SECTIONS,
  isHashScope,
  type DeviceScope,
  type DistributionSection,
  type LayerFilters,
} from '../../../shared/types/analyze-filters'
import type { AnalysisTabKey, ActivityView, RangeMs } from './analyze-types'
import { clampRangeToBoundaries, getSnapshotBoundaries } from './clamp-range'
import { tapHoldPositionKeys } from './analyze-tapping-term-cells'
import { useAnalyzeScopeOptions, type AnalyzeDeviceInfos } from '../../hooks/useAnalyzeScopeOptions'
import { useKeyLabelLookup, type UseKeyLabelLookupReturn } from '../../hooks/useKeyLabelLookup'

export interface UseAnalyzePaneSnapshotOptions {
  selectedUid: string | null
  range: RangeMs
  setRange: Dispatch<SetStateAction<RangeMs>>
  nowMs: number
  analysisTab: AnalysisTabKey
  activityView: ActivityView
  layerBaseLayer: number
  setLayer: (patch: Partial<LayerFilters>) => void
  deviceScopes: readonly DeviceScope[]
  setDeviceScopes: (v: readonly DeviceScope[]) => void
  /** The persisted (un-clamped) pick — `intervalFilter.distributionSection`. */
  distributionSection: DistributionSection
}

export interface UseAnalyzePaneSnapshotReturn {
  layoutLookup: UseKeyLabelLookupReturn
  /** The raw fetched snapshot, NOT gated by the "every scope is a
   * remote hash" rule `effectiveSnapshot` applies — the Hub upload /
   * layout-comparison-input builders (`use-analyze-pane-store-actions`)
   * intentionally read this one, matching the original AnalyzePane
   * behavior of using the un-gated snapshot for those inputs. */
  keymapSnapshot: TypingKeymapSnapshot | null
  snapshotLoading: boolean
  deviceInfos: AnalyzeDeviceInfos
  snapshotSummaries: TypingKeymapSnapshotSummary[]
  summariesLoading: boolean
  selectedSnapshotSavedAt: number | null
  setSelectedSnapshotSavedAt: Dispatch<SetStateAction<number | null>>
  effectiveSnapshot: TypingKeymapSnapshot | null
  availableDistributionSections: readonly DistributionSection[]
  /** The persisted pick, clamped to what's actually offered right now —
   * computed HERE ONCE and threaded to both the filter row and the
   * chart area so the two never disagree. */
  effectiveDistributionSection: DistributionSection
}

export function useAnalyzePaneSnapshot({
  selectedUid,
  range,
  setRange,
  nowMs,
  analysisTab,
  activityView,
  layerBaseLayer,
  setLayer,
  deviceScopes,
  setDeviceScopes,
  distributionSection,
}: UseAnalyzePaneSnapshotOptions): UseAnalyzePaneSnapshotReturn {
  const [keymapSnapshot, setKeymapSnapshot] = useState<TypingKeymapSnapshot | null>(null)
  const layoutLookup = useKeyLabelLookup()
  const [snapshotLoading, setSnapshotLoading] = useState(false)
  const { deviceInfos, snapshotSummaries, summariesLoading } = useAnalyzeScopeOptions(selectedUid)
  // The snapshot the timeline picker is currently pointing at. The
  // primary range is clamped to this snapshot's `[savedAt, nextSavedAt)`
  // window via `clampRangeToBoundaries` so charts that rely on the
  // snapshot (Heatmap / Ergonomics / Layer activations) only ever
  // aggregate keystrokes that match the displayed keymap. `null` means
  // either no keyboard is selected or the keyboard has no recorded
  // snapshots — in that case the range is free-form.
  const [selectedSnapshotSavedAt, setSelectedSnapshotSavedAt] = useState<number | null>(null)

  useEffect(() => {
    if (!selectedUid) { setKeymapSnapshot(null); setSnapshotLoading(false); return }
    let cancelled = false
    setSnapshotLoading(true)
    void window.vialAPI
      .typingAnalyticsGetKeymapSnapshotForRange(selectedUid, range.fromMs, range.toMs)
      .then((s) => { if (!cancelled) setKeymapSnapshot(s) })
      .catch(() => { if (!cancelled) setKeymapSnapshot(null) })
      .finally(() => { if (!cancelled) setSnapshotLoading(false) })
    return () => { cancelled = true }
  }, [selectedUid, range])

  // Snapshot summaries themselves are fetched by `useAnalyzeScopeOptions`
  // (uid-scoped, not range-scoped — every snapshot the user has ever
  // recorded, so the options stay stable across range edits). What's left
  // here is the pane-specific reaction to that list: reset the picker
  // synchronously on uid change (so it never shows a stale pick against a
  // list still loading for the new keyboard), then on the first resolved
  // list for a given uid, jump the primary range to the latest snapshot's
  // active window so the user lands on "current keymap" data. Subsequent
  // range edits within the same keyboard are not overridden.
  useEffect(() => {
    setSelectedSnapshotSavedAt(null)
  }, [selectedUid])

  const autoSetRangeForUidRef = useRef<string | null>(null)
  useEffect(() => {
    if (!selectedUid) return
    if (snapshotSummaries.length === 0) return
    if (autoSetRangeForUidRef.current === selectedUid) return
    const latest = snapshotSummaries[snapshotSummaries.length - 1]
    setRange({ fromMs: latest.savedAt, toMs: nowMs })
    setSelectedSnapshotSavedAt(latest.savedAt)
    autoSetRangeForUidRef.current = selectedUid
  }, [selectedUid, snapshotSummaries, nowMs])

  // Reset the Base Layer select when the snapshot's layer count shrinks
  // past the current selection (device switch, keymap edit). Without
  // this, a stale baseLayer would render an out-of-range <option> and
  // the aggregator would silently skip nothing meaningful.
  useEffect(() => {
    if (keymapSnapshot && layerBaseLayer >= keymapSnapshot.layers) {
      setLayer({ baseLayer: 0 })
    }
  }, [keymapSnapshot, layerBaseLayer, setLayer])

  // Device infos (own + remotes) come from `useAnalyzeScopeOptions` above.
  // Fallback: when persisted hashes no longer exist in the remote
  // list, drop them. Runs after the list resolves so a slow fetch
  // can't strip a valid selection on first mount. The hook's setter
  // re-normalizes, so falling back to `['own']` happens automatically
  // when every entry was stale.
  useEffect(() => {
    if (!deviceInfos.loaded) return
    const remoteHashSet = new Set(deviceInfos.remotes.map((d) => d.machineHash))
    const filtered = deviceScopes.filter((scope) => {
      if (!isHashScope(scope)) return true
      return remoteHashSet.has(scope.machineHash)
    })
    if (filtered.length === deviceScopes.length) return
    setDeviceScopes(filtered)
  }, [deviceInfos, deviceScopes, setDeviceScopes])

  // Snapshots are only ever saved for the own machine hash (see
  // service-side comment). Suppress only when every selected scope is
  // a remote hash — when even one entry is `'own'` or `'all'` the
  // local keymap is still the best-available layout reference. Heatmap
  // / Ergonomics / Layer-activations consume the snapshot directly so
  // gating here keeps a multi-device pick from blanking those tabs.
  const effectiveSnapshot = deviceScopes.every(isHashScope) ? null : keymapSnapshot

  // Mirrors TappingTermCard's own hidden rule (`snapshotLoading ||
  // !hasTapHoldKeys` -> render nothing) so the distribution-section
  // switcher never offers a "Tapping Term diagnosis" option that would
  // render an empty section. Computed here (not read back from the
  // card) because the switcher has to decide what to show *before*
  // TappingTermCard itself would mount.
  const hasTapHoldKeys = effectiveSnapshot !== null && tapHoldPositionKeys(effectiveSnapshot).size > 0
  const availableDistributionSections: readonly DistributionSection[] = useMemo(
    () => (snapshotLoading || !hasTapHoldKeys
      ? DISTRIBUTION_SECTIONS.filter((section) => section !== 'tappingTerm')
      : DISTRIBUTION_SECTIONS),
    [snapshotLoading, hasTapHoldKeys],
  )
  // The persisted pick, clamped to what's actually offered right now.
  // Falls back to `'interval'` at render time rather than rewriting
  // `intervalFilter.distributionSection` — the user's last raw pick
  // (e.g. 'tappingTerm' saved from a keyboard with tap-hold keys) stays
  // intact in storage so it comes back the moment it's available again
  // (e.g. after the snapshot finishes loading, or on a keyboard whose
  // keymap does have tap-hold keys).
  const effectiveDistributionSection: DistributionSection =
    availableDistributionSections.includes(distributionSection)
      ? distributionSection
      : 'interval'

  // The active window of the currently-selected snapshot. `null` means
  // "no clamp" — either no snapshot is picked yet or the keyboard has
  // none on file. Hook-internal only: feeds the re-clamp effect below
  // so charts never see a `range` that straddles a keymap edit. (The
  // filter modal's own date-input min/max clamp is a separate
  // `draftSnapshotBoundaries` computed independently in
  // AnalyzeFilterModal, not sourced from this hook.)
  const snapshotBoundaries = useMemo(
    () => getSnapshotBoundaries(selectedSnapshotSavedAt, snapshotSummaries, nowMs),
    [selectedSnapshotSavedAt, snapshotSummaries, nowMs],
  )

  // Re-clamp when a new snapshot lands mid-session and shrinks the
  // current snapshot's `hi`. `clampRangeToBoundaries` returns the same
  // reference on no-op so React's setState bails out on steady state.
  // Activity > Calendar view is excluded from clamp because it owns
  // its own visible-window cursor (`endMonthIso` + `monthsToShow`) and
  // should not be folded back into the snapshot's `[savedAt,
  // nextSavedAt)` slice.
  useEffect(() => {
    if (analysisTab === 'activity' && activityView === 'calendar') return
    setRange((prev) => clampRangeToBoundaries(prev, snapshotBoundaries))
  }, [snapshotBoundaries, analysisTab, activityView])

  return {
    layoutLookup,
    keymapSnapshot,
    snapshotLoading,
    deviceInfos,
    snapshotSummaries,
    summariesLoading,
    selectedSnapshotSavedAt,
    setSelectedSnapshotSavedAt,
    effectiveSnapshot,
    availableDistributionSections,
    effectiveDistributionSection,
  }
}
