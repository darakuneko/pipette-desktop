// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze tab content — per-keyboard typing analytics dashboard.
// C2 added the keyboard list; C3 adds the right pane header with the
// analysis tab switcher (WPM / Interval / Heatmap) and the period /
// device-scope filters. The chart bodies are stubbed here and filled
// in by C4–C6.

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TypingKeyboardSummary, TypingKeymapSnapshot } from '../../../shared/types/typing-analytics'
import type { ActivityMetric, AnalysisTabKey, DeviceScope, GranularityChoice, HeatmapNormalization, IntervalUnit, IntervalViewMode, RangeMs, WpmErrorProxy, WpmViewMode } from './analyze-types'
import { ActivityChart } from './ActivityChart'
import { IntervalChart } from './IntervalChart'
import { KeyHeatmapChart } from './KeyHeatmapChart'
import { WpmChart } from './WpmChart'

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

const FILTER_LABEL = 'flex items-center gap-1.5 text-[12px] text-content-muted'
const FILTER_SELECT =
  'rounded-md border border-edge bg-surface px-2 py-1 text-[12px] text-content focus:border-accent focus:outline-none'

const ANALYSIS_TABS: AnalysisTabKey[] = ['keyHeatmap', 'wpm', 'interval', 'activity']
const DEVICE_SCOPES: DeviceScope[] = ['own', 'all']
const INTERVAL_UNITS: IntervalUnit[] = ['sec', 'ms']
const INTERVAL_VIEW_MODES: IntervalViewMode[] = ['timeSeries', 'distribution']
const WPM_VIEW_MODES: WpmViewMode[] = ['timeSeries', 'timeOfDay']
const WPM_ERROR_PROXY_MODES: WpmErrorProxy[] = ['on', 'off']
const ACTIVITY_METRICS: ActivityMetric[] = ['keystrokes', 'wpm', 'sessions']
const HEATMAP_NORMALIZATIONS: HeatmapNormalization[] = ['absolute', 'perHour', 'shareOfTotal']
const DAY_MS = 86_400_000

const WPM_MIN_SAMPLE_OPTIONS: Array<{ value: number; labelKey: string }> = [
  { value: 30_000, labelKey: 'sec30' },
  { value: 60_000, labelKey: 'min1' },
  { value: 60_000 * 2, labelKey: 'min2' },
  { value: 60_000 * 5, labelKey: 'min5' },
]
// Default to the `1 min` entry so the dropdown and state never drift
// apart when the option list is reordered.
const DEFAULT_WPM_MIN_ACTIVE_MS = WPM_MIN_SAMPLE_OPTIONS.find((o) => o.labelKey === 'min1')?.value ?? 60_000

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
}

export function TypingAnalyticsView({ initialUid }: TypingAnalyticsViewProps = {}) {
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
  const [range, setRange] = useState<RangeMs>(() => ({
    fromMs: Date.now() - DAY_MS,
    toMs: Date.now(),
  }))
  const [deviceScope, setDeviceScope] = useState<DeviceScope>('own')
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>('sec')
  const [intervalViewMode, setIntervalViewMode] = useState<IntervalViewMode>('timeSeries')
  const [wpmViewMode, setWpmViewMode] = useState<WpmViewMode>('timeSeries')
  const [wpmMinActiveMs, setWpmMinActiveMs] = useState<number>(DEFAULT_WPM_MIN_ACTIVE_MS)
  const [wpmErrorProxy, setWpmErrorProxy] = useState<WpmErrorProxy>('on')
  const [activityMetric, setActivityMetric] = useState<ActivityMetric>('keystrokes')
  const [granularity, setGranularity] = useState<GranularityChoice>('auto')
  const [heatmapNormalization, setHeatmapNormalization] = useState<HeatmapNormalization>('absolute')
  const [keymapSnapshot, setKeymapSnapshot] = useState<TypingKeymapSnapshot | null>(null)

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
    if (!selectedUid) { setKeymapSnapshot(null); return }
    let cancelled = false
    void window.vialAPI
      .typingAnalyticsGetKeymapSnapshotForRange(selectedUid, range.fromMs, range.toMs)
      .then((s) => { if (!cancelled) setKeymapSnapshot(s) })
      .catch(() => { if (!cancelled) setKeymapSnapshot(null) })
    return () => { cancelled = true }
  }, [selectedUid, range])

  const selected = selectedUid
    ? keyboards.find((kb) => kb.uid === selectedUid) ?? null
    : null

  return (
    <div
      className="flex h-full min-h-[70vh] gap-4"
      data-testid="analyze-view"
    >
      <aside className="flex w-60 shrink-0 flex-col gap-2 border-r border-edge pr-4 min-h-0">
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
              className="flex flex-wrap items-center gap-3 border-b border-edge pb-3"
              data-testid="analyze-filters"
            >
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
              {!(analysisTab === 'interval' && intervalViewMode === 'distribution') && (
                <label className={FILTER_LABEL}>
                  {t('analyze.filters.device')}
                  <select
                    className={FILTER_SELECT}
                    value={deviceScope}
                    onChange={(e) => setDeviceScope(e.target.value as DeviceScope)}
                    data-testid="analyze-filter-device"
                  >
                    {DEVICE_SCOPES.map((key) => (
                      <option key={key} value={key}>
                        {t(`analyze.filters.deviceOption.${key}`)}
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
                      value={wpmViewMode}
                      onChange={(e) => setWpmViewMode(e.target.value as WpmViewMode)}
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
                      value={String(wpmMinActiveMs)}
                      onChange={(e) => setWpmMinActiveMs(Number.parseInt(e.target.value, 10))}
                      data-testid="analyze-filter-wpm-min-sample"
                    >
                      {WPM_MIN_SAMPLE_OPTIONS.map((opt) => (
                        <option key={opt.labelKey} value={String(opt.value)}>
                          {t(`analyze.filters.wpmMinSampleOption.${opt.labelKey}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {wpmViewMode === 'timeSeries' && (
                    <label className={FILTER_LABEL}>
                      {t('analyze.filters.wpmErrorProxy')}
                      <select
                        className={FILTER_SELECT}
                        value={wpmErrorProxy}
                        onChange={(e) => setWpmErrorProxy(e.target.value as WpmErrorProxy)}
                        data-testid="analyze-filter-wpm-error-proxy"
                      >
                        {WPM_ERROR_PROXY_MODES.map((key) => (
                          <option key={key} value={key}>
                            {t(`analyze.filters.wpmErrorProxyOption.${key}`)}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </>
              )}
              {analysisTab === 'activity' && (
                <>
                  <label className={FILTER_LABEL}>
                    {t('analyze.filters.activityMetric')}
                    <select
                      className={FILTER_SELECT}
                      value={activityMetric}
                      onChange={(e) => setActivityMetric(e.target.value as ActivityMetric)}
                      data-testid="analyze-filter-activity-metric"
                    >
                      {ACTIVITY_METRICS.map((key) => (
                        <option key={key} value={key}>
                          {t(`analyze.filters.activityMetricOption.${key}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {activityMetric === 'wpm' && (
                    <label className={FILTER_LABEL}>
                      {t('analyze.filters.wpmMinSample')}
                      <select
                        className={FILTER_SELECT}
                        value={String(wpmMinActiveMs)}
                        onChange={(e) => setWpmMinActiveMs(Number.parseInt(e.target.value, 10))}
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
                      value={intervalViewMode}
                      onChange={(e) => setIntervalViewMode(e.target.value as IntervalViewMode)}
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
                      value={intervalUnit}
                      onChange={(e) => setIntervalUnit(e.target.value as IntervalUnit)}
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
              {((analysisTab === 'wpm' && wpmViewMode === 'timeSeries') || (analysisTab === 'interval' && intervalViewMode === 'timeSeries')) && (
                <label className={FILTER_LABEL}>
                  {t('analyze.filters.granularity')}
                  <select
                    className={FILTER_SELECT}
                    value={typeof granularity === 'number' ? String(granularity) : 'auto'}
                    onChange={(e) => {
                      const v = e.target.value
                      setGranularity(v === 'auto' ? 'auto' : Number.parseInt(v, 10))
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
              {analysisTab === 'keyHeatmap' && (
                <label className={FILTER_LABEL}>
                  {t('analyze.filters.normalization')}
                  <select
                    className={FILTER_SELECT}
                    value={heatmapNormalization}
                    onChange={(e) => setHeatmapNormalization(e.target.value as HeatmapNormalization)}
                    data-testid="analyze-filter-normalization"
                  >
                    {HEATMAP_NORMALIZATIONS.map((key) => (
                      <option key={key} value={key}>
                        {t(`analyze.filters.normalizationOption.${key}`)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <div className="flex-1 min-h-0 py-2 [&_*]:focus:outline-none [&_*]:focus-visible:outline-none" data-testid="analyze-chart">
              {analysisTab === 'wpm' ? (
                <WpmChart
                  uid={selected.uid}
                  range={range}
                  deviceScope={deviceScope}
                  granularity={granularity}
                  viewMode={wpmViewMode}
                  minActiveMs={wpmMinActiveMs}
                  errorProxy={wpmErrorProxy}
                />
              ) : analysisTab === 'interval' ? (
                <IntervalChart uid={selected.uid} range={range} deviceScope={deviceScope} unit={intervalUnit} granularity={granularity} viewMode={intervalViewMode} />
              ) : analysisTab === 'activity' ? (
                <ActivityChart
                  uid={selected.uid}
                  range={range}
                  deviceScope={deviceScope}
                  metric={activityMetric}
                  minActiveMs={wpmMinActiveMs}
                />
              ) : analysisTab === 'keyHeatmap' ? (
                keymapSnapshot !== null ? (
                  <KeyHeatmapChart uid={selected.uid} range={range} deviceScope={deviceScope} snapshot={keymapSnapshot} normalization={heatmapNormalization} />
                ) : (
                  <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-keyheatmap-empty">
                    {t('analyze.keyHeatmap.noSnapshot')}
                  </div>
                )
              ) : null}
            </div>
          </>
        ) : (
          <div className="py-6 text-center text-sm text-content-muted">
            {t('analyze.selectKeyboard')}
          </div>
        )}
      </section>
    </div>
  )
}
