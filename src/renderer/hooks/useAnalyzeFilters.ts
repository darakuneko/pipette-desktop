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
  deviceScopesEqual,
  normalizeDeviceScopes,
  type ActivityFilters,
  type AnalyzeFilterSettings,
  type BigramFilters,
  type DeviceScope,
  type HeatmapFilters,
  type IntervalFilters,
  type LayerFilters,
  type WpmFilters,
} from '../../shared/types/analyze-filters'

const DEBOUNCE_MS = 300

export interface AnalyzeFiltersState {
  /** Single-select Device filter — held as an array so the persisted
   * filter shape and `normalizeDeviceScopes` invariants stay stable.
   * Always pre-normalized: dedupe + `'all'` exclusivity + length cap
   * (`MAX_DEVICE_SCOPES = 1`) are handled inside the setter so
   * consumers can rely on the canonical shape without re-running the
   * normalizer themselves. */
  deviceScopes: DeviceScope[]
  heatmap: Required<HeatmapFilters>
  wpm: Required<WpmFilters>
  interval: Required<IntervalFilters>
  activity: Required<ActivityFilters>
  layer: Required<LayerFilters>
  bigrams: Required<BigramFilters>
}

export const DEFAULT_ANALYZE_FILTERS: AnalyzeFiltersState = {
  deviceScopes: ['own'],
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
  },
  layer: {
    viewMode: 'keystrokes',
    baseLayer: 0,
  },
  bigrams: {
    topLimit: 10,
    slowLimit: 10,
    fingerLimit: 20,
    keyLimit: 20,
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
    heatmap: { ...DEFAULT_ANALYZE_FILTERS.heatmap, ...saved.heatmap },
    wpm: { ...DEFAULT_ANALYZE_FILTERS.wpm, ...saved.wpm },
    interval: { ...DEFAULT_ANALYZE_FILTERS.interval, ...saved.interval },
    activity: { ...DEFAULT_ANALYZE_FILTERS.activity, ...saved.activity },
    layer: { ...DEFAULT_ANALYZE_FILTERS.layer, ...saved.layer },
    bigrams: { ...DEFAULT_ANALYZE_FILTERS.bigrams, ...saved.bigrams },
  }
}

function serializeFilters(state: AnalyzeFiltersState): AnalyzeFilterSettings {
  return {
    deviceScopes: state.deviceScopes,
    heatmap: state.heatmap,
    wpm: state.wpm,
    interval: state.interval,
    activity: state.activity,
    layer: state.layer,
    bigrams: state.bigrams,
  }
}

export interface UseAnalyzeFiltersReturn {
  filters: AnalyzeFiltersState
  ready: boolean
  setDeviceScopes: (v: readonly DeviceScope[]) => void
  setHeatmap: (patch: Partial<HeatmapFilters>) => void
  setWpm: (patch: Partial<WpmFilters>) => void
  setInterval: (patch: Partial<IntervalFilters>) => void
  setActivity: (patch: Partial<ActivityFilters>) => void
  setLayer: (patch: Partial<LayerFilters>) => void
  setBigrams: (patch: Partial<BigramFilters>) => void
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
export function useAnalyzeFilters(uid: string | null): UseAnalyzeFiltersReturn {
  const [filters, setFilters] = useState<AnalyzeFiltersState>(DEFAULT_ANALYZE_FILTERS)
  const [ready, setReady] = useState<boolean>(uid === null)

  const uidRef = useRef<string | null>(uid)
  const applySeqRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingUidRef = useRef<string | null>(null)
  const pendingFiltersRef = useRef<AnalyzeFiltersState | null>(null)

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
        const nextAnalyze = { ...base.analyze, filters: serializeFilters(pendingFilters) }
        await window.vialAPI.pipetteSettingsSet(pendingUid, { ...base, analyze: nextAnalyze })
      } catch {
        // best-effort save — a failed write just drops the change
      }
    })()
  }, [])

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
        setFilters(restoreFilters(prefs?.analyze?.filters))
        setReady(true)
      })
      .catch(() => {
        if (applySeqRef.current !== seq) return
        setFilters(DEFAULT_ANALYZE_FILTERS)
        setReady(true)
      })
  }, [uid, flushPending])

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
    update((prev) => ({ ...prev, activity: { ...prev.activity, ...patch } }))
  }, [update])

  const setLayer = useCallback((patch: Partial<LayerFilters>) => {
    update((prev) => ({ ...prev, layer: { ...prev.layer, ...patch } }))
  }, [update])

  const setBigrams = useCallback((patch: Partial<BigramFilters>) => {
    update((prev) => ({ ...prev, bigrams: { ...prev.bigrams, ...patch } }))
  }, [update])

  return {
    filters,
    ready,
    setDeviceScopes,
    setHeatmap,
    setWpm,
    setInterval,
    setActivity,
    setLayer,
    setBigrams,
  }
}
