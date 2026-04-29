// SPDX-License-Identifier: GPL-2.0-or-later
// Per-keyboard Analyze filter state. Centralises the fan-out of "read
// on mount, debounce on change, flush on uid switch / unmount" so the
// chart components only see a plain state object + narrow updater
// functions. `range` stays out of the persisted shape on purpose — the
// default 7-day window re-arms each session via renderer-local state.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PipetteSettings } from '../../shared/types/pipette-settings'
import { DEFAULT_PIPETTE_SETTINGS } from '../../shared/types/pipette-settings'
import {
  appScopesEqual,
  deviceScopesEqual,
  normalizeAppScopes,
  normalizeDeviceScopes,
  type ActivityCalendarFilters,
  type ActivityFilters,
  type AnalyzeFilterSettings,
  type BigramFilters,
  type DeviceScope,
  type ErgonomicsFilters,
  type HeatmapFilters,
  type IntervalFilters,
  type LayerFilters,
  type LayoutComparisonFilters,
  type WpmFilters,
} from '../../shared/types/analyze-filters'
import { toLocalMonth } from '../components/analyze/analyze-streak-goal'
import { DEFAULT_LEARNING_MIN_SAMPLE } from '../components/analyze/analyze-ergonomics-curve'

const DEBOUNCE_MS = 300

export interface AnalyzeFiltersState {
  /** Single-select Device filter — held as an array so the persisted
   * filter shape and `normalizeDeviceScopes` invariants stay stable.
   * Always pre-normalized: dedupe + `'all'` exclusivity + length cap
   * (`MAX_DEVICE_SCOPES = 1`) are handled inside the setter so
   * consumers can rely on the canonical shape without re-running the
   * normalizer themselves. */
  deviceScopes: DeviceScope[]
  /** Per-app filter restricting all charts to minutes tagged with
   * one of these application names. Empty array = "no app filter"
   * (every minute, including mixed/unknown). The dropdown's option
   * list is fetched from the analyze range; stale persisted names
   * are silently dropped on next load via `normalizeAppScopes`. */
  appScopes: string[]
  heatmap: Required<HeatmapFilters>
  wpm: Required<WpmFilters>
  interval: Required<IntervalFilters>
  // Activity carries a nested `calendar` object — `Required<ActivityFilters>`
  // alone would only force the outer fields, leaving every calendar field
  // optional. Make the calendar shape explicitly required so consumers
  // can read `state.activity.calendar.valueMetric` without a guard.
  activity: Required<Omit<ActivityFilters, 'calendar'>> & { calendar: Required<ActivityCalendarFilters> }
  layer: Required<LayerFilters>
  ergonomics: Required<ErgonomicsFilters>
  bigrams: Required<BigramFilters>
  layoutComparison: Required<LayoutComparisonFilters>
}

export const DEFAULT_ANALYZE_FILTERS: AnalyzeFiltersState = {
  deviceScopes: ['own'],
  appScopes: [],
  heatmap: {
    selectedLayers: [0],
    groups: [[0]],
    frequentUsedN: 10,
    aggregateMode: 'cell',
    normalization: 'absolute',
    keyGroupFilter: 'all',
  },
  wpm: {
    viewMode: 'timeSeries',
    minActiveMs: 60_000,
    granularity: 'auto',
  },
  interval: {
    unit: 'sec',
    viewMode: 'timeSeries',
  },
  activity: {
    metric: 'keystrokes',
    view: 'grid',
    // `endMonthIso` snapshots the current local wall-clock month at
    // module load. A static default would freeze the calendar's window
    // at "the month this build shipped"; restoreFilters re-applies this
    // default on every load so the seed stays current across launches.
    calendar: {
      normalization: 'absolute',
      monthsToShow: 6,
      endMonthIso: toLocalMonth(Date.now()),
    },
  },
  layer: {
    viewMode: 'keystrokes',
    baseLayer: 0,
  },
  ergonomics: {
    viewMode: 'snapshot',
    period: 'week',
    minSampleKeystrokes: DEFAULT_LEARNING_MIN_SAMPLE,
  },
  bigrams: {
    topLimit: 10,
    slowLimit: 10,
    fingerLimit: 20,
    pairIntervalThresholdMs: 0,
  },
  layoutComparison: {
    sourceLayoutId: 'qwerty',
    targetLayoutId: null,
  },
}

function restoreFilters(saved: AnalyzeFilterSettings | undefined): AnalyzeFiltersState {
  if (!saved) return DEFAULT_ANALYZE_FILTERS
  // Re-run the normalizer on every load — settings written by an older
  // build (or hand-edited) might still have stale `'all'` + sibling
  // combinations or stray duplicates. Funnel everything through the
  // single canonical shape so chart consumers never see invalid input.
  return {
    deviceScopes: normalizeDeviceScopes(saved.deviceScopes),
    appScopes: normalizeAppScopes(saved.appScopes),
    heatmap: { ...DEFAULT_ANALYZE_FILTERS.heatmap, ...saved.heatmap },
    wpm: { ...DEFAULT_ANALYZE_FILTERS.wpm, ...saved.wpm },
    interval: { ...DEFAULT_ANALYZE_FILTERS.interval, ...saved.interval },
    // Activity is the only filter shape with a nested object (`calendar`),
    // so the shallow `{ ...DEFAULT, ...saved }` would drop calendar defaults
    // whenever the user only persisted a subset of the calendar fields.
    // Pick known calendar fields explicitly (instead of spreading) so any
    // legacy keys from older builds (e.g. `selectedYear`) get dropped at
    // load time and don't leak into subsequent writes.
    activity: {
      ...DEFAULT_ANALYZE_FILTERS.activity,
      ...saved.activity,
      calendar: {
        normalization: saved.activity?.calendar?.normalization ?? DEFAULT_ANALYZE_FILTERS.activity.calendar.normalization,
        monthsToShow: saved.activity?.calendar?.monthsToShow ?? DEFAULT_ANALYZE_FILTERS.activity.calendar.monthsToShow,
        endMonthIso: saved.activity?.calendar?.endMonthIso ?? DEFAULT_ANALYZE_FILTERS.activity.calendar.endMonthIso,
      },
    },
    layer: { ...DEFAULT_ANALYZE_FILTERS.layer, ...saved.layer },
    ergonomics: { ...DEFAULT_ANALYZE_FILTERS.ergonomics, ...saved.ergonomics },
    bigrams: { ...DEFAULT_ANALYZE_FILTERS.bigrams, ...saved.bigrams },
    layoutComparison: { ...DEFAULT_ANALYZE_FILTERS.layoutComparison, ...saved.layoutComparison },
  }
}

function serializeFilters(state: AnalyzeFiltersState): AnalyzeFilterSettings {
  return {
    deviceScopes: state.deviceScopes,
    appScopes: state.appScopes,
    heatmap: state.heatmap,
    wpm: state.wpm,
    interval: state.interval,
    activity: state.activity,
    layer: state.layer,
    ergonomics: state.ergonomics,
    bigrams: state.bigrams,
    layoutComparison: state.layoutComparison,
  }
}

export interface UseAnalyzeFiltersReturn {
  filters: AnalyzeFiltersState
  ready: boolean
  setDeviceScopes: (v: readonly DeviceScope[]) => void
  setAppScopes: (v: string[]) => void
  setHeatmap: (patch: Partial<HeatmapFilters>) => void
  setWpm: (patch: Partial<WpmFilters>) => void
  setInterval: (patch: Partial<IntervalFilters>) => void
  setActivity: (patch: Partial<ActivityFilters>) => void
  setLayer: (patch: Partial<LayerFilters>) => void
  setErgonomics: (patch: Partial<ErgonomicsFilters>) => void
  setBigrams: (patch: Partial<BigramFilters>) => void
  setLayoutComparison: (patch: Partial<LayoutComparisonFilters>) => void
}

/** Drive the Analyze filter state for a single keyboard uid.
 *
 * Persistence contract:
 * - `uid === null`: stay on defaults, skip all IPC.
 * - uid switch: flush the previous keyboard's pending write (if any)
 *   synchronously, then re-load the next keyboard.
 * - unmount: flush any still-pending write before teardown.
 * - `window.vialAPI.pipetteSettingsGet` returning `null` (no prior
 *   file) is treated as defaults — the first subsequent edit writes
 *   a fresh `PipetteSettings` with the minimum required fields.
 */
export type AnalyzePaneKey = 'A' | 'B'

/** Which `PipetteSettings.analyze.*` field a pane reads / writes. Pane
 * A uses the historical `filters` slot; pane B carries an independent
 * `compareFilters` so the two panes can diverge even when they share
 * the same uid (e.g. range-comparison view). */
function fieldForPane(paneKey: AnalyzePaneKey): 'filters' | 'compareFilters' {
  return paneKey === 'B' ? 'compareFilters' : 'filters'
}

export function useAnalyzeFilters(
  uid: string | null,
  paneKey: AnalyzePaneKey = 'A',
): UseAnalyzeFiltersReturn {
  const [filters, setFilters] = useState<AnalyzeFiltersState>(DEFAULT_ANALYZE_FILTERS)
  const [ready, setReady] = useState<boolean>(uid === null)

  const uidRef = useRef<string | null>(uid)
  const applySeqRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingUidRef = useRef<string | null>(null)
  const pendingFiltersRef = useRef<AnalyzeFiltersState | null>(null)
  const field = fieldForPane(paneKey)

  const flushPending = useCallback(() => {
    const pendingUid = pendingUidRef.current
    const pendingFilters = pendingFiltersRef.current
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    pendingUidRef.current = null
    pendingFiltersRef.current = null
    if (!pendingUid || !pendingFilters) return
    void (async () => {
      try {
        const prefs = await window.vialAPI.pipetteSettingsGet(pendingUid)
        const base: PipetteSettings = prefs ?? DEFAULT_PIPETTE_SETTINGS
        const nextAnalyze = { ...base.analyze, [field]: serializeFilters(pendingFilters) }
        await window.vialAPI.pipetteSettingsSet(pendingUid, { ...base, analyze: nextAnalyze })
      } catch {
        // best-effort save — a failed write just drops the change
      }
    })()
  }, [field])

  // Load on uid change (and flush the previous uid's pending write).
  useEffect(() => {
    const prevUid = uidRef.current
    if (prevUid && prevUid !== uid) {
      flushPending()
    }
    uidRef.current = uid

    if (uid === null) {
      setFilters(DEFAULT_ANALYZE_FILTERS)
      setReady(true)
      return
    }

    const seq = ++applySeqRef.current
    setReady(false)
    void window.vialAPI
      .pipetteSettingsGet(uid)
      .then((prefs) => {
        if (applySeqRef.current !== seq) return
        setFilters(restoreFilters(prefs?.analyze?.[field]))
        setReady(true)
      })
      .catch(() => {
        if (applySeqRef.current !== seq) return
        setFilters(DEFAULT_ANALYZE_FILTERS)
        setReady(true)
      })
  }, [uid, flushPending, field])

  // Flush once more on unmount for the final in-flight edit.
  useEffect(() => {
    return () => {
      flushPending()
    }
  }, [flushPending])

  const scheduleSave = useCallback((next: AnalyzeFiltersState) => {
    const currentUid = uidRef.current
    if (!currentUid) return
    pendingUidRef.current = currentUid
    pendingFiltersRef.current = next
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      flushPending()
    }, DEBOUNCE_MS)
  }, [flushPending])

  const update = useCallback((updater: (prev: AnalyzeFiltersState) => AnalyzeFiltersState) => {
    setFilters((prev) => {
      const next = updater(prev)
      // No-op identity short-circuit: a setter that returns `prev`
      // means "nothing changed" — skip both the re-render and the
      // debounce timer so re-clicking an already-set option doesn't
      // burn an IPC write on the 300 ms tick.
      if (next === prev) return prev
      scheduleSave(next)
      return next
    })
  }, [scheduleSave])

  const setDeviceScopes = useCallback((v: readonly DeviceScope[]) => {
    // Normalize at the setter so UI events that produce a stale tuple
    // (e.g. clicking a third checkbox before the disabled state lands)
    // can't smuggle a malformed array into state or persistence. UI
    // disables the entry path and validator rejects on read-back; this
    // is the third leg of the three-layer enforcement.
    const next = normalizeDeviceScopes(v)
    update((prev) => {
      // Skip the state update when the normalized result is identical
      // to the previous tuple — a re-click of an already-selected
      // option would otherwise schedule a no-op write through the
      // 300 ms debounce and re-render every chart.
      if (deviceScopesEqual(prev.deviceScopes, next)) return prev
      return { ...prev, deviceScopes: next }
    })
  }, [update])

  const setAppScopes = useCallback((v: string[]) => {
    const next = normalizeAppScopes(v)
    update((prev) => (appScopesEqual(prev.appScopes, next) ? prev : { ...prev, appScopes: next }))
  }, [update])

  const setHeatmap = useCallback((patch: Partial<HeatmapFilters>) => {
    update((prev) => ({ ...prev, heatmap: { ...prev.heatmap, ...patch } }))
  }, [update])

  const setWpm = useCallback((patch: Partial<WpmFilters>) => {
    update((prev) => ({ ...prev, wpm: { ...prev.wpm, ...patch } }))
  }, [update])

  const setInterval = useCallback((patch: Partial<IntervalFilters>) => {
    update((prev) => ({ ...prev, interval: { ...prev.interval, ...patch } }))
  }, [update])

  const setActivity = useCallback((patch: Partial<ActivityFilters>) => {
    update((prev) => {
      // Deep-merge `calendar` so a partial calendar patch ({ valueMetric })
      // doesn't wipe the other calendar fields. The other ActivityFilters
      // fields stay shallow because they're flat primitives.
      const calendar = patch.calendar !== undefined
        ? { ...prev.activity.calendar, ...patch.calendar }
        : prev.activity.calendar
      return { ...prev, activity: { ...prev.activity, ...patch, calendar } }
    })
  }, [update])

  const setLayer = useCallback((patch: Partial<LayerFilters>) => {
    update((prev) => ({ ...prev, layer: { ...prev.layer, ...patch } }))
  }, [update])

  const setErgonomics = useCallback((patch: Partial<ErgonomicsFilters>) => {
    update((prev) => ({ ...prev, ergonomics: { ...prev.ergonomics, ...patch } }))
  }, [update])

  const setBigrams = useCallback((patch: Partial<BigramFilters>) => {
    update((prev) => ({ ...prev, bigrams: { ...prev.bigrams, ...patch } }))
  }, [update])

  const setLayoutComparison = useCallback((patch: Partial<LayoutComparisonFilters>) => {
    update((prev) => ({ ...prev, layoutComparison: { ...prev.layoutComparison, ...patch } }))
  }, [update])

  return {
    filters,
    ready,
    setDeviceScopes,
    setAppScopes,
    setHeatmap,
    setWpm,
    setInterval,
    setActivity,
    setLayer,
    setErgonomics,
    setBigrams,
    setLayoutComparison,
  }
}
