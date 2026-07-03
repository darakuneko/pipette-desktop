// SPDX-License-Identifier: GPL-2.0-or-later
// Per-keyboard Analyze filter state. Centralises the fan-out of "read
// on mount, debounce on change, flush on uid switch / unmount" so the
// chart components only see a plain state object + narrow updater
// functions. `range` stays out of the persisted shape on purpose — the
// default 7-day window re-arms each session via renderer-local state.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  appScopesEqual,
  deviceScopesEqual,
  normalizeAppScopes,
  normalizeDeviceScopes,
  parseFilterDimension,
  type ActivityCalendarFilters,
  type ActivityFilters,
  type AnalyzeFilterSettings,
  type BigramFilters,
  type DeviceScope,
  type FilterDimension,
  type ErgonomicsFilters,
  type HeatmapFilters,
  type IntervalFilters,
  type LayerFilters,
  type LayoutComparisonFilters,
  type WpmFilters,
} from '../../shared/types/analyze-filters'
import type { AnalysisTabKey } from '../components/analyze/analyze-types'
import { toLocalMonth } from '../components/analyze/analyze-streak-goal'
import { DEFAULT_LEARNING_MIN_SAMPLE } from '../components/analyze/analyze-ergonomics-curve'

const DEBOUNCE_MS = 300

/** Stable empty scope array so the zeroed (inactive) dimension keeps a
 * constant reference across renders — chart effect deps compare by
 * identity and would otherwise re-fire every render. */
const EMPTY_SCOPES: string[] = []

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
  /** Selected typing-test labels (custom = text name, normal =
   * `mode (language)`). Empty = no filter. Same semantics as appScopes. */
  typingTestScopes: string[]
  /** Selected run ids — second-level filter under `typingTestScopes`.
   * Only applies while the typingTest dimension is active; zeroed in the
   * effective filters otherwise. Empty = no run filter. */
  runIdScopes: string[]
  /** Which of `appScopes` / `typingTestScopes` is active. The inactive
   * one is preserved here but zeroed in the effective filters the hook
   * returns, so toggling back restores the prior selection. */
  filterDimension: FilterDimension
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
  typingTestScopes: [],
  runIdScopes: [],
  filterDimension: 'app',
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
    typingTestScopes: normalizeAppScopes(saved.typingTestScopes),
    runIdScopes: normalizeAppScopes(saved.runIdScopes),
    filterDimension: parseFilterDimension(saved.filterDimension),
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

/** Partial patch consumed by `applyBatch` / `applyBatchForUid`. Deliberately
 * a shallow `Partial<AnalyzeFiltersState>` (not deep-partial) — the nested
 * per-tab filter shapes (`heatmap`, `wpm`, ...) are replaced wholesale when
 * present, matching how the existing per-tab setters already require a full
 * `Required<...>` shape internally. The staged filter modal only ever
 * patches the flat scope/dimension fields (`deviceScopes`, `filterDimension`,
 * `appScopes`, `typingTestScopes`, `runIdScopes`), so the nested shapes are
 * expected to stay absent from real callers. */
export type AnalyzeFiltersBatchPatch = Partial<AnalyzeFiltersState>

/** Run the same normalizers the individual setters apply, but only for the
 * scope-shaped fields present in `patch`. Keeps `applyBatch` /
 * `applyBatchForUid` from smuggling a malformed scope array into state or
 * persistence — the single source of truth for "what counts as a valid
 * scope tuple" stays the shared normalizer functions. */
function normalizeBatchPatch(patch: AnalyzeFiltersBatchPatch): AnalyzeFiltersBatchPatch {
  const next: AnalyzeFiltersBatchPatch = { ...patch }
  if (patch.deviceScopes !== undefined) next.deviceScopes = normalizeDeviceScopes(patch.deviceScopes)
  if (patch.appScopes !== undefined) next.appScopes = normalizeAppScopes(patch.appScopes)
  if (patch.typingTestScopes !== undefined) next.typingTestScopes = normalizeAppScopes(patch.typingTestScopes)
  if (patch.runIdScopes !== undefined) next.runIdScopes = normalizeAppScopes(patch.runIdScopes)
  return next
}

function serializeFilters(state: AnalyzeFiltersState): AnalyzeFilterSettings {
  return {
    deviceScopes: state.deviceScopes,
    appScopes: state.appScopes,
    typingTestScopes: state.typingTestScopes,
    runIdScopes: state.runIdScopes,
    filterDimension: state.filterDimension,
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
  /** Effective filters: the inactive dimension's scopes are zeroed so
   * charts / CSV always query the dimension the user is actually
   * driving. Persisted state keeps both dimensions' raw selections. */
  filters: AnalyzeFiltersState
  ready: boolean
  /** Raw (un-zeroed) App scope selection for binding the select control
   * and saving snapshots — never zeroed by the active dimension. */
  rawAppScopes: string[]
  /** Raw TypingTest scope selection — see `rawAppScopes`. */
  rawTypingTestScopes: string[]
  /** Raw run-id selection for the second-level Results select — see
   * `rawAppScopes`. */
  rawRunIdScopes: string[]
  setDeviceScopes: (v: readonly DeviceScope[]) => void
  setAppScopes: (v: string[]) => void
  setTypingTestScopes: (v: string[]) => void
  setRunIdScopes: (v: string[]) => void
  setFilterDimension: (v: FilterDimension) => void
  setHeatmap: (patch: Partial<HeatmapFilters>) => void
  setWpm: (patch: Partial<WpmFilters>) => void
  setInterval: (patch: Partial<IntervalFilters>) => void
  setActivity: (patch: Partial<ActivityFilters>) => void
  setLayer: (patch: Partial<LayerFilters>) => void
  setErgonomics: (patch: Partial<ErgonomicsFilters>) => void
  setBigrams: (patch: Partial<BigramFilters>) => void
  setLayoutComparison: (patch: Partial<LayoutComparisonFilters>) => void
  /** Apply several fields at once through a single state transition and a
   * single debounced save — for the staged filter modal's Apply action when
   * the keyboard (uid) is NOT changing. Prefer this over calling multiple
   * individual setters back-to-back: each setter is its own `update()` call,
   * so N setters would still coalesce into one save (the debounce timer
   * absorbs that), but would also cause N re-renders of every filter
   * consumer before the timer fires. `applyBatch` merges the whole patch in
   * one `setState` call so consumers only re-render once.
   *
   * For an Apply that also switches keyboards, use `applyBatchForUid`
   * instead — calling `applyBatch` then `onSelectUid` would target the
   * write at the *old* uid and then get silently discarded by the uid-change
   * reload. */
  applyBatch: (patch: AnalyzeFiltersBatchPatch) => void
  /** Register a patch to apply to `forUid` the moment this hook's `uid` prop
   * actually becomes `forUid`. Call this immediately before the parent's
   * `onSelectUid(forUid)` (same tick) — e.g.:
   * ```
   * applyBatchForUid(nextUid, patch)
   * onSelectUid(nextUid)
   * ```
   *
   * Why this exists: a plain uid switch triggers the hook's uid-change
   * effect, which asynchronously loads `forUid`'s *persisted* filters and
   * overwrites state once the load resolves. If the modal had already
   * written `patch` (e.g. via `applyBatch`) before switching, that write
   * targets the keyboard being left, and the incoming load for `forUid`
   * would then clobber the just-applied values with whatever was last
   * saved for `forUid` — the two writers race and the modal's Apply loses.
   *
   * The uid-change effect performs the persisted load for `forUid` as
   * normal, then merges the registered patch ON TOP of the loaded filters
   * in the same resolution (patch wins only for the fields it contains).
   * Fields the patch doesn't touch (tab-specific view settings like
   * `heatmap` / `wpm` / ...) therefore keep the DESTINATION keyboard's
   * persisted values — the patch must never clobber settings the user
   * saved on the keyboard being switched to. The race the mechanism
   * exists for stays solved because the merge happens atop the load
   * inside the same effect: the load result can never land *after* the
   * patch and overwrite it. The merged result is then scheduled for save
   * exactly like a normal edit, so it persists to `forUid`'s file.
   *
   * A registration is single-shot and keyed to `forUid`: if the uid that
   * actually lands doesn't match (the caller changed its mind, or never
   * followed up with `onSelectUid`), the pending entry is discarded on the
   * next uid change rather than silently applying to the wrong keyboard.
   *
   * Calling this with the *current* uid delegates straight to `applyBatch`
   * (there is no uid-change effect coming to consume a registration), so
   * the API is a strict superset of `applyBatch` and safe to call without
   * knowing whether the uid is actually changing. */
  applyBatchForUid: (forUid: string, patch: AnalyzeFiltersBatchPatch) => void
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
  // The active analysis tab. `byApp` charts compare across apps, so the
  // app dimension is forced off there regardless of `filterDimension` —
  // the effective filters reflect that without mutating stored state.
  analysisTab?: AnalysisTabKey,
): UseAnalyzeFiltersReturn {
  const [filters, setFilters] = useState<AnalyzeFiltersState>(DEFAULT_ANALYZE_FILTERS)
  const [ready, setReady] = useState<boolean>(uid === null)

  const uidRef = useRef<string | null>(uid)
  const applySeqRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingUidRef = useRef<string | null>(null)
  const pendingFiltersRef = useRef<AnalyzeFiltersState | null>(null)
  // Single-shot registration consumed by the uid-change effect — see
  // `applyBatchForUid`'s doc comment on `UseAnalyzeFiltersReturn`.
  const pendingUidApplyRef = useRef<{ uid: string; patch: AnalyzeFiltersBatchPatch } | null>(null)
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
        // PATCH only this pane's analyze sub-field. The main-side merge is
        // one level deep on `analyze`, so the sibling pane's filters and
        // every other field (typingTestResults etc.) are preserved without
        // a read-modify-write here (which would otherwise race).
        await window.vialAPI.pipetteSettingsPatch(pendingUid, {
          analyze: { [field]: serializeFilters(pendingFilters) },
        })
      } catch {
        // best-effort save — a failed write just drops the change
      }
    })()
  }, [field])

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

  // Load on uid change (and flush the previous uid's pending write).
  useEffect(() => {
    const prevUid = uidRef.current
    if (prevUid && prevUid !== uid) {
      flushPending()
    }
    uidRef.current = uid

    if (uid === null) {
      pendingUidApplyRef.current = null
      setFilters(DEFAULT_ANALYZE_FILTERS)
      setReady(true)
      return
    }

    // `applyBatchForUid` registered a patch for exactly this uid: run the
    // persisted load as normal, then merge the patch ON TOP of the loaded
    // filters in the same resolution (patch wins only for the fields it
    // contains) so the DESTINATION keyboard's saved per-tab settings
    // survive the switch. Merging atop the load — instead of skipping the
    // load — still solves the writer race this mechanism exists for: the
    // load result can never land after the patch and clobber it, because
    // the two are applied in one `setFilters` call. Discard a registration
    // that targets a *different* uid — it's stale (the caller never
    // followed through with a matching `onSelectUid`) and must not leak
    // onto whichever keyboard happens to load next.
    const pendingApply = pendingUidApplyRef.current
    pendingUidApplyRef.current = null
    const pendingPatch = pendingApply && pendingApply.uid === uid ? pendingApply.patch : null

    const applyLoaded = (loaded: AnalyzeFiltersState): void => {
      if (pendingPatch) {
        const merged: AnalyzeFiltersState = { ...loaded, ...pendingPatch }
        setFilters(merged)
        scheduleSave(merged)
      } else {
        setFilters(loaded)
      }
      setReady(true)
    }

    const seq = ++applySeqRef.current
    setReady(false)
    void window.vialAPI
      .pipetteSettingsGet(uid)
      .then((prefs) => {
        if (applySeqRef.current !== seq) return
        applyLoaded(restoreFilters(prefs?.analyze?.[field]))
      })
      .catch(() => {
        if (applySeqRef.current !== seq) return
        applyLoaded(DEFAULT_ANALYZE_FILTERS)
      })
  }, [uid, flushPending, field, scheduleSave])

  // Flush once more on unmount for the final in-flight edit.
  useEffect(() => {
    return () => {
      flushPending()
    }
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

  const setTypingTestScopes = useCallback((v: string[]) => {
    const next = normalizeAppScopes(v)
    update((prev) => (appScopesEqual(prev.typingTestScopes, next) ? prev : { ...prev, typingTestScopes: next }))
  }, [update])

  const setRunIdScopes = useCallback((v: string[]) => {
    const next = normalizeAppScopes(v)
    update((prev) => (appScopesEqual(prev.runIdScopes, next) ? prev : { ...prev, runIdScopes: next }))
  }, [update])

  const setFilterDimension = useCallback((v: FilterDimension) => {
    update((prev) => (prev.filterDimension === v ? prev : { ...prev, filterDimension: v }))
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

  // See the doc comment on `UseAnalyzeFiltersReturn.applyBatch`.
  const applyBatch = useCallback((patch: AnalyzeFiltersBatchPatch) => {
    const normalized = normalizeBatchPatch(patch)
    update((prev) => ({ ...prev, ...normalized }))
  }, [update])

  // See the doc comment on `UseAnalyzeFiltersReturn.applyBatchForUid`. The
  // actual apply happens inside the uid-change effect above; this just
  // stages the patch for it to pick up. When `forUid` is already the
  // current uid there is no uid-change effect coming to consume the
  // registration, so delegate to the immediate `applyBatch` path — the
  // API is a strict superset of `applyBatch` and calling it without a
  // following `onSelectUid` is harmless rather than a silent no-op.
  const applyBatchForUid = useCallback((forUid: string, patch: AnalyzeFiltersBatchPatch) => {
    if (forUid === uidRef.current) {
      applyBatch(patch)
      return
    }
    pendingUidApplyRef.current = { uid: forUid, patch: normalizeBatchPatch(patch) }
  }, [applyBatch])

  // Zero the inactive dimension so charts only ever query the dimension
  // the user is driving (the toggle's stored `filterDimension`). State
  // keeps both raw selections for the toggle. The By App tab groups across
  // apps, so an app-specific filter would collapse it to one slice — the
  // app dimension is forced off there (the toggle still shows App, but it
  // acts as "all apps").
  const effectiveFilters = useMemo<AnalyzeFiltersState>(() => {
    const dimension = filters.filterDimension
    const appActive = dimension === 'app' && analysisTab !== 'byApp'
    const ttActive = dimension === 'typingTest'
    const appScopes = appActive ? filters.appScopes : EMPTY_SCOPES
    const typingTestScopes = ttActive ? filters.typingTestScopes : EMPTY_SCOPES
    // runIdScopes is a sub-filter of typingTestScopes, so it only applies
    // while the typingTest dimension is active AND a material is selected.
    // Without the material guard a stale run filter would keep narrowing
    // charts after the material is cleared (RunSelect unmounts then, so the
    // selection can no longer be edited away).
    const runIdScopes =
      ttActive && filters.typingTestScopes.length > 0 ? filters.runIdScopes : EMPTY_SCOPES
    if (
      appScopes === filters.appScopes &&
      typingTestScopes === filters.typingTestScopes &&
      runIdScopes === filters.runIdScopes
    ) {
      return filters
    }
    return { ...filters, appScopes, typingTestScopes, runIdScopes }
  }, [filters, analysisTab])

  return {
    filters: effectiveFilters,
    ready,
    rawAppScopes: filters.appScopes,
    rawTypingTestScopes: filters.typingTestScopes,
    rawRunIdScopes: filters.runIdScopes,
    setDeviceScopes,
    setAppScopes,
    setTypingTestScopes,
    setRunIdScopes,
    setFilterDimension,
    setHeatmap,
    setWpm,
    setInterval,
    setActivity,
    setLayer,
    setErgonomics,
    setBigrams,
    setLayoutComparison,
    applyBatch,
    applyBatchForUid,
  }
}
