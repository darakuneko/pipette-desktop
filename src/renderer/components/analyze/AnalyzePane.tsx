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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  TypingAnalyticsDeviceInfo,
  TypingKeyboardSummary,
  TypingKeymapSnapshot,
  TypingKeymapSnapshotSummary,
} from '../../../shared/types/typing-analytics'
import type { FingerType } from '../../../shared/kle/kle-ergonomics'
import {
  ACTIVITY_CALENDAR_MONTHS_TO_SHOW,
  ACTIVITY_CALENDAR_NORMALIZATIONS,
  ACTIVITY_METRICS,
  ACTIVITY_VIEWS,
  ERGONOMICS_LEARNING_PERIODS,
  ERGONOMICS_VIEW_MODES,
  INTERVAL_UNITS,
  INTERVAL_VIEW_MODES,
  WPM_VIEW_MODES,
  isAllScope,
  isHashScope,
} from '../../../shared/types/analyze-filters'
import type {
  ActivityCalendarMonthsToShow,
  ActivityCalendarNormalization,
  ActivityMetric,
  ActivityView,
  AnalysisTabKey,
  ErgonomicsLearningPeriod,
  ErgonomicsViewMode,
  GranularityChoice,
  IntervalUnit,
  IntervalViewMode,
  RangeMs,
  WpmViewMode,
} from './analyze-types'
import type { SyncProgress } from '../../../shared/types/sync'
import { SlidersHorizontal } from 'lucide-react'
import { useAnalyzeFilters } from '../../hooks/useAnalyzeFilters'
import { useAnalyzeFilterStore, type AnalyzeFilterSnapshotPayload } from '../../hooks/useAnalyzeFilterStore'
import { useEscapeClose } from '../../hooks/useEscapeClose'
import { AnalyzeFilterStorePanel } from './AnalyzeFilterStorePanel'
import { ConnectingOverlay } from '../ConnectingOverlay'
import { ActivityChart } from './ActivityChart'
import { DeviceMultiSelect } from './DeviceMultiSelect'
import { AppSelect } from './AppSelect'
import { RangeDayPicker } from './RangeDayPicker'
import { clampRangeToBoundaries, getSnapshotBoundaries } from './clamp-range'
import { resolveAnalyzeLoadingPhase } from './analyze-loading-phase'
import { BigramsChart } from './BigramsChart'
import { ErgonomicsChart } from './ErgonomicsChart'
import { LayoutComparisonSelector } from './LayoutComparisonSelector'
import { LayoutComparisonView } from './LayoutComparisonView'
import { FingerAssignmentModal } from './FingerAssignmentModal'
import { AnalyzeExportModal, type AnalyzeExportContext } from './AnalyzeExportModal'
import { generateAnalyzeThumbnail } from './analyze-thumbnail'
import { formatDeviceLabel } from './DeviceMultiSelect'
import { formatDateTime } from '../editors/store-modal-shared'
import { IntervalChart } from './IntervalChart'
import { KeyHeatmapChart } from './KeyHeatmapChart'
import { KeymapSnapshotTimeline } from './KeymapSnapshotTimeline'
import { LayerUsageChart } from './LayerUsageChart'
import { SummaryView } from './SummaryView'
import { WpmChart } from './WpmChart'
import { WpmByAppChart } from './WpmByAppChart'
import { AppUsageChart } from './AppUsageChart'
import { FILTER_LABEL, FILTER_SELECT } from './analyze-filter-styles'
import { shiftLocalMonth } from './analyze-streak-goal'

const TAB_BTN_BASE =
  'rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors'
const TAB_BTN_IDLE = 'text-content-muted hover:text-content-secondary'
const TAB_BTN_ACTIVE = 'bg-surface text-content shadow-sm'

// Grouped left → right: 全体像 (summary) / パフォーマンス (wpm,
// interval) / 行動分析 (activity, byApp) / 負荷分析 (keyHeatmap,
// ergonomics, bigrams, layer) / 最適化 (layoutComparison).
const ANALYSIS_TABS: AnalysisTabKey[] = [
  'summary',
  'wpm', 'interval',
  'activity', 'byApp',
  'keyHeatmap', 'ergonomics', 'bigrams', 'layer',
  'layoutComparison',
]
const DAY_MS = 86_400_000
/** Default analyze window: most keyboards generate enough data in a
 * week for the charts to feel populated without the user needing to
 * reach for the From / To pickers on every entry. Absolute `fromMs` /
 * `toMs` are re-seeded on each mount so persisted filters never drag
 * a stale range forward. */
const DEFAULT_RANGE_DAYS = 7
/** How long a successful `syncAnalyticsNow` result satisfies the Analyze
 * panel before the next selection / re-mount re-triggers a pull+push.
 * Only successes count — failures fall through so the next mount can
 * retry immediately. */
const ANALYTICS_SYNC_RATE_LIMIT_MS = 5 * 60_000

/** Module-level so split-view panes that share a uid don't both fire
 * `syncAnalyticsNow` on mount — Drive only needs the pull+push once.
 * Values are millisecond timestamps of the last successful sync per uid;
 * failures stay absent so the next pane to mount retries immediately. */
const lastAnalyticsSyncSuccessAt = new Map<string, number>()

/** Test seam: clear the rate-limit map so consecutive specs that mount
 * the pane multiple times each fire the IPC instead of being suppressed
 * by an earlier spec's success. Production code never calls this. */
export function _resetAnalyticsSyncRateLimitForTests(): void {
  lastAnalyticsSyncSuccessAt.clear()
}

const WPM_MIN_SAMPLE_OPTIONS: Array<{ value: number; labelKey: string }> = [
  { value: 30_000, labelKey: 'sec30' },
  { value: 60_000, labelKey: 'min1' },
  { value: 60_000 * 2, labelKey: 'min2' },
  { value: 60_000 * 5, labelKey: 'min5' },
]

// Keep this table in sync with `GRANULARITIES` in analyze-bucket.ts;
// the first entry is the "let the chart decide" pseudo-choice.
const GRANULARITY_OPTIONS: Array<{ value: GranularityChoice; labelKey: string }> = [
  { value: 'auto', labelKey: 'auto' },
  { value: 60_000, labelKey: 'min1' },
  { value: 60_000 * 5, labelKey: 'min5' },
  { value: 60_000 * 10, labelKey: 'min10' },
  { value: 60_000 * 15, labelKey: 'min15' },
  { value: 60_000 * 30, labelKey: 'min30' },
  { value: 3_600_000, labelKey: 'hour1' },
  { value: 3_600_000 * 3, labelKey: 'hour3' },
  { value: 3_600_000 * 6, labelKey: 'hour6' },
  { value: 3_600_000 * 12, labelKey: 'hour12' },
  { value: DAY_MS, labelKey: 'day1' },
  { value: DAY_MS * 3, labelKey: 'day3' },
  { value: DAY_MS * 7, labelKey: 'week1' },
  { value: DAY_MS * 30, labelKey: 'month1' },
]

export type AnalyzePaneKey = 'A' | 'B'

export interface AnalyzePaneProps {
  /** Identifies the pane so per-pane state (filters, testids) can stay
   * independent when two panes render side-by-side. Defaults to `'A'`
   * for the historical single-pane case. */
  paneKey?: AnalyzePaneKey
  /** True when the parent is rendering two panes side-by-side. The
   * pane re-arranges the filter row to keep Row 1 short (Keyboards /
   * Device / Keymap snapshots) and pushes Period plus the per-tab
   * filters down to Row 2 so the dense split layout stays readable. */
  splitMode?: boolean
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
}

export function AnalyzePane({
  paneKey = 'A',
  splitMode = false,
  keyboards,
  loading,
  selectedUid,
  onSelectUid,
  onSkipPercentChange,
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
    setDeviceScopes,
    setAppScopes,
    setHeatmap,
    setWpm,
    setInterval: setIntervalFilter,
    setActivity,
    setLayer,
    setErgonomics,
    setBigrams,
    setLayoutComparison,
  } = useAnalyzeFilters(selectedUid, paneKey)
  const [keymapSnapshot, setKeymapSnapshot] = useState<TypingKeymapSnapshot | null>(null)
  const [snapshotLoading, setSnapshotLoading] = useState(false)
  const [snapshotSummaries, setSnapshotSummaries] = useState<TypingKeymapSnapshotSummary[]>([])
  const [summariesLoading, setSummariesLoading] = useState(false)
  // The snapshot the timeline picker is currently pointing at. The
  // primary range is clamped to this snapshot's `[savedAt, nextSavedAt)`
  // window via `clampRangeToBoundaries` so charts that rely on the
  // snapshot (Heatmap / Ergonomics / Layer activations) only ever
  // aggregate keystrokes that match the displayed keymap. `null` means
  // either no keyboard is selected or the keyboard has no recorded
  // snapshots — in that case the range is free-form.
  const [selectedSnapshotSavedAt, setSelectedSnapshotSavedAt] = useState<number | null>(null)
  const [fingerAssignments, setFingerAssignments] = useState<Record<string, FingerType>>({})
  const [fingersLoading, setFingersLoading] = useState(false)
  const [fingerModalOpen, setFingerModalOpen] = useState(false)
  // The export modal does double duty: CSV export when invoked with
  // mode 'export', Hub upload when invoked with mode 'upload'. The
  // upload variant pins the saved entry id so the modal's onConfirm
  // can build the upload params for that specific entry.
  const [modalState, setModalState] = useState<
    | { kind: 'closed' }
    | { kind: 'export' }
    | { kind: 'upload'; entryId: string }
  >({ kind: 'closed' })
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
  // `loaded` gates the "persisted hash no longer exists" fallback so a
  // slow fetch doesn't clobber a valid selection before the list
  // resolves; `error` lets the loading-phase overlay release after a
  // transient IPC failure instead of stalling on "preparing" forever.
  // The two are distinct because the fallback must not fire on error.
  // `own` carries this machine's OS info so the Device filter can
  // label the local entry without a separate IPC.
  const [deviceInfos, setDeviceInfos] = useState<{
    own: TypingAnalyticsDeviceInfo | null
    remotes: readonly TypingAnalyticsDeviceInfo[]
    loaded: boolean
    error: boolean
  }>({
    own: null,
    remotes: [],
    loaded: false,
    error: false,
  })
  // Analytics-only sync runs on Analyze mount (see
  // .claude/rules/settings-persistence.md). The per-uid rate-limit map
  // lives at module scope so split-view panes that share a uid don't
  // both fire the IPC. `syncingAnalytics` gates this pane's filter row
  // the same way `filtersReady` does.
  const [syncingAnalytics, setSyncingAnalytics] = useState(false)

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

  // Snapshot timeline data is uid-scoped, not range-scoped — we want
  // every snapshot the user has ever recorded so the options stay
  // stable across range edits. Re-fetch only when the keyboard
  // changes. On the first fetch for a given uid, jump the primary
  // range to the latest snapshot's active window so the user lands on
  // "current keymap" data; subsequent range edits within the same
  // keyboard are not overridden.
  const autoSetRangeForUidRef = useRef<string | null>(null)
  useEffect(() => {
    // Clear the previous keyboard's snapshot state up-front so the
    // timeline / boundary hint / compare window don't briefly render
    // stale data while the new fetch is in flight, and so a fetch
    // error doesn't leave them pointing at the previous keyboard.
    setSnapshotSummaries([])
    setSelectedSnapshotSavedAt(null)
    if (!selectedUid) {
      setSummariesLoading(false)
      return
    }
    let cancelled = false
    setSummariesLoading(true)
    void window.vialAPI
      .typingAnalyticsListKeymapSnapshots(selectedUid)
      .then((list) => {
        if (cancelled) return
        setSnapshotSummaries(list)
        if (list.length > 0 && autoSetRangeForUidRef.current !== selectedUid) {
          const latest = list[list.length - 1]
          setRange({ fromMs: latest.savedAt, toMs: nowMs })
          setSelectedSnapshotSavedAt(latest.savedAt)
          autoSetRangeForUidRef.current = selectedUid
        }
      })
      .catch(() => {
        if (cancelled) return
        setSnapshotSummaries([])
        setSelectedSnapshotSavedAt(null)
      })
      .finally(() => { if (!cancelled) setSummariesLoading(false) })
    return () => { cancelled = true }
  }, [selectedUid, nowMs])

  // Reset the Base Layer select when the snapshot's layer count shrinks
  // past the current selection (device switch, keymap edit). Without
  // this, a stale baseLayer would render an out-of-range <option> and
  // the aggregator would silently skip nothing meaningful.
  useEffect(() => {
    if (keymapSnapshot && layerFilter.baseLayer >= keymapSnapshot.layers) {
      setLayer({ baseLayer: 0 })
    }
  }, [keymapSnapshot, layerFilter.baseLayer, setLayer])

  useEffect(() => {
    if (!selectedUid) { setFingerAssignments({}); setFingersLoading(false); return }
    let cancelled = false
    setFingersLoading(true)
    void window.vialAPI
      .pipetteSettingsGet(selectedUid)
      .then((prefs) => {
        if (cancelled) return
        setFingerAssignments(prefs?.analyze?.fingerAssignments ?? {})
      })
      .catch(() => { if (!cancelled) setFingerAssignments({}) })
      .finally(() => { if (!cancelled) setFingersLoading(false) })
    return () => { cancelled = true }
  }, [selectedUid])

  // Per-keyboard device infos (own + remotes) power the Device
  // select's labelled options. Mark `loaded` after the fetch resolves
  // so the fallback below doesn't race the first paint and wipe a
  // valid persisted hash selection.
  useEffect(() => {
    if (!selectedUid) {
      setDeviceInfos({ own: null, remotes: [], loaded: false, error: false })
      return
    }
    let cancelled = false
    setDeviceInfos({ own: null, remotes: [], loaded: false, error: false })
    void window.vialAPI
      .typingAnalyticsListDeviceInfos(selectedUid)
      .then((bundle) => {
        if (cancelled) return
        if (bundle === null) {
          setDeviceInfos({ own: null, remotes: [], loaded: true, error: false })
          return
        }
        setDeviceInfos({ own: bundle.own, remotes: bundle.remotes, loaded: true, error: false })
      })
      // `loaded: false` on error keeps the "missing from list" fallback
      // from wiping a valid persisted hash selection; `error: true`
      // lets the overlay release instead of stalling on preparing.
      .catch(() => {
        if (!cancelled) setDeviceInfos({ own: null, remotes: [], loaded: false, error: true })
      })
    return () => { cancelled = true }
  }, [selectedUid])

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

  // The active window of the currently-selected snapshot. `null` means
  // "no clamp" — either no snapshot is picked yet or the keyboard has
  // none on file. Used to gate the date-input min/max attributes and
  // to feed `clampRangeToSnapshot` so charts never see a `range` that
  // straddles a keymap edit.
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
    if (analysisTab === 'activity' && activityFilter.view === 'calendar') return
    setRange((prev) => clampRangeToBoundaries(prev, snapshotBoundaries))
  }, [snapshotBoundaries, analysisTab, activityFilter.view])

  // Selecting a snapshot resets the range to the snapshot's active
  // window; narrowing inside the window leaves `selectedSnapshotSavedAt`
  // untouched so the picker keeps reflecting the user's choice.
  const handleSelectSnapshot = useCallback((savedAt: number) => {
    const bounds = getSnapshotBoundaries(savedAt, snapshotSummaries, nowMs)
    if (bounds === null) return
    setSelectedSnapshotSavedAt(savedAt)
    setRange({ fromMs: bounds.lo, toMs: bounds.hi })
  }, [snapshotSummaries, nowMs])

  // Uid-prefixed filter — the backend allows parallel per-uid
  // analytics syncs, so a plain analytics-prefix filter would display
  // progress for a keyboard the user is no longer looking at.
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null)
  useEffect(() => {
    if (!selectedUid) { setSyncProgress(null); return }
    const prefix = `keyboards/${selectedUid}/devices/`
    return window.vialAPI.syncOnProgress((p) => {
      if (!p.syncUnit?.startsWith(prefix)) return
      setSyncProgress(p)
    })
  }, [selectedUid])

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

  // Pull + push typing-analytics for the selected keyboard on mount /
  // keyboard switch. Rate-limited to one pass per 5 minutes per uid
  // (success-only) so rapid re-selects don't hammer Drive. Silent
  // failure — filter row lock releases in `finally` regardless, so the
  // user never gets stuck.
  useEffect(() => {
    if (!selectedUid) return
    const last = lastAnalyticsSyncSuccessAt.get(selectedUid) ?? 0
    if (Date.now() - last < ANALYTICS_SYNC_RATE_LIMIT_MS) return
    let cancelled = false
    setSyncingAnalytics(true)
    void window.vialAPI
      .syncAnalyticsNow(selectedUid)
      .then((ok) => {
        if (cancelled) return
        if (ok) {
          lastAnalyticsSyncSuccessAt.set(selectedUid, Date.now())
        }
      })
      .catch(() => { /* silent — next mount retries */ })
      .finally(() => {
        if (cancelled) return
        setSyncingAnalytics(false)
        // Clear any stale progress frame so the next entry does not
        // flash the tail-end of the previous run.
        setSyncProgress(null)
      })
    return () => { cancelled = true }
  }, [selectedUid])

  const handleFingerAssignmentsSave = useCallback(
    async (next: Record<string, FingerType>) => {
      setFingerAssignments(next)
      if (!selectedUid) return
      try {
        const prefs = await window.vialAPI.pipetteSettingsGet(selectedUid)
        if (!prefs) return
        const hasAny = Object.keys(next).length > 0
        const analyze = hasAny
          ? { ...prefs.analyze, fingerAssignments: next }
          : { ...prefs.analyze, fingerAssignments: undefined }
        await window.vialAPI.pipetteSettingsSet(selectedUid, { ...prefs, analyze })
      } catch {
        // best-effort save
      }
    },
    [selectedUid],
  )

  const selected = selectedUid
    ? keyboards.find((kb) => kb.uid === selectedUid) ?? null
    : null

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

    // Reuse the same labels the filter row already shows so the modal
    // reads as a context echo, not a separate source of truth.
    const remoteHit = isHashScope(scope)
      ? deviceInfos.remotes.find((r) => r.machineHash === scope.machineHash) ?? null
      : null
    const deviceLabel = isAllScope(scope)
      ? t('analyze.filters.deviceOption.all')
      : isHashScope(scope) && remoteHit !== null
        ? formatDeviceLabel(remoteHit)
        : deviceInfos.own !== null
          ? formatDeviceLabel(deviceInfos.own)
          : t('analyze.filters.deviceOption.own')
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
    const rangeLabel = `${formatDateTime(range.fromMs)} - ${formatDateTime(range.toMs)}`
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
      layoutComparison: layoutComparisonFilter,
      fingerOverrides: fingerAssignments,
      conditions: { device: deviceLabel, app: appLabel, keymap: keymapLabel, range: rangeLabel },
    }
  }, [
    selected, deviceScopes, appScopes, deviceInfos, range, effectiveSnapshot, selectedSnapshotSavedAt,
    snapshotSummaries, heatmapFilter, wpmFilter, intervalFilter, activityFilter, layerFilter,
    layoutComparisonFilter, fingerAssignments, t,
  ])

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
        appScopes,
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
    deviceScopes, appScopes, heatmapFilter, wpmFilter, intervalFilter,
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
      filterStore, setAnalysisTab, setRange, setDeviceScopes, setAppScopes,
      setHeatmap, setWpm, setIntervalFilter, setActivity, setLayer,
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

  // Build the upload IPC input for a saved entry. Captures the
  // thumbnail just-in-time so cancelled / never-clicked rows pay
  // nothing for the canvas work. The title falls back to the entry's
  // saved label so the user doesn't have to retype it. Returns null
  // when prerequisites (selected keyboard / matching saved entry)
  // aren't met so the modal callback can short-circuit.
  const buildHubUploadInput = useCallback((entryId: string) => {
    if (!selected || !hubKeyboard) return null
    const entry = filterStore.entries.find((e) => e.id === entryId)
    if (!entry) return null
    const rangeLabel = exportCtx?.conditions.range
      ?? `${formatDateTime(range.fromMs)} - ${formatDateTime(range.toMs)}`
    const thumbnailBase64 = generateAnalyzeThumbnail({
      keyboardName: selected.productName,
      rangeLabel,
      // The thumb is text-only today; the Hub-side post grid still
      // surfaces the real keystroke total from the JSON. Skip the
      // extra preview round-trip just for colouring the card.
      totalKeystrokes: 0,
      deviceLabel: exportCtx?.conditions.device,
    })
    return {
      entryId,
      title: entry.label,
      thumbnailBase64,
      keyboard: hubKeyboard,
      fingerOverrides: fingerAssignments,
      // Layout Comparison upload remains a follow-up — see
      // .claude/plans/done/Plan-hub-analytics-upload.md "Known
      // Follow-up" notes. The Hub renders the empty-state for the tab.
      layoutComparisonInputs: null,
    }
  }, [selected, hubKeyboard, filterStore.entries, exportCtx, range, fingerAssignments])

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
      onConfirm: async (categories: ReadonlySet<string>) => {
        const baseInput = buildHubUploadInput(entry.id)
        if (!baseInput) return { ok: false }
        const input = {
          ...baseInput,
          categories: Array.from(categories) as Parameters<typeof filterStore.uploadEntryToHub>[0]['categories'],
        }
        return isExisting
          ? filterStore.updateEntryOnHub(input)
          : filterStore.uploadEntryToHub(input)
      },
    }
  }, [uploadEntryForModal, filterStore, buildHubUploadInput])

  // Activity's per-tab filters render in two places: alongside Period
  // on Row 2 in split mode, or on Row 3 in single mode. Extracted so
  // the JSX stays in one place. Order: View → Range size + cursor
  // (calendar only) → Metric → view-specific extras (calendar
  // normalize, or grid WPM min-sample).
  const activityFilters = (
    <>
      <label className={FILTER_LABEL}>
        <span>{t('analyze.filters.activityView')}</span>
        <select
          className={FILTER_SELECT}
          value={activityFilter.view}
          onChange={(e) => setActivity({ view: e.target.value as ActivityView })}
          data-testid={tid("analyze-filter-activity-view")}
        >
          {ACTIVITY_VIEWS.map((key) => (
            <option key={key} value={key}>
              {t(`analyze.filters.activityViewOption.${key}`)}
            </option>
          ))}
        </select>
      </label>
      {activityFilter.view === 'calendar' && (
        <>
          <label className={FILTER_LABEL}>
            <span>{t('analyze.filters.calendarRange')}</span>
            <select
              className={FILTER_SELECT}
              value={String(activityFilter.calendar.monthsToShow)}
              onChange={(e) => setActivity({ calendar: { monthsToShow: Number.parseInt(e.target.value, 10) as ActivityCalendarMonthsToShow } })}
              data-testid={tid("analyze-filter-calendar-range")}
            >
              {ACTIVITY_CALENDAR_MONTHS_TO_SHOW.map((n) => (
                <option key={n} value={String(n)}>
                  {t(`analyze.filters.calendarRangeOption.${n}`)}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <label className={FILTER_LABEL}>
        <span>{t('analyze.filters.activityMetric')}</span>
        <select
          className={FILTER_SELECT}
          value={activityFilter.metric}
          onChange={(e) => setActivity({ metric: e.target.value as ActivityMetric })}
          data-testid={tid("analyze-filter-activity-metric")}
        >
          {ACTIVITY_METRICS.map((key) => (
            <option key={key} value={key}>
              {t(`analyze.filters.activityMetricOption.${key}`)}
            </option>
          ))}
        </select>
      </label>
      {activityFilter.view === 'grid' && activityFilter.metric === 'wpm' && (
        <label className={FILTER_LABEL}>
          <span>{t('analyze.filters.wpmMinSample')}</span>
          <select
            className={FILTER_SELECT}
            value={String(wpmFilter.minActiveMs)}
            onChange={(e) => setWpm({ minActiveMs: Number.parseInt(e.target.value, 10) })}
            data-testid={tid("analyze-filter-activity-min-sample")}
          >
            {WPM_MIN_SAMPLE_OPTIONS.map((opt) => (
              <option key={opt.labelKey} value={String(opt.value)}>
                {t(`analyze.filters.wpmMinSampleOption.${opt.labelKey}`)}
              </option>
            ))}
          </select>
        </label>
      )}
      {activityFilter.view === 'calendar' && (
        <label className={FILTER_LABEL}>
          <span>{t('analyze.filters.calendarNormalization')}</span>
          <select
            className={FILTER_SELECT}
            value={activityFilter.calendar.normalization}
            onChange={(e) => setActivity({ calendar: { normalization: e.target.value as ActivityCalendarNormalization } })}
            data-testid={tid("analyze-filter-calendar-normalization")}
          >
            {ACTIVITY_CALENDAR_NORMALIZATIONS.map((key) => (
              <option key={key} value={key}>
                {t(`analyze.filters.calendarNormalizationOption.${key}`)}
              </option>
            ))}
          </select>
        </label>
      )}
    </>
  )

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
          <div className="flex items-center justify-between gap-2 rounded-lg bg-surface-dim p-1">
            <div
              className="flex gap-1"
              data-testid={tid("analyze-tabs")}
              role="tablist"
              aria-label={t('analyze.tablistLabel')}
            >
              {ANALYSIS_TABS.map((key) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={analysisTab === key}
                  className={`${TAB_BTN_BASE} ${analysisTab === key ? TAB_BTN_ACTIVE : TAB_BTN_IDLE}`}
                  onClick={() => setAnalysisTab(key)}
                  data-testid={tid(`analyze-tab-${key}`)}
                >
                  {t(`analyze.analysisTab.${key}`)}
                </button>
              ))}
            </div>
            <button
              ref={storeToggleRef}
              type="button"
              aria-label={t('analyzeFilterStore.title')}
              aria-expanded={storePanelOpen}
              aria-controls={tid("analyze-filter-store-panel-overlay")}
              className={`rounded p-1.5 transition-colors ${storePanelOpen ? 'bg-surface text-accent shadow-sm' : 'text-content-muted hover:bg-surface hover:text-content'}`}
              onClick={handleToggleStorePanel}
              data-testid={tid("analyze-filter-store-toggle")}
            >
              <SlidersHorizontal size={16} aria-hidden="true" />
            </button>
          </div>
        )}
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Filter row — always visible. Keyboard select is the first
         * column so the user can pick a keyboard from inside the filter
         * group; the rest of the filters render once a keyboard is
         * selected. Wrapped (with the chart below) inside the
         * `relative overflow-hidden` block so the slide-in panel
         * starts directly under the tab bar and covers the filter row
         * along with the chart. */}
        <div
          className={`grid min-w-0 shrink-0 items-center gap-x-3 gap-y-2 overflow-x-auto border-b border-edge pb-3 mt-3 ${
            selected !== null && (!filtersReady || syncingAnalytics) ? 'pointer-events-none opacity-60' : ''
          }`}
          // 10 outer columns shared via `grid-cols-subgrid` on each row
          // so the label / control widths line up vertically across rows
          // even when the per-tab filters change. `display: contents`
          // on each FILTER_LABEL flattens its text + control into the
          // subgrid.
          style={{ gridTemplateColumns: 'repeat(10, max-content)' }}
          data-testid={tid("analyze-filters")}
          aria-busy={selected !== null && (!filtersReady || syncingAnalytics)}
        >
          {/* Row 1: Keyboard select (always) + Device / Keymap / Period
           * (only after a keyboard is picked). */}
          <div className="col-span-10 grid grid-cols-subgrid items-center gap-x-3 gap-y-2">
            <label className={FILTER_LABEL}>
              <span>{t('analyze.filters.keyboard')}</span>
              <select
                className={FILTER_SELECT}
                value={selectedUid ?? ''}
                onChange={(e) => onSelectUid(e.target.value || null)}
                disabled={loading || currentPhase !== null || keyboards.length === 0}
                aria-label={t('analyze.filters.keyboard')}
                data-testid={tid("analyze-filter-keyboard")}
              >
                {loading ? (
                  <option value="">{t('common.loading')}</option>
                ) : keyboards.length === 0 ? (
                  <option value="" data-testid={tid("analyze-no-keyboards")}>{t('analyze.noKeyboards')}</option>
                ) : (
                  <>
                    {selectedUid === null && (
                      <option value="">{t('analyze.selectKeyboard')}</option>
                    )}
                    {keyboards.map((kb) => (
                      <option key={kb.uid} value={kb.uid} data-testid={tid(`analyze-kb-${kb.uid}`)}>
                        {kb.productName || kb.uid}
                      </option>
                    ))}
                  </>
                )}
              </select>
            </label>
            {selected && (
              <>
                {!(analysisTab === 'interval' && intervalFilter.viewMode === 'distribution') ? (
                  <>
                    <label className={FILTER_LABEL}>
                      <span>{t('analyze.filters.device')}</span>
                      <DeviceMultiSelect
                        value={deviceScopes}
                        ownDevice={deviceInfos.own}
                        remoteDevices={deviceInfos.remotes}
                        onChange={setDeviceScopes}
                        ariaLabel={t('analyze.filters.device')}
                      />
                    </label>
                    {/* App filter sits next to the Device picker so the
                        user reads the scope in the same row: keyboard,
                        device, app, period. Hidden on the By App tab —
                        those charts compare across apps so any single-
                        app filter would collapse the result to one
                        slice / bar. The empty span keeps the grid
                        column count stable across tabs. */}
                    {analysisTab === 'byApp' ? (
                      <span />
                    ) : (
                      <label className={FILTER_LABEL}>
                        <span>{t('analyze.filters.app')}</span>
                        <AppSelect
                          uid={selected.uid}
                          range={range}
                          deviceScopes={deviceScopes}
                          value={appScopes}
                          onChange={setAppScopes}
                          ariaLabel={t('analyze.filters.app')}
                        />
                      </label>
                    )}
                  </>
                ) : (
                  <>
                    <span />
                    <span />
                  </>
                )}
                <KeymapSnapshotTimeline
                  summaries={snapshotSummaries}
                  selectedSavedAt={selectedSnapshotSavedAt}
                  onSelectSnapshot={handleSelectSnapshot}
                />
                {/* Period stays on Row 1 in single-pane mode but
                 * slides down to Row 2 when split-view is on so the
                 * per-pane row stays narrow enough for two panes to
                 * fit. */}
                {!splitMode && (
                  <RangeDayPicker
                    range={range}
                    snapshotBoundaries={snapshotBoundaries}
                    nowMs={nowMs}
                    onChange={setRange}
                    labelKey="analyze.filters.period"
                    testIdPrefix={tid("analyze-filter-range")}
                  />
                )}
              </>
            )}
          </div>
          {/* Per-tab filter row: in single-pane mode this is just the
           * tab-specific filters; in split mode the period picker and
           * the Ergonomics finger-assignment button slide down here so
           * Row 1 stays narrow enough for the two panes side-by-side.
           * Subgrid alignment keeps every row's labels left and
           * values right under the keyboard / device columns above. */}
          {selected && (
            <div className="col-span-10 grid grid-cols-subgrid items-center gap-x-3 gap-y-2">
              {splitMode && (
                <RangeDayPicker
                  range={range}
                  snapshotBoundaries={snapshotBoundaries}
                  nowMs={nowMs}
                  onChange={setRange}
                  labelKey="analyze.filters.period"
                  testIdPrefix={tid("analyze-filter-range")}
                />
              )}
              {analysisTab === 'wpm' && (
                <>
                  <label className={FILTER_LABEL}>
                    <span>{t('analyze.filters.wpmViewMode')}</span>
                    <select
                      className={FILTER_SELECT}
                      value={wpmFilter.viewMode}
                      onChange={(e) => setWpm({ viewMode: e.target.value as WpmViewMode })}
                      data-testid={tid("analyze-filter-wpm-view-mode")}
                    >
                      {WPM_VIEW_MODES.map((key) => (
                        <option key={key} value={key}>
                          {t(`analyze.filters.wpmViewModeOption.${key}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={FILTER_LABEL}>
                    <span>{t('analyze.filters.wpmMinSample')}</span>
                    <select
                      className={FILTER_SELECT}
                      value={String(wpmFilter.minActiveMs)}
                      onChange={(e) => setWpm({ minActiveMs: Number.parseInt(e.target.value, 10) })}
                      data-testid={tid("analyze-filter-wpm-min-sample")}
                    >
                      {WPM_MIN_SAMPLE_OPTIONS.map((opt) => (
                        <option key={opt.labelKey} value={String(opt.value)}>
                          {t(`analyze.filters.wpmMinSampleOption.${opt.labelKey}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              {analysisTab === 'activity' && activityFilters}
              {analysisTab === 'interval' && (
                <>
                  <label className={FILTER_LABEL}>
                    <span>{t('analyze.filters.intervalViewMode')}</span>
                    <select
                      className={FILTER_SELECT}
                      value={intervalFilter.viewMode}
                      onChange={(e) => setIntervalFilter({ viewMode: e.target.value as IntervalViewMode })}
                      data-testid={tid("analyze-filter-interval-view-mode")}
                    >
                      {INTERVAL_VIEW_MODES.map((key) => (
                        <option key={key} value={key}>
                          {t(`analyze.filters.intervalViewModeOption.${key}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={FILTER_LABEL}>
                    <span>{t('analyze.filters.unit')}</span>
                    <select
                      className={FILTER_SELECT}
                      value={intervalFilter.unit}
                      onChange={(e) => setIntervalFilter({ unit: e.target.value as IntervalUnit })}
                      data-testid={tid("analyze-filter-unit")}
                    >
                      {INTERVAL_UNITS.map((key) => (
                        <option key={key} value={key}>
                          {t(`analyze.filters.unitOption.${key}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              {analysisTab === 'ergonomics' && (
                <>
                  <label className={FILTER_LABEL}>
                    <span>{t('analyze.filters.ergonomicsViewMode')}</span>
                    <select
                      className={FILTER_SELECT}
                      value={ergonomicsFilter.viewMode}
                      onChange={(e) => setErgonomics({ viewMode: e.target.value as ErgonomicsViewMode })}
                      data-testid={tid("analyze-filter-ergonomics-view-mode")}
                    >
                      {ERGONOMICS_VIEW_MODES.map((key) => (
                        <option key={key} value={key}>
                          {t(`analyze.filters.ergonomicsViewModeOption.${key}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {ergonomicsFilter.viewMode === 'learning' && (
                    <label className={FILTER_LABEL}>
                      <span>{t('analyze.filters.ergonomicsPeriod')}</span>
                      <select
                        className={FILTER_SELECT}
                        value={ergonomicsFilter.period}
                        onChange={(e) => setErgonomics({ period: e.target.value as ErgonomicsLearningPeriod })}
                        data-testid={tid("analyze-filter-ergonomics-period")}
                      >
                        {ERGONOMICS_LEARNING_PERIODS.map((key) => (
                          <option key={key} value={key}>
                            {t(`analyze.filters.ergonomicsPeriodOption.${key}`)}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </>
              )}
              {analysisTab === 'layoutComparison' && (
                <LayoutComparisonSelector
                  sourceLayoutId={layoutComparisonFilter.sourceLayoutId}
                  targetLayoutId={layoutComparisonFilter.targetLayoutId}
                  onSourceChange={(sourceLayoutId) => setLayoutComparison({ sourceLayoutId })}
                  onTargetChange={(targetLayoutId) => setLayoutComparison({ targetLayoutId })}
                />
              )}
              {((analysisTab === 'wpm' && wpmFilter.viewMode === 'timeSeries') || (analysisTab === 'interval' && intervalFilter.viewMode === 'timeSeries')) && (
                <label className={FILTER_LABEL}>
                  <span>{t('analyze.filters.granularity')}</span>
                  <select
                    className={FILTER_SELECT}
                    value={typeof wpmFilter.granularity === 'number' ? String(wpmFilter.granularity) : 'auto'}
                    onChange={(e) => {
                      const v = e.target.value
                      setWpm({ granularity: v === 'auto' ? 'auto' : Number.parseInt(v, 10) })
                    }}
                    data-testid={tid("analyze-filter-granularity")}
                  >
                    {GRANULARITY_OPTIONS.map((opt) => (
                      <option key={opt.labelKey} value={typeof opt.value === 'number' ? String(opt.value) : 'auto'}>
                        {t(`analyze.filters.granularityOption.${opt.labelKey}`)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {/* Layer tab: filters live inside the chart sections —
               * the base-layer select rides next to the activations
               * heading instead of in this global filter row. */}
            </div>
          )}
        </div>

        {selected ? (
          <>
            <div className="flex-1 mt-3 min-h-0 overflow-x-clip overflow-y-auto [&_*]:focus:outline-none [&_*]:focus-visible:outline-none" data-testid={tid("analyze-chart")}>
              {analysisTab === 'summary' ? (
                <SummaryView
                  uid={selected.uid}
                  deviceScope={deviceScopes[0]}
                  appScopes={appScopes}
                  snapshot={effectiveSnapshot}
                  fingerOverrides={fingerAssignments}
                />
              ) : analysisTab === 'wpm' ? (
                <WpmChart
                  uid={selected.uid}
                  range={range}
                  deviceScopes={deviceScopes}
                  appScopes={appScopes}
                  granularity={wpmFilter.granularity}
                  viewMode={wpmFilter.viewMode}
                  minActiveMs={wpmFilter.minActiveMs}
                />
              ) : analysisTab === 'interval' ? (
                <IntervalChart
                  uid={selected.uid}
                  range={range}
                  deviceScopes={deviceScopes}
                  appScopes={appScopes}
                  unit={intervalFilter.unit}
                  granularity={wpmFilter.granularity}
                  viewMode={intervalFilter.viewMode}
                />
              ) : analysisTab === 'activity' ? (
                <ActivityChart
                  uid={selected.uid}
                  range={range}
                  deviceScope={deviceScopes[0]}
                  appScopes={appScopes}
                  metric={activityFilter.metric}
                  view={activityFilter.view}
                  minActiveMs={wpmFilter.minActiveMs}
                  calendarFilter={activityFilter.calendar}
                  nowMs={nowMs}
                  onShiftCalendarMonth={(delta) => setActivity({ calendar: { endMonthIso: shiftLocalMonth(activityFilter.calendar.endMonthIso, delta) } })}
                />
              ) : analysisTab === 'keyHeatmap' ? (
                effectiveSnapshot !== null ? (
                  <KeyHeatmapChart
                    uid={selected.uid}
                    range={range}
                    deviceScope={deviceScopes[0]}
                    appScopes={appScopes}
                    snapshot={effectiveSnapshot}
                    heatmap={heatmapFilter}
                    onHeatmapChange={setHeatmap}
                  />
                ) : (
                  <div className="py-4 text-center text-[13px] text-content-muted" data-testid={tid("analyze-keyheatmap-empty")}>
                    {t('analyze.keyHeatmap.noSnapshot')}
                  </div>
                )
              ) : analysisTab === 'ergonomics' ? (
                effectiveSnapshot !== null ? (
                  <ErgonomicsChart
                    uid={selected.uid}
                    range={range}
                    deviceScopes={deviceScopes}
                    appScopes={appScopes}
                    snapshot={effectiveSnapshot}
                    fingerOverrides={fingerAssignments}
                    viewMode={ergonomicsFilter.viewMode}
                    period={ergonomicsFilter.period}
                    learningMinSampleKeystrokes={ergonomicsFilter.minSampleKeystrokes}
                    onOpenFingerAssignment={() => setFingerModalOpen(true)}
                  />
                ) : (
                  <div className="py-4 text-center text-[13px] text-content-muted" data-testid={tid("analyze-ergonomics-no-snapshot")}>
                    {t('analyze.ergonomics.noSnapshot')}
                  </div>
                )
              ) : analysisTab === 'bigrams' ? (
                <BigramsChart
                  uid={selected.uid}
                  range={range}
                  deviceScopes={deviceScopes}
                  appScopes={appScopes}
                  topLimit={bigramsFilter.topLimit}
                  slowLimit={bigramsFilter.slowLimit}
                  fingerLimit={bigramsFilter.fingerLimit}
                  pairIntervalThresholdMs={bigramsFilter.pairIntervalThresholdMs}
                  onTopLimitChange={(topLimit) => setBigrams({ topLimit })}
                  onSlowLimitChange={(slowLimit) => setBigrams({ slowLimit })}
                  onFingerLimitChange={(fingerLimit) => setBigrams({ fingerLimit })}
                  onPairIntervalThresholdChange={(pairIntervalThresholdMs) => setBigrams({ pairIntervalThresholdMs })}
                  snapshot={effectiveSnapshot}
                  fingerOverrides={fingerAssignments}
                />
              ) : analysisTab === 'layoutComparison' ? (
                <LayoutComparisonView
                  uid={selected.uid}
                  range={range}
                  deviceScopes={deviceScopes}
                  appScopes={appScopes}
                  snapshot={effectiveSnapshot}
                  filter={layoutComparisonFilter}
                  onSkipPercentChange={onSkipPercentChange}
                />
              ) : analysisTab === 'layer' ? (
                // Two columns side-by-side, each scrolling independently.
                // Layers can run up to ~32, so a single shared scroll
                // would force the user to scroll past one chart to read
                // the other. `min-h-0` lets the inner overflow take
                // effect; `min-w-0` keeps the recharts measurement from
                // pushing either column wider than its grid track.
                <div className="grid h-full min-h-0 grid-cols-2 gap-4">
                  <div className="min-w-0 overflow-y-auto pr-1">
                    <LayerUsageChart
                      uid={selected.uid}
                      range={range}
                      deviceScopes={deviceScopes}
                      appScopes={appScopes}
                      snapshot={effectiveSnapshot}
                      viewMode="keystrokes"
                      baseLayer={layerFilter.baseLayer}
                    />
                  </div>
                  <div className="min-w-0 overflow-y-auto pr-1">
                    <LayerUsageChart
                      uid={selected.uid}
                      range={range}
                      deviceScopes={deviceScopes}
                      appScopes={appScopes}
                      snapshot={effectiveSnapshot}
                      viewMode="activations"
                      baseLayer={layerFilter.baseLayer}
                      onBaseLayerChange={(baseLayer) => setLayer({ baseLayer })}
                    />
                  </div>
                </div>
              ) : analysisTab === 'byApp' ? (
                // Dedicated tab that groups every per-app cross-section
                // chart. Both views aggregate _across_ apps regardless
                // of the App filter at the top of the panel — picking a
                // single app would collapse them to one slice / bar,
                // which is the opposite of what these views are meant
                // to show.
                <div className="flex flex-col gap-6">
                  <AppUsageChart
                    uid={selected.uid}
                    range={range}
                    deviceScopes={deviceScopes}
                  />
                  <WpmByAppChart
                    uid={selected.uid}
                    range={range}
                    deviceScopes={deviceScopes}
                  />
                </div>
              ) : null}
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
            className={`absolute inset-y-0 right-0 z-10 w-fit min-w-[320px] rounded-l-lg border-l border-edge-subtle bg-surface-alt transition-transform duration-200 ease-out ${storePanelOpen ? 'translate-x-0 shadow-lg' : 'translate-x-full'}`}
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
      <FingerAssignmentModal
        isOpen={fingerModalOpen}
        onClose={() => setFingerModalOpen(false)}
        snapshot={effectiveSnapshot}
        assignments={fingerAssignments}
        onSave={handleFingerAssignmentsSave}
      />
      <AnalyzeExportModal
        isOpen={modalState.kind !== 'closed'}
        onClose={() => setModalState({ kind: 'closed' })}
        ctx={exportCtx}
        mode={modalState.kind === 'upload' ? 'upload' : 'export'}
        upload={modalUploadProps}
      />
    </>
  )
}
