// SPDX-License-Identifier: GPL-2.0-or-later
// One Analyze "pane" — the keyboard select, filter row, tab bar, chart
// area, and the modals tied to the pane's snapshot. Extracted from
// TypingAnalyticsView so the parent can render multiple panes
// side-by-side (Split View, Plan-P2-analyze-split-view).
//
// Each pane owns its own state: selected analysis tab, time range,
// filters (via useAnalyzeFilters), keymap snapshot, device infos, sync
// progress, and modal open state. The parent supplies the keyboards
// list and controls the keyboard selection so panes can either share
// a uid or pick independently.
// The pane's own state/effects are split across pane-scoped hooks
// (`use-analyze-pane-{snapshot,prefs,sync,store-actions,labels}.ts`)
// and subcomponents (`AnalyzePaneTabBar`, `AnalyzePaneFilterRow` [which
// delegates Row 2 to `AnalyzePaneTabFilters`], `AnalyzePaneChart`,
// `AnalyzePaneModals`) so this file stays the "tab switch + props
// wiring" shell (Task-split-analyze-pane). The filter-store slide-in
// panel overlay stays inline below — see its own comment for why.

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TypingKeyboardSummary } from '../../../shared/types/typing-analytics'
import type {
  AnalysisTabKey,
  ConnectedTappingTerm,
  RangeMs,
} from './analyze-types'
import { useAnalyzeFilters } from '../../hooks/useAnalyzeFilters'
import { AnalyzeFilterStorePanel } from './AnalyzeFilterStorePanel'
import { ConnectingOverlay } from '../ConnectingOverlay'
import type { AnalyzeFilterDraft } from './AnalyzeFilterModal'
import { resolveAnalyzeLoadingPhase } from './analyze-loading-phase'
import { DAY_MS } from './analyze-bucket'
import { AnalyzePaneChart } from './AnalyzePaneChart'
import { AnalyzePaneTabBar } from './AnalyzePaneTabBar'
import { AnalyzePaneFilterRow } from './AnalyzePaneFilterRow'
import { AnalyzePaneModals } from './AnalyzePaneModals'
import { useAnalyzePaneSnapshot } from './use-analyze-pane-snapshot'
import { useAnalyzePanePrefs } from './use-analyze-pane-prefs'
import { useAnalyzePaneSync } from './use-analyze-pane-sync'
import { useAnalyzePaneStoreActions } from './use-analyze-pane-store-actions'
import { useAnalyzePaneLabels } from './use-analyze-pane-labels'

// Test seam re-export: TypingAnalyticsView.test.tsx imports this from
// '../AnalyzePane' — the rate-limit map itself now lives in
// use-analyze-pane-sync.ts (Task-split-analyze-pane), but the import
// path is a public-ish test contract so it stays re-exported here.
export { _resetAnalyticsSyncRateLimitForTests } from './use-analyze-pane-sync'

/** Default analyze window: most keyboards generate enough data in a
 * week for the charts to feel populated without the user needing to
 * reach for the From / To pickers on every entry. Absolute `fromMs` /
 * `toMs` are re-seeded on each mount so persisted filters never drag
 * a stale range forward. */
const DEFAULT_RANGE_DAYS = 7

export type AnalyzePaneKey = 'A' | 'B'

export interface AnalyzePaneProps {
  /** Identifies the pane so per-pane state (filters, testids) can stay
   * independent when two panes render side-by-side. Defaults to `'A'`
   * for the historical single-pane case. */
  paneKey?: AnalyzePaneKey
  /** Keyboards eligible for selection in this pane's dropdown — owned
   * by the parent so multiple panes share a single fetch. */
  keyboards: readonly TypingKeyboardSummary[]
  /** Whether the parent is still fetching the keyboards list. While
   * loading, the dropdown shows a placeholder option and is disabled. */
  loading: boolean
  /** Currently-selected uid for this pane (controlled by parent). */
  selectedUid: string | null
  /** Called when the user picks a different keyboard in this pane. */
  onSelectUid: (uid: string | null) => void
  /** Forwarded to the Layout Comparison sub-view so the page footer can
   * render the skip-rate warning beside the split-view toggle. The
   * callback receives `null` whenever no Layout Comparison result is
   * loaded (different tab, no snapshot, no target picked). */
  onSkipPercentChange?: (percent: number | null) => void
  /** See {@link ConnectedTappingTerm}. `undefined`/`null` both mean "no
   * physically connected keyboard to diagnose" — the TappingTermCard
   * only renders when this matches the pane's own selected keyboard. */
  connectedTappingTerm?: ConnectedTappingTerm | null
  /** Analyze -> Typing Test "open timeline" handoff (see
   * `RunTimelineJumpButton`); omit to hide the action entirely. */
  onOpenRunTimeline?: (runId: string) => void
}

export function AnalyzePane({
  paneKey = 'A',
  keyboards,
  loading,
  selectedUid,
  onSelectUid,
  onSkipPercentChange,
  connectedTappingTerm,
  onOpenRunTimeline,
}: AnalyzePaneProps): JSX.Element {
  // Pane A keeps the historical (unsuffixed) testids so existing
  // selectors keep working; pane B appends `-b` so split-mode renders
  // a disambiguated tree.
  const tid = paneKey === 'B'
    ? (id: string) => `${id}-b`
    : (id: string) => id
  const { t } = useTranslation()
  // Default to Summary — the dashboard tab is the entry point so a
  // returning user lands on the at-a-glance streak / goal cards before
  // drilling into a specific chart. `lastActiveTab` is not persisted,
  // so every Analyze open starts here.
  const [analysisTab, setAnalysisTab] = useState<AnalysisTabKey>('summary')
  // Snapshot "now" at mount so the user's max boundary stays stable
  // while the page is open and we can reproducibly re-clip a stale
  // `to` when the user drags it above the wall clock we recorded.
  const [nowMs] = useState<number>(() => Date.now())
  // `range` is intentionally not persisted — each session opens on a
  // fresh 7-day window so an old absolute span can't drag forward
  // into an empty view. The user still keeps whatever they scrolled
  // to across keyboard / tab switches within the session.
  const [range, setRange] = useState<RangeMs>(() => ({
    fromMs: Date.now() - DAY_MS * DEFAULT_RANGE_DAYS,
    toMs: Date.now(),
  }))
  const {
    filters: {
      deviceScopes,
      appScopes,
      typingTestScopes,
      runIdScopes,
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
    ready: filtersReady,
    rawAppScopes,
    rawTypingTestScopes,
    rawRunIdScopes,
    setDeviceScopes,
    setAppScopes,
    setTypingTestScopes,
    setRunIdScopes,
    setFilterDimension,
    setHeatmap,
    setWpm,
    setInterval: setIntervalFilter,
    setActivity,
    setLayer,
    setErgonomics,
    setBigrams,
    setLayoutComparison,
    applyBatch,
    applyBatchForUid,
  } = useAnalyzeFilters(selectedUid, paneKey, analysisTab)

  const {
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
  } = useAnalyzePaneSnapshot({
    selectedUid,
    range,
    setRange,
    nowMs,
    analysisTab,
    activityView: activityFilter.view,
    layerBaseLayer: layerFilter.baseLayer,
    setLayer,
    deviceScopes,
    setDeviceScopes,
    distributionSection: intervalFilter.distributionSection,
  })

  const {
    fingerAssignments,
    fingersLoading,
    typingTestResults,
    showBenchmark,
    handleFingerAssignmentsSave,
    handleShowBenchmarkChange,
  } = useAnalyzePanePrefs(selectedUid)

  const [fingerModalOpen, setFingerModalOpen] = useState(false)
  // Staged filter editor (Plan-analyze-filter-modal) — Row 1 collapsed
  // to a summary chip; every filter row now lives behind this modal.
  // Conditionally mounted so its draft state re-seeds from committed
  // props on every open and its option fetches only run while open.
  const [filterModalOpen, setFilterModalOpen] = useState(false)

  // Commit routing for the staged filter modal. Same uid: one batched
  // filter write + the modal's pre-clamped range/snapshot. Different
  // uid: stage the patch via `applyBatchForUid`, then switch — the
  // pane's own fresh-load behaviour (persisted-hash fallback, jump to
  // latest snapshot) picks the range/snapshot for the new keyboard, so
  // the draft's are deliberately ignored on this path.
  const handleFilterModalApply = useCallback((draft: AnalyzeFilterDraft) => {
    if (draft.uid !== selectedUid) {
      if (draft.uid !== null) applyBatchForUid(draft.uid, draft.filtersPatch)
      onSelectUid(draft.uid)
      return
    }
    applyBatch(draft.filtersPatch)
    setSelectedSnapshotSavedAt(draft.snapshotSavedAt)
    setRange(draft.range)
  }, [selectedUid, applyBatch, applyBatchForUid, onSelectUid])

  const { syncProgress, syncingAnalytics } = useAnalyzePaneSync(selectedUid)

  const currentPhase = resolveAnalyzeLoadingPhase({
    keyboardsLoading: loading,
    filtersReady,
    syncing: syncingAnalytics,
    snapshotLoading,
    summariesLoading,
    fingersLoading,
    remoteHashesLoading: !!selectedUid && !deviceInfos.loaded && !deviceInfos.error,
  })

  // Auto-close the finger-assignment modal if the user flips to a
  // remote scope mid-edit — the modal mutates the own snapshot, so
  // keeping it visible under a hash scope would mean "editing the
  // local keymap while looking at someone else's data". The open
  // button is already disabled in that state.
  useEffect(() => {
    if (effectiveSnapshot === null && fingerModalOpen) {
      setFingerModalOpen(false)
    }
  }, [effectiveSnapshot, fingerModalOpen])

  const selected = selectedUid
    ? keyboards.find((kb) => kb.uid === selectedUid) ?? null
    : null

  // Whether the selected keyboard is the one physically connected right
  // now — the only keyboard `connectedTappingTerm` can ever describe.
  // Shared by the Analyze -> Typing Test jump button (the destination
  // view only exists to re-enter for the LIVE keyboard) and TappingTermCard
  // (tap-hold diagnostics need the live device to diagnose against).
  const isConnectedKeyboard = connectedTappingTerm?.uid === selected?.uid

  const { exportCtx, chipLabels } = useAnalyzePaneLabels({
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
  })

  const {
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
  } = useAnalyzePaneStoreActions({
    selectedUid,
    selected,
    analysisTab,
    setAnalysisTab,
    range,
    setRange,
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
    exportCtx,
    fingerAssignments,
    keymapSnapshot,
    layoutLookup,
  })

  return (
    <>
      <section className="relative flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden">
        {currentPhase !== null && (
          // Device name is intentionally omitted — the Keyboards select
          // already surfaces which keyboard is selected, so the overlay
          // would just duplicate it. The overlay covers only the chart
          // section; the footer's Back button stays clickable while the
          // load completes.
          <ConnectingOverlay
            deviceName=""
            deviceId=""
            syncOnly
            loadingProgress={`analyze.loading.${currentPhase}`}
            syncProgress={currentPhase === 'syncing' ? syncProgress : null}
          />
        )}
        {/* Tab list — pinned to the very top so the analysis the user
         * cares about anchors the page; filters drop below the tabs.
         * Renders only when a keyboard is selected so the empty
         * "select a keyboard" state stays compact. */}
        {selected && (
          <AnalyzePaneTabBar
            tid={tid}
            analysisTab={analysisTab}
            setAnalysisTab={setAnalysisTab}
            storePanelOpen={storePanelOpen}
            storeToggleRef={storeToggleRef}
            handleToggleStorePanel={handleToggleStorePanel}
          />
        )}
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Filter row — always visible. Row 1 is a collapsed summary chip
         * (keyboard / device / source / period) that opens the staged
         * `AnalyzeFilterModal`; every common condition — including the
         * keymap snapshot pick — is edited inside the modal, so the chip
         * gets the full row width for its labels. Row 2 (tab-specific
         * filters) renders once a keyboard is selected. Wrapped (with
         * the chart below) inside the `relative overflow-hidden` block
         * so the slide-in panel starts directly under the tab bar and
         * covers the filter row along with the chart. */}
        <AnalyzePaneFilterRow
          tid={tid}
          selected={selected}
          filtersReady={filtersReady}
          syncingAnalytics={syncingAnalytics}
          chipLabels={chipLabels}
          onOpenFilterModal={() => setFilterModalOpen(true)}
          onOpenRunTimeline={onOpenRunTimeline}
          runIdScopes={runIdScopes}
          isConnectedKeyboard={isConnectedKeyboard}
          analysisTab={analysisTab}
          wpmFilter={wpmFilter}
          setWpm={setWpm}
          activityFilter={activityFilter}
          setActivity={setActivity}
          intervalFilter={intervalFilter}
          setIntervalFilter={setIntervalFilter}
          effectiveDistributionSection={effectiveDistributionSection}
          availableDistributionSections={availableDistributionSections}
          ergonomicsFilter={ergonomicsFilter}
          setErgonomics={setErgonomics}
          layoutComparisonFilter={layoutComparisonFilter}
          setLayoutComparison={setLayoutComparison}
          showBenchmark={showBenchmark}
          handleShowBenchmarkChange={handleShowBenchmarkChange}
          effectiveSnapshot={effectiveSnapshot}
          onOpenFingerModal={() => setFingerModalOpen(true)}
        />

        {selected ? (
          <>
            <div className="flex-1 mt-3 min-h-0 overflow-x-clip overflow-y-auto [&_*]:focus:outline-none [&_*]:focus-visible:outline-none" data-testid={tid("analyze-chart")}>
              <AnalyzePaneChart
                tid={tid}
                analysisTab={analysisTab}
                selected={selected}
                range={range}
                deviceScopes={deviceScopes}
                appScopes={appScopes}
                typingTestScopes={typingTestScopes}
                runIdScopes={runIdScopes}
                effectiveSnapshot={effectiveSnapshot}
                fingerAssignments={fingerAssignments}
                typingTestResults={typingTestResults}
                wpmFilter={wpmFilter}
                showBenchmark={showBenchmark}
                intervalFilter={intervalFilter}
                effectiveDistributionSection={effectiveDistributionSection}
                snapshotLoading={snapshotLoading}
                isConnectedKeyboard={isConnectedKeyboard}
                connectedTappingTerm={connectedTappingTerm}
                activityFilter={activityFilter}
                setActivity={setActivity}
                nowMs={nowMs}
                heatmapFilter={heatmapFilter}
                setHeatmap={setHeatmap}
                ergonomicsFilter={ergonomicsFilter}
                bigramsFilter={bigramsFilter}
                setBigrams={setBigrams}
                layoutComparisonFilter={layoutComparisonFilter}
                onSkipPercentChange={onSkipPercentChange}
                layerFilter={layerFilter}
                setLayer={setLayer}
              />
            </div>
          </>
        ) : (
          <div className="mt-3 py-6 text-center text-sm text-content-muted">
            {t('analyze.selectKeyboard')}
          </div>
        )}
          <div
            ref={storePanelRef}
            id={tid("analyze-filter-store-panel-overlay")}
            // Panel covers only the chart wrapper, not the tab + filter
            // rows above. That keeps the menu-icon toggle clickable while
            // the panel is open. `shadow-lg` only when open — when
            // translated off-screen the shadow's left bleed lands inside
            // the visible area and reads as a stray gradient.
            className={`absolute inset-y-0 right-0 z-10 w-fit min-w-80 rounded-l-lg border-l border-edge-subtle bg-surface-alt transition-transform duration-200 ease-out ${storePanelOpen ? 'translate-x-0 shadow-lg' : 'translate-x-full'}`}
            inert={!storePanelOpen || undefined}
            data-testid={tid("analyze-filter-store-panel-container")}
          >
            <AnalyzeFilterStorePanel
              uidSelected={selectedUid !== null}
              entries={filterStore.entries}
              saving={filterStore.saving}
              loading={filterStore.loading}
              onSave={handleSaveFilterSnapshot}
              onOverwriteSave={handleOverwriteFilterSnapshot}
              onLoad={handleLoadFilterSnapshot}
              onRename={filterStore.renameEntry}
              onDelete={filterStore.deleteEntry}
              onExportCurrentCsv={exportCtx !== null ? () => setModalState({ kind: 'export' }) : null}
              onExportEntryCsv={exportCtx !== null ? handleExportEntryCsv : null}
              hubActions={hubActions}
            />
          </div>
        </div>
      </section>
      <AnalyzePaneModals
        tid={tid}
        filterModalOpen={filterModalOpen}
        setFilterModalOpen={setFilterModalOpen}
        keyboards={keyboards}
        loading={loading}
        analysisTab={analysisTab}
        intervalViewMode={intervalFilter.viewMode}
        nowMs={nowMs}
        selectedUid={selectedUid}
        deviceScopes={deviceScopes}
        filterDimension={filterDimension}
        rawAppScopes={rawAppScopes}
        rawTypingTestScopes={rawTypingTestScopes}
        rawRunIdScopes={rawRunIdScopes}
        range={range}
        selectedSnapshotSavedAt={selectedSnapshotSavedAt}
        handleFilterModalApply={handleFilterModalApply}
        fingerModalOpen={fingerModalOpen}
        setFingerModalOpen={setFingerModalOpen}
        effectiveSnapshot={effectiveSnapshot}
        fingerAssignments={fingerAssignments}
        handleFingerAssignmentsSave={handleFingerAssignmentsSave}
        modalState={modalState}
        setModalState={setModalState}
        exportCtx={exportCtx}
        modalUploadProps={modalUploadProps}
      />
    </>
  )
}
