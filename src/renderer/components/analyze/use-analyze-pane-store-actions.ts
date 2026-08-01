// SPDX-License-Identifier: GPL-2.0-or-later
// Filter-snapshot store panel + Hub upload wiring for the Analyze pane:
// the slide-in store panel's open state, save/overwrite/load/export
// handlers for the panel's saved-condition entries, and the Hub upload
// modal plumbing (origin resolution, upload input builder, per-entry
// upload/update/remove actions). Split out of AnalyzePane.tsx
// (Task-split-analyze-pane) — the panel and the Hub row are the two
// heaviest, most self-contained blocks of the original file.

import type { Dispatch, SetStateAction } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TypingKeyboardSummary, TypingKeymapSnapshot } from '../../../shared/types/typing-analytics'
import type { FingerType } from '../../../shared/kle/kle-ergonomics'
import type { KeyboardLayout } from '../../../shared/kle/types'
import {
  parseFilterDimension,
  type ActivityFilters,
  type BigramFilters,
  type DeviceScope,
  type ErgonomicsFilters,
  type FilterDimension,
  type HeatmapFilters,
  type IntervalFilters,
  type LayerFilters,
  type LayoutComparisonFilters,
  type WpmFilters,
} from '../../../shared/types/analyze-filters'
import type { HubAnalyticsLayoutComparisonInputs } from '../../../shared/types/hub'
import { useEscapeClose } from '../../hooks/useEscapeClose'
import { useAnalyzeFilterStore, type AnalyzeFilterSnapshotPayload } from '../../hooks/useAnalyzeFilterStore'
import type { AnalyzeFiltersState } from '../../hooks/useAnalyzeFilters'
import type { UseKeyLabelLookupReturn } from '../../hooks/useKeyLabelLookup'
import type { AnalysisTabKey, RangeMs } from './analyze-types'
import type { AnalyzeExportContext } from './AnalyzeExportModal'
// Type-only (erased at build time), so this does not create an import
// cycle with the component that consumes the same state union.
import type { AnalyzePaneModalState } from './AnalyzePaneModals'
import { formatDateTime } from '../editors/store-modal-shared'
import { generateAnalyzeThumbnail } from './analyze-thumbnail'
import { LAYOUT_COMPARISON_PHASE_1_METRICS } from './layout-comparison-metrics'

function resolveKleKeys(snapshot: TypingKeymapSnapshot | null): unknown[] {
  const layout = snapshot?.layout as KeyboardLayout | null
  return layout && Array.isArray(layout.keys) ? layout.keys : []
}

function resolveLayoutComparisonInputs(
  filter: Required<LayoutComparisonFilters>,
  lookup: UseKeyLabelLookupReturn,
  snapshot: TypingKeymapSnapshot | null,
  targetIds: string[],
): HubAnalyticsLayoutComparisonInputs | null {
  if (targetIds.length === 0 || !snapshot) return null
  const sourceMap = lookup.getMap(filter.sourceLayoutId)
  if (!sourceMap) return null
  const targets: Array<{ id: string; name?: string; map: Record<string, string> }> = [
    { id: filter.sourceLayoutId, name: lookup.getName(filter.sourceLayoutId), map: sourceMap },
  ]
  for (const tid of targetIds) {
    const map = lookup.getMap(tid)
    if (map) targets.push({ id: tid, name: lookup.getName(tid), map })
  }
  if (targets.length < 2) return null
  return {
    source: { id: filter.sourceLayoutId, map: sourceMap },
    targets,
    metrics: [...LAYOUT_COMPARISON_PHASE_1_METRICS],
    kleKeys: resolveKleKeys(snapshot),
  }
}

export interface UseAnalyzePaneStoreActionsOptions {
  selectedUid: string | null
  selected: TypingKeyboardSummary | null
  analysisTab: AnalysisTabKey
  setAnalysisTab: Dispatch<SetStateAction<AnalysisTabKey>>
  range: RangeMs
  setRange: Dispatch<SetStateAction<RangeMs>>
  deviceScopes: DeviceScope[]
  setDeviceScopes: (v: readonly DeviceScope[]) => void
  rawAppScopes: string[]
  setAppScopes: (v: string[]) => void
  rawTypingTestScopes: string[]
  setTypingTestScopes: (v: string[]) => void
  rawRunIdScopes: string[]
  setRunIdScopes: (v: string[]) => void
  filterDimension: FilterDimension
  setFilterDimension: (v: FilterDimension) => void
  heatmapFilter: AnalyzeFiltersState['heatmap']
  setHeatmap: (patch: Partial<HeatmapFilters>) => void
  wpmFilter: AnalyzeFiltersState['wpm']
  setWpm: (patch: Partial<WpmFilters>) => void
  intervalFilter: AnalyzeFiltersState['interval']
  setIntervalFilter: (patch: Partial<IntervalFilters>) => void
  activityFilter: AnalyzeFiltersState['activity']
  setActivity: (patch: Partial<ActivityFilters>) => void
  layerFilter: AnalyzeFiltersState['layer']
  setLayer: (patch: Partial<LayerFilters>) => void
  ergonomicsFilter: AnalyzeFiltersState['ergonomics']
  setErgonomics: (patch: Partial<ErgonomicsFilters>) => void
  bigramsFilter: AnalyzeFiltersState['bigrams']
  setBigrams: (patch: Partial<BigramFilters>) => void
  layoutComparisonFilter: AnalyzeFiltersState['layoutComparison']
  setLayoutComparison: (patch: Partial<LayoutComparisonFilters>) => void
  exportCtx: AnalyzeExportContext | null
  fingerAssignments: Record<string, FingerType>
  keymapSnapshot: TypingKeymapSnapshot | null
  layoutLookup: UseKeyLabelLookupReturn
}

export function useAnalyzePaneStoreActions({
  selectedUid,
  selected,
  analysisTab,
  setAnalysisTab,
  range,
  deviceScopes,
  setDeviceScopes,
  rawAppScopes,
  setAppScopes,
  rawTypingTestScopes,
  setTypingTestScopes,
  rawRunIdScopes,
  setRunIdScopes,
  filterDimension,
  setFilterDimension,
  heatmapFilter,
  setHeatmap,
  wpmFilter,
  setWpm,
  intervalFilter,
  setIntervalFilter,
  activityFilter,
  setActivity,
  layerFilter,
  setLayer,
  ergonomicsFilter,
  setErgonomics,
  bigramsFilter,
  setBigrams,
  layoutComparisonFilter,
  setLayoutComparison,
  setRange,
  exportCtx,
  fingerAssignments,
  keymapSnapshot,
  layoutLookup,
}: UseAnalyzePaneStoreActionsOptions) {
  // The export modal does double duty: CSV export when invoked with
  // mode 'export', Hub upload when invoked with mode 'upload'. The
  // upload variant pins the saved entry id so the modal's onConfirm
  // can build the upload params for that specific entry.
  const [modalState, setModalState] = useState<AnalyzePaneModalState>({ kind: 'closed' })
  const [hubOrigin, setHubOrigin] = useState<string | null>(null)
  const [storePanelOpen, setStorePanelOpen] = useState(false)
  const storePanelRef = useRef<HTMLDivElement>(null)
  const storeToggleRef = useRef<HTMLButtonElement>(null)
  const filterStore = useAnalyzeFilterStore({ uid: selectedUid })

  // Close on Escape — match the keymap editor's overlay UX. Outside-click
  // closes too, but we have to filter out clicks on the toggle button or
  // we'd race with `handleToggleStorePanel` and end up re-opening.
  useEscapeClose(() => setStorePanelOpen(false), storePanelOpen)
  useEffect(() => {
    if (!storePanelOpen) return
    // Capture-phase listener so descendant handlers that call
    // `stopPropagation` (chart legend rows, filter row controls) cannot
    // suppress the close. The contains() guards still let clicks on
    // the toggle button and inside the panel pass through untouched.
    const onMouseDown = (e: MouseEvent): void => {
      const target = e.target as Node | null
      if (!target) return
      if (storePanelRef.current?.contains(target)) return
      if (storeToggleRef.current?.contains(target)) return
      setStorePanelOpen(false)
    }
    window.addEventListener('mousedown', onMouseDown, true)
    return () => window.removeEventListener('mousedown', onMouseDown, true)
  }, [storePanelOpen])

  // Pull the saved-entry list when the keyboard changes so the count /
  // list reflects the new uid even before the user opens the panel.
  const { refreshEntries: refreshFilterEntries } = filterStore
  useEffect(() => {
    void refreshFilterEntries()
  }, [refreshFilterEntries])

  // Shared payload + summary build for both the save and overwrite
  // entry points so the two stay byte-for-byte identical (the saved
  // entry shape is what `useAnalyzeFilters` reads back on Load — any
  // drift between the two writers would silently corrupt the loaded
  // state).
  const buildFilterSnapshotPayload = useCallback((): {
    payload: AnalyzeFilterSnapshotPayload
    summary: string | undefined
  } => {
    const payload: AnalyzeFilterSnapshotPayload = {
      version: 1,
      analysisTab,
      range,
      filters: {
        deviceScopes,
        // Persist the raw (un-zeroed) selections so a snapshot saved on
        // a tab that forces a dimension off (byApp) still round-trips the
        // user's real picks. The dimension itself is pinned to typingTest
        // on byApp so a later Load (which lands on Summary) doesn't snap
        // back to an App filter the user never chose there.
        appScopes: rawAppScopes,
        typingTestScopes: rawTypingTestScopes,
        runIdScopes: rawRunIdScopes,
        filterDimension,
        heatmap: heatmapFilter,
        wpm: wpmFilter,
        interval: intervalFilter,
        activity: activityFilter,
        layer: layerFilter,
        ergonomics: ergonomicsFilter,
        bigrams: bigramsFilter,
        layoutComparison: layoutComparisonFilter,
      },
    }
    // Comma-separated condition values shown under the saved entry's
    // label so the user can recognise it without loading the full
    // snapshot. Built from `exportCtx` which already memoises the same
    // user-visible labels the filter row renders. Keyboard name is
    // omitted because the store is already scoped per keyboard.
    const summary = exportCtx
      ? [
          exportCtx.conditions.device,
          exportCtx.conditions.app,
          exportCtx.conditions.keymap,
          exportCtx.conditions.range,
        ].filter(Boolean).join(', ')
      : undefined
    return { payload, summary }
  }, [
    analysisTab, range,
    deviceScopes, rawAppScopes, rawTypingTestScopes, rawRunIdScopes, filterDimension,
    heatmapFilter, wpmFilter, intervalFilter,
    activityFilter, layerFilter, ergonomicsFilter, bigramsFilter,
    layoutComparisonFilter, exportCtx,
  ])

  const handleSaveFilterSnapshot = useCallback(
    async (label: string): Promise<string | null> => {
      if (!selectedUid) return null
      const { payload, summary } = buildFilterSnapshotPayload()
      return filterStore.saveSnapshot(label, payload, summary)
    },
    [selectedUid, buildFilterSnapshotPayload, filterStore],
  )

  const handleOverwriteFilterSnapshot = useCallback(
    async (entryId: string, label: string): Promise<string | null> => {
      if (!selectedUid) return null
      const { payload, summary } = buildFilterSnapshotPayload()
      return filterStore.overwriteSnapshot(entryId, label, payload, summary)
    },
    [selectedUid, buildFilterSnapshotPayload, filterStore],
  )

  const handleLoadFilterSnapshot = useCallback(
    async (entryId: string): Promise<boolean> => {
      const payload = await filterStore.loadSnapshot(entryId)
      if (!payload) return false
      // Always land on Summary regardless of which tab was active when
      // the condition was saved — the user opened the panel to inspect
      // the loaded slice, and Summary is the at-a-glance entry point.
      // The Hub upload pipeline pins its `filters.analysisTab` to
      // Summary too (see hub-ipc.projectFiltersForHub), so the saved
      // `analysisTab` field is effectively unused today. We keep it on
      // the payload for forward-compat in case per-tab Load comes back.
      setAnalysisTab('summary')
      setRange(payload.range)
      setDeviceScopes(payload.filters.deviceScopes)
      setAppScopes(payload.filters.appScopes)
      setTypingTestScopes(payload.filters.typingTestScopes)
      setRunIdScopes(payload.filters.runIdScopes)
      // Snapshots saved before this field existed restore as 'app'.
      setFilterDimension(parseFilterDimension(payload.filters.filterDimension))
      setHeatmap(payload.filters.heatmap)
      setWpm(payload.filters.wpm)
      setIntervalFilter(payload.filters.interval)
      setActivity(payload.filters.activity)
      setLayer(payload.filters.layer)
      setErgonomics(payload.filters.ergonomics)
      setBigrams(payload.filters.bigrams)
      setLayoutComparison(payload.filters.layoutComparison)
      return true
    },
    [
      filterStore, setAnalysisTab, setRange, setDeviceScopes, setAppScopes, setTypingTestScopes,
      setRunIdScopes, setFilterDimension, setHeatmap, setWpm, setIntervalFilter, setActivity, setLayer,
      setErgonomics, setBigrams, setLayoutComparison,
    ],
  )

  const handleToggleStorePanel = useCallback(() => {
    setStorePanelOpen((prev) => {
      const next = !prev
      if (next) void refreshFilterEntries()
      return next
    })
  }, [refreshFilterEntries])

  const handleExportEntryCsv = useCallback(
    async (entryId: string): Promise<void> => {
      const ok = await handleLoadFilterSnapshot(entryId)
      if (ok) setModalState({ kind: 'export' })
    },
    [handleLoadFilterSnapshot],
  )

  // Resolve the Hub base URL once so the Hub row can build the
  // "open on Hub" share link without round-tripping per click. Cached
  // per pane so two panes don't both fetch.
  useEffect(() => {
    if (hubOrigin !== null) return
    void window.vialAPI.hubGetOrigin()
      .then((origin) => { if (origin) setHubOrigin(origin) })
      .catch(() => { /* leave origin null — share link hides */ })
  }, [hubOrigin])

  // Keyboard meta the upload IPC needs. Reads off the active typing-
  // keyboard summary so the Hub post header carries the same labels
  // the live Analyze view already shows.
  const hubKeyboard = useMemo(
    () => selected
      ? { productName: selected.productName, vendorId: selected.vendorId, productId: selected.productId }
      : null,
    [selected],
  )

  useEffect(() => {
    void layoutLookup.ensure(layoutComparisonFilter.sourceLayoutId)
    if (layoutComparisonFilter.targetLayoutId !== null) {
      void layoutLookup.ensure(layoutComparisonFilter.targetLayoutId)
    }
  }, [layoutLookup.ensure, layoutComparisonFilter.sourceLayoutId, layoutComparisonFilter.targetLayoutId])

  const buildHubUploadInput = useCallback((entryId: string) => {
    if (!selected || !hubKeyboard) return null
    const entry = filterStore.entries.find((e) => e.id === entryId)
    if (!entry) return null
    const rangeLabel = exportCtx?.conditions.range
      ?? `${formatDateTime(range.fromMs)} - ${formatDateTime(range.toMs)}`
    const thumbnailBase64 = generateAnalyzeThumbnail({
      keyboardName: selected.productName,
      rangeLabel,
      totalKeystrokes: 0,
      deviceLabel: exportCtx?.conditions.device,
    })
    return {
      entryId,
      title: entry.label,
      thumbnailBase64,
      keyboard: hubKeyboard,
      fingerOverrides: fingerAssignments,
      layoutComparisonInputs: layoutComparisonFilter.targetLayoutId !== null
        ? resolveLayoutComparisonInputs(
            layoutComparisonFilter, layoutLookup, keymapSnapshot,
            [layoutComparisonFilter.targetLayoutId],
          )
        : null,
    }
  }, [selected, hubKeyboard, filterStore.entries, exportCtx, range, fingerAssignments,
    layoutComparisonFilter, layoutLookup, keymapSnapshot])

  // Open the export modal in upload mode for the given entry. Loads
  // the saved snapshot first so the modal's exportCtx (device / app /
  // keymap / range labels in the header) reflects what the user will
  // actually upload, not whatever live state happened to be active.
  // Bound to both "Upload" and "Update on Hub" Hub-row buttons — the
  // distinction is decided inside the modal's onConfirm handler from
  // the loaded entry's hubPostId.
  const openHubUploadModal = useCallback(async (entryId: string): Promise<void> => {
    const ok = await handleLoadFilterSnapshot(entryId)
    if (ok) setModalState({ kind: 'upload', entryId })
  }, [handleLoadFilterSnapshot])

  const handleRemoveFromHub = useCallback((entryId: string) => {
    void filterStore.removeEntryFromHub(entryId)
  }, [filterStore])

  // Single source of truth for the panel's hub action wiring. `null`
  // hides the row entirely (no keyboard selected). Both Upload and
  // Update buttons route through the same modal opener — the modal
  // looks at the loaded entry's hubPostId to decide which IPC to
  // invoke on confirm.
  const hubActions = useMemo(
    () => selected
      ? {
          hubOrigin: hubOrigin ?? undefined,
          hubUploading: filterStore.hubUploading,
          hubUploadResult: filterStore.hubUploadResult,
          onUploadToHub: openHubUploadModal,
          onUpdateOnHub: openHubUploadModal,
          onRemoveFromHub: handleRemoveFromHub,
        }
      : null,
    [selected, hubOrigin, filterStore.hubUploading, filterStore.hubUploadResult,
     openHubUploadModal, handleRemoveFromHub],
  )

  // Pre-compute the modal's `upload` callbacks bundle for the active
  // upload target. Falls back to `undefined` for export mode so the
  // modal doesn't try to render the upload status banner.
  const uploadEntryForModal = modalState.kind === 'upload'
    ? filterStore.entries.find((e) => e.id === modalState.entryId) ?? null
    : null
  const modalUploadProps = useMemo(() => {
    if (!uploadEntryForModal) return undefined
    const entry = uploadEntryForModal
    const isExisting = !!entry.hubPostId
    return {
      isUploading: filterStore.hubUploading === entry.id,
      uploadResult: filterStore.hubUploadResult?.entryId === entry.id
        ? { kind: filterStore.hubUploadResult.kind, message: filterStore.hubUploadResult.message }
        : null,
      isExisting,
      onConfirm: async (categories: ReadonlySet<string>, options?: { targetLayoutIds?: string[]; appDataApps?: string[] }) => {
        const baseInput = buildHubUploadInput(entry.id)
        if (!baseInput) return { ok: false }
        const targetIds = options?.targetLayoutIds
        let layoutComparisonInputs = baseInput.layoutComparisonInputs
        if (targetIds && targetIds.length > 0) {
          await Promise.all(targetIds.map((id) => layoutLookup.ensure(id)))
          layoutComparisonInputs = resolveLayoutComparisonInputs(
            layoutComparisonFilter, layoutLookup, keymapSnapshot, targetIds,
          )
        }
        const input = {
          ...baseInput,
          layoutComparisonInputs,
          categories: Array.from(categories) as Parameters<typeof filterStore.uploadEntryToHub>[0]['categories'],
          appDataApps: options?.appDataApps,
        }
        return isExisting
          ? filterStore.updateEntryOnHub(input)
          : filterStore.uploadEntryToHub(input)
      },
    }
  }, [uploadEntryForModal, filterStore, buildHubUploadInput,
    layoutComparisonFilter, layoutLookup, keymapSnapshot])

  return {
    storePanelOpen,
    storePanelRef,
    storeToggleRef,
    filterStore,
    modalState,
    setModalState,
    handleToggleStorePanel,
    handleSaveFilterSnapshot,
    handleOverwriteFilterSnapshot,
    handleLoadFilterSnapshot,
    handleExportEntryCsv,
    hubActions,
    modalUploadProps,
  }
}
