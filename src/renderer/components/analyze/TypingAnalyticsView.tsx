// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze tab content — per-keyboard typing analytics dashboard.
// C2 added the keyboard list; C3 adds the right pane header with the
// analysis tab switcher (WPM / Interval / Heatmap) and the period /
// device-scope filters. The chart bodies are stubbed here and filled
// in by C4–C6.

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  TypingKeyboardSummary,
  TypingKeymapSnapshot,
  TypingKeymapSnapshotSummary,
} from '../../../shared/types/typing-analytics'
import type { FingerType } from '../../../shared/kle/kle-ergonomics'
import {
  ACTIVITY_METRICS,
  DEVICE_SCOPES,
  INTERVAL_UNITS,
  INTERVAL_VIEW_MODES,
  LAYER_VIEW_MODES,
  WPM_VIEW_MODES,
  isHashScope,
  scopeFromSelectValue,
  scopeToSelectValue,
} from '../../../shared/types/analyze-filters'
import type { ActivityMetric, AnalysisTabKey, GranularityChoice, IntervalUnit, IntervalViewMode, LayerViewMode, RangeMs, WpmViewMode } from './analyze-types'
import type { SyncProgress } from '../../../shared/types/sync'
import { useAnalyzeFilters } from '../../hooks/useAnalyzeFilters'
import { ConnectingOverlay } from '../ConnectingOverlay'
import { ActivityChart } from './ActivityChart'
import { resolveAnalyzeLoadingPhase } from './analyze-loading-phase'
import { ErgonomicsChart } from './ErgonomicsChart'
import { FingerAssignmentModal } from './FingerAssignmentModal'
import { IntervalChart } from './IntervalChart'
import { KeyHeatmapChart } from './KeyHeatmapChart'
import { KeymapSnapshotTimeline } from './KeymapSnapshotTimeline'
import { LayerUsageChart } from './LayerUsageChart'
import { WpmChart } from './WpmChart'
import { FILTER_LABEL, FILTER_SELECT } from './analyze-filter-styles'

const SIDE_BTN_BASE =
  'block w-full rounded-md border px-3 py-2 text-left text-[13px] transition-colors'
const SIDE_BTN_IDLE =
  'border-transparent bg-transparent text-content-secondary hover:border-edge hover:bg-surface-dim'
const SIDE_BTN_ACTIVE =
  'border-accent bg-accent/10 text-content'

const TAB_BTN_BASE =
  'rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors'
const TAB_BTN_IDLE = 'text-content-muted hover:text-content-secondary'
const TAB_BTN_ACTIVE = 'bg-surface text-content shadow-sm'

const ANALYSIS_TABS: AnalysisTabKey[] = ['keyHeatmap', 'wpm', 'interval', 'activity', 'ergonomics', 'layer']
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

/** `YYYY-MM-DDTHH:mm` serialisation (local timezone) that HTML's
 * `<input type="datetime-local">` expects. */
function toLocalInputValue(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear().toString().padStart(4, '0')
  const m = (d.getMonth() + 1).toString().padStart(2, '0')
  const day = d.getDate().toString().padStart(2, '0')
  const h = d.getHours().toString().padStart(2, '0')
  const mi = d.getMinutes().toString().padStart(2, '0')
  return `${y}-${m}-${day}T${h}:${mi}`
}

function fromLocalInputValue(value: string): number | null {
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}

interface TypingAnalyticsViewProps {
  /** Pre-select this keyboard on mount if it exists in the current
   * analytics data. Used when entering the Analyze page from the
   * typing view — the user has already committed to one keyboard and
   * shouldn't have to re-pick it. */
  initialUid?: string
  /** When provided, the sidebar renders a Back button above the
   * keyboard list that invokes this handler. Omit to hide the button
   * (e.g. when the Analyze view is embedded somewhere without a
   * meaningful "back" destination). */
  onBack?: () => void
}

export function TypingAnalyticsView({ initialUid, onBack }: TypingAnalyticsViewProps = {}) {
  const { t } = useTranslation()
  const [keyboards, setKeyboards] = useState<TypingKeyboardSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedUid, setSelectedUid] = useState<string | null>(initialUid ?? null)
  // Default to Key heatmap — it's the most concrete overview when the
  // snapshot is available. If the selected range has no snapshot, the
  // visible-tabs effect below falls the user back to the next tab.
  const [analysisTab, setAnalysisTab] = useState<AnalysisTabKey>('keyHeatmap')
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
      deviceScope,
      heatmap: heatmapFilter,
      wpm: wpmFilter,
      interval: intervalFilter,
      activity: activityFilter,
      layer: layerFilter,
    },
    ready: filtersReady,
    setDeviceScope,
    setHeatmap,
    setWpm,
    setInterval: setIntervalFilter,
    setActivity,
    setLayer,
  } = useAnalyzeFilters(selectedUid)
  const [keymapSnapshot, setKeymapSnapshot] = useState<TypingKeymapSnapshot | null>(null)
  const [snapshotLoading, setSnapshotLoading] = useState(false)
  const [snapshotSummaries, setSnapshotSummaries] = useState<TypingKeymapSnapshotSummary[]>([])
  const [summariesLoading, setSummariesLoading] = useState(false)
  const [fingerAssignments, setFingerAssignments] = useState<Record<string, FingerType>>({})
  const [fingersLoading, setFingersLoading] = useState(false)
  const [fingerModalOpen, setFingerModalOpen] = useState(false)
  // `loaded` gates the "persisted hash no longer exists" fallback so a
  // slow fetch doesn't clobber a valid selection before the list
  // resolves; `error` lets the loading-phase overlay release after a
  // transient IPC failure instead of stalling on "preparing" forever.
  // The two are distinct because the fallback must not fire on error.
  const [remoteHashes, setRemoteHashes] = useState<{
    list: string[]
    loaded: boolean
    error: boolean
  }>({
    list: [],
    loaded: false,
    error: false,
  })
  // Analytics-only sync runs on Analyze mount (see
  // .claude/rules/settings-persistence.md). The ref tracks per-keyboard
  // last-successful timestamps so switching between keyboards doesn't
  // share a single bucket. `syncingAnalytics` gates the filter row the
  // same way `filtersReady` does.
  const [syncingAnalytics, setSyncingAnalytics] = useState(false)
  const lastAnalyticsSyncSuccessAtRef = useRef<Map<string, number>>(new Map())

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const list = await window.vialAPI.typingAnalyticsListKeyboards()
      setKeyboards(list)
      setSelectedUid((prev) => {
        if (prev && list.some((kb) => kb.uid === prev)) return prev
        if (initialUid && list.some((kb) => kb.uid === initialUid)) return initialUid
        return list[0]?.uid ?? null
      })
    } catch {
      setKeyboards([])
      setSelectedUid(null)
    } finally {
      setLoading(false)
    }
  }, [initialUid])

  useEffect(() => {
    void refresh()
  }, [refresh])

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
    if (!selectedUid) { setSnapshotSummaries([]); setSummariesLoading(false); return }
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
          autoSetRangeForUidRef.current = selectedUid
        }
      })
      .catch(() => { if (!cancelled) setSnapshotSummaries([]) })
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

  // Remote machine hashes (excluding own) power the Device select's
  // per-hash options. Mark `loaded` after the fetch resolves so the
  // fallback below doesn't race the first paint and wipe a valid
  // persisted hash selection.
  useEffect(() => {
    if (!selectedUid) {
      setRemoteHashes({ list: [], loaded: false, error: false })
      return
    }
    let cancelled = false
    setRemoteHashes({ list: [], loaded: false, error: false })
    void window.vialAPI
      .typingAnalyticsListRemoteHashes(selectedUid)
      .then((list) => { if (!cancelled) setRemoteHashes({ list, loaded: true, error: false }) })
      // `loaded: false` on error keeps the "missing from list" fallback
      // from wiping a valid persisted hash selection; `error: true`
      // lets the overlay release instead of stalling on preparing.
      .catch(() => { if (!cancelled) setRemoteHashes({ list: [], loaded: false, error: true }) })
    return () => { cancelled = true }
  }, [selectedUid])

  // Fallback: if the persisted scope points at a machine hash that no
  // longer exists in the remote list, drop back to `'own'`. Only runs
  // after the list has resolved so a slow fetch can't strip a valid
  // selection on first mount.
  useEffect(() => {
    if (!remoteHashes.loaded) return
    if (!isHashScope(deviceScope)) return
    if (!remoteHashes.list.includes(deviceScope.machineHash)) {
      setDeviceScope('own')
    }
  }, [remoteHashes, deviceScope, setDeviceScope])

  // Snapshots are only ever saved for the own machine hash (see
  // service-side comment). Suppress only when the user picks a
  // specific remote hash — `'all'` aggregates the own device in too,
  // so the local keymap is the best-available layout reference.
  // Gating on `isOwnScope` instead would blank the `'all'` Heatmap /
  // Ergonomics / Layer-activations tabs even though the underlying
  // aggregate query returns data.
  const effectiveSnapshot = isHashScope(deviceScope) ? null : keymapSnapshot

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
    remoteHashesLoading: !!selectedUid && !remoteHashes.loaded && !remoteHashes.error,
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
    const last = lastAnalyticsSyncSuccessAtRef.current.get(selectedUid) ?? 0
    if (Date.now() - last < ANALYTICS_SYNC_RATE_LIMIT_MS) return
    let cancelled = false
    setSyncingAnalytics(true)
    void window.vialAPI
      .syncAnalyticsNow(selectedUid)
      .then((ok) => {
        if (cancelled) return
        if (ok) {
          lastAnalyticsSyncSuccessAtRef.current.set(selectedUid, Date.now())
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

  return (
    <div
      className="relative flex h-full min-h-[70vh] gap-4"
      data-testid="analyze-view"
    >
      {currentPhase !== null && (
        <ConnectingOverlay
          // Analytics syncs per keyboard, so the name doubles as
          // "which device is this overlay for" when the user mentally
          // context-switches between keyboards in the sidebar.
          deviceName={selected?.productName ?? selectedUid ?? ''}
          deviceId=""
          syncOnly
          loadingProgress={`analyze.loading.${currentPhase}`}
          syncProgress={currentPhase === 'syncing' ? syncProgress : null}
        />
      )}
      <aside className="flex w-60 shrink-0 flex-col gap-2 border-r border-edge pr-4 min-h-0">
        {onBack && (
          <button
            type="button"
            className="inline-flex items-center gap-1.5 self-start rounded-md border border-edge px-2 py-1 text-[12px] text-content-secondary transition-colors hover:text-content"
            onClick={onBack}
            data-testid="analyze-back"
          >
            <ArrowLeft size={12} aria-hidden="true" />
            {t('analyze.back')}
          </button>
        )}
        <h3 className="px-1 text-[11px] font-semibold uppercase tracking-widest text-content-muted">
          {t('analyze.keyboardList')}
        </h3>
        {loading ? (
          <div className="px-1 py-2 text-[13px] text-content-muted">
            {t('common.loading')}
          </div>
        ) : keyboards.length === 0 ? (
          <div className="px-1 py-2 text-[13px] text-content-muted" data-testid="analyze-no-keyboards">
            {t('analyze.noKeyboards')}
          </div>
        ) : (
          <div className="flex flex-1 min-h-0 flex-col gap-1 overflow-y-auto">
            {keyboards.map((kb) => (
              <button
                key={kb.uid}
                type="button"
                className={`${SIDE_BTN_BASE} ${kb.uid === selectedUid ? SIDE_BTN_ACTIVE : SIDE_BTN_IDLE}`}
                onClick={() => setSelectedUid(kb.uid)}
                data-testid={`analyze-kb-${kb.uid}`}
              >
                <span className="block font-medium">{kb.productName || kb.uid}</span>
              </button>
            ))}
          </div>
        )}
      </aside>
      <section className="flex flex-1 min-h-0 min-w-0 flex-col gap-3">
        {selected ? (
          <>
            <div
              className="flex gap-1 rounded-lg bg-surface-dim p-1"
              data-testid="analyze-tabs"
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
                  data-testid={`analyze-tab-${key}`}
                >
                  {t(`analyze.analysisTab.${key}`)}
                </button>
              ))}
            </div>
            <div
              className={`flex flex-wrap items-center gap-3 border-b border-edge pb-3 ${
                !filtersReady || syncingAnalytics ? 'pointer-events-none opacity-60' : ''
              }`}
              data-testid="analyze-filters"
              aria-busy={!filtersReady || syncingAnalytics}
            >
              <KeymapSnapshotTimeline
                summaries={snapshotSummaries}
                range={range}
                nowMs={nowMs}
                onRangeChange={(next) => setRange((prev) => {
                  const fromMs = Math.min(next.fromMs, next.toMs)
                  const toMs = Math.min(next.toMs, nowMs)
                  // Re-selecting the active option must not invalidate
                  // the range-dependent effects (snapshot fetch, chart
                  // rerenders). Return the previous reference when the
                  // clamp lands on the same window.
                  if (prev.fromMs === fromMs && prev.toMs === toMs) return prev
                  return { fromMs, toMs }
                })}
              />
              <label className={FILTER_LABEL}>
                {t('analyze.filters.from')}
                <input
                  type="datetime-local"
                  className={FILTER_SELECT}
                  value={toLocalInputValue(range.fromMs)}
                  max={toLocalInputValue(Math.min(range.toMs, nowMs))}
                  onChange={(e) => {
                    const ms = fromLocalInputValue(e.target.value)
                    if (ms === null) return
                    setRange((prev) => ({ fromMs: Math.min(ms, prev.toMs), toMs: prev.toMs }))
                  }}
                  data-testid="analyze-filter-from"
                />
              </label>
              <label className={FILTER_LABEL}>
                {t('analyze.filters.to')}
                <input
                  type="datetime-local"
                  className={FILTER_SELECT}
                  value={toLocalInputValue(range.toMs)}
                  max={toLocalInputValue(nowMs)}
                  onChange={(e) => {
                    const ms = fromLocalInputValue(e.target.value)
                    if (ms === null) return
                    setRange((prev) => ({ fromMs: prev.fromMs, toMs: Math.min(Math.max(ms, prev.fromMs), nowMs) }))
                  }}
                  data-testid="analyze-filter-to"
                />
              </label>
              {!(analysisTab === 'interval' && intervalFilter.viewMode === 'distribution') && (
                <label className={FILTER_LABEL}>
                  {t('analyze.filters.device')}
                  <select
                    className={FILTER_SELECT}
                    value={scopeToSelectValue(deviceScope)}
                    onChange={(e) => {
                      const next = scopeFromSelectValue(e.target.value)
                      if (next !== null) setDeviceScope(next)
                    }}
                    data-testid="analyze-filter-device"
                  >
                    {DEVICE_SCOPES.map((key) => (
                      <option key={key} value={key}>
                        {t(`analyze.filters.deviceOption.${key}`)}
                      </option>
                    ))}
                    {remoteHashes.list.map((hash) => (
                      <option
                        key={hash}
                        value={scopeToSelectValue({ kind: 'hash', machineHash: hash })}
                        title={hash}
                      >
                        {t('analyze.filters.deviceOption.hashShort', { hash: hash.slice(0, 8) })}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {analysisTab === 'wpm' && (
                <>
                  <label className={FILTER_LABEL}>
                    {t('analyze.filters.wpmViewMode')}
                    <select
                      className={FILTER_SELECT}
                      value={wpmFilter.viewMode}
                      onChange={(e) => setWpm({ viewMode: e.target.value as WpmViewMode })}
                      data-testid="analyze-filter-wpm-view-mode"
                    >
                      {WPM_VIEW_MODES.map((key) => (
                        <option key={key} value={key}>
                          {t(`analyze.filters.wpmViewModeOption.${key}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={FILTER_LABEL}>
                    {t('analyze.filters.wpmMinSample')}
                    <select
                      className={FILTER_SELECT}
                      value={String(wpmFilter.minActiveMs)}
                      onChange={(e) => setWpm({ minActiveMs: Number.parseInt(e.target.value, 10) })}
                      data-testid="analyze-filter-wpm-min-sample"
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
              {analysisTab === 'activity' && (
                <>
                  <label className={FILTER_LABEL}>
                    {t('analyze.filters.activityMetric')}
                    <select
                      className={FILTER_SELECT}
                      value={activityFilter.metric}
                      onChange={(e) => setActivity({ metric: e.target.value as ActivityMetric })}
                      data-testid="analyze-filter-activity-metric"
                    >
                      {ACTIVITY_METRICS.map((key) => (
                        <option key={key} value={key}>
                          {t(`analyze.filters.activityMetricOption.${key}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {activityFilter.metric === 'wpm' && (
                    <label className={FILTER_LABEL}>
                      {t('analyze.filters.wpmMinSample')}
                      <select
                        className={FILTER_SELECT}
                        value={String(wpmFilter.minActiveMs)}
                        onChange={(e) => setWpm({ minActiveMs: Number.parseInt(e.target.value, 10) })}
                        data-testid="analyze-filter-activity-min-sample"
                      >
                        {WPM_MIN_SAMPLE_OPTIONS.map((opt) => (
                          <option key={opt.labelKey} value={String(opt.value)}>
                            {t(`analyze.filters.wpmMinSampleOption.${opt.labelKey}`)}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </>
              )}
              {analysisTab === 'interval' && (
                <>
                  <label className={FILTER_LABEL}>
                    {t('analyze.filters.intervalViewMode')}
                    <select
                      className={FILTER_SELECT}
                      value={intervalFilter.viewMode}
                      onChange={(e) => setIntervalFilter({ viewMode: e.target.value as IntervalViewMode })}
                      data-testid="analyze-filter-interval-view-mode"
                    >
                      {INTERVAL_VIEW_MODES.map((key) => (
                        <option key={key} value={key}>
                          {t(`analyze.filters.intervalViewModeOption.${key}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={FILTER_LABEL}>
                    {t('analyze.filters.unit')}
                    <select
                      className={FILTER_SELECT}
                      value={intervalFilter.unit}
                      onChange={(e) => setIntervalFilter({ unit: e.target.value as IntervalUnit })}
                      data-testid="analyze-filter-unit"
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
              {((analysisTab === 'wpm' && wpmFilter.viewMode === 'timeSeries') || (analysisTab === 'interval' && intervalFilter.viewMode === 'timeSeries')) && (
                <label className={FILTER_LABEL}>
                  {t('analyze.filters.granularity')}
                  <select
                    className={FILTER_SELECT}
                    value={typeof wpmFilter.granularity === 'number' ? String(wpmFilter.granularity) : 'auto'}
                    onChange={(e) => {
                      const v = e.target.value
                      setWpm({ granularity: v === 'auto' ? 'auto' : Number.parseInt(v, 10) })
                    }}
                    data-testid="analyze-filter-granularity"
                  >
                    {GRANULARITY_OPTIONS.map((opt) => (
                      <option key={opt.labelKey} value={typeof opt.value === 'number' ? String(opt.value) : 'auto'}>
                        {t(`analyze.filters.granularityOption.${opt.labelKey}`)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {analysisTab === 'ergonomics' && (
                <button
                  type="button"
                  className="ml-auto rounded-md border border-edge bg-surface px-3 py-1 text-[12px] text-content-secondary transition-colors hover:border-accent hover:text-content disabled:opacity-50 disabled:hover:border-edge disabled:hover:text-content-secondary"
                  onClick={() => setFingerModalOpen(true)}
                  disabled={effectiveSnapshot === null}
                  data-testid="analyze-finger-assignment-open"
                >
                  {t('analyze.fingerAssignment.button')}
                </button>
              )}
              {analysisTab === 'layer' && (
                <>
                  <label className={FILTER_LABEL}>
                    {t('analyze.filters.layerViewMode')}
                    <select
                      className={FILTER_SELECT}
                      value={layerFilter.viewMode}
                      onChange={(e) => setLayer({ viewMode: e.target.value as LayerViewMode })}
                      data-testid="analyze-filter-layer-view-mode"
                    >
                      {LAYER_VIEW_MODES.map((key) => (
                        <option key={key} value={key}>
                          {t(`analyze.filters.layerViewModeOption.${key}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {layerFilter.viewMode === 'activations' && effectiveSnapshot !== null && effectiveSnapshot.layers > 1 && (
                    <label className={FILTER_LABEL}>
                      {t('analyze.filters.layerBaseLayer')}
                      <select
                        className={FILTER_SELECT}
                        value={layerFilter.baseLayer}
                        onChange={(e) => setLayer({ baseLayer: Number(e.target.value) })}
                        data-testid="analyze-filter-layer-base-layer"
                      >
                        {Array.from({ length: effectiveSnapshot.layers }, (_, i) => (
                          <option key={i} value={i}>
                            {t('analyze.layer.layerLabel', { layer: i })}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </>
              )}
            </div>
            <div className="flex-1 min-h-0 py-2 overflow-x-clip [&_*]:focus:outline-none [&_*]:focus-visible:outline-none" data-testid="analyze-chart">
              {analysisTab === 'wpm' ? (
                <WpmChart
                  uid={selected.uid}
                  range={range}
                  deviceScope={deviceScope}
                  granularity={wpmFilter.granularity}
                  viewMode={wpmFilter.viewMode}
                  minActiveMs={wpmFilter.minActiveMs}
                />
              ) : analysisTab === 'interval' ? (
                <IntervalChart
                  uid={selected.uid}
                  range={range}
                  deviceScope={deviceScope}
                  unit={intervalFilter.unit}
                  granularity={wpmFilter.granularity}
                  viewMode={intervalFilter.viewMode}
                />
              ) : analysisTab === 'activity' ? (
                <ActivityChart
                  uid={selected.uid}
                  range={range}
                  deviceScope={deviceScope}
                  metric={activityFilter.metric}
                  minActiveMs={wpmFilter.minActiveMs}
                />
              ) : analysisTab === 'keyHeatmap' ? (
                effectiveSnapshot !== null ? (
                  <KeyHeatmapChart
                    uid={selected.uid}
                    range={range}
                    deviceScope={deviceScope}
                    snapshot={effectiveSnapshot}
                    heatmap={heatmapFilter}
                    onHeatmapChange={setHeatmap}
                  />
                ) : (
                  <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-keyheatmap-empty">
                    {t('analyze.keyHeatmap.noSnapshot')}
                  </div>
                )
              ) : analysisTab === 'ergonomics' ? (
                effectiveSnapshot !== null ? (
                  <ErgonomicsChart uid={selected.uid} range={range} deviceScope={deviceScope} snapshot={effectiveSnapshot} fingerOverrides={fingerAssignments} />
                ) : (
                  <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-ergonomics-no-snapshot">
                    {t('analyze.ergonomics.noSnapshot')}
                  </div>
                )
              ) : analysisTab === 'layer' ? (
                <LayerUsageChart
                  uid={selected.uid}
                  range={range}
                  deviceScope={deviceScope}
                  snapshot={effectiveSnapshot}
                  viewMode={layerFilter.viewMode}
                  baseLayer={layerFilter.baseLayer}
                />
              ) : null}
            </div>
          </>
        ) : (
          <div className="py-6 text-center text-sm text-content-muted">
            {t('analyze.selectKeyboard')}
          </div>
        )}
      </section>
      <FingerAssignmentModal
        isOpen={fingerModalOpen}
        onClose={() => setFingerModalOpen(false)}
        snapshot={effectiveSnapshot}
        assignments={fingerAssignments}
        onSave={handleFingerAssignmentsSave}
      />
    </div>
  )
}
