// SPDX-License-Identifier: GPL-2.0-or-later
// Per-keyboard Analyze filter state. Centralises the fan-out of "read
// on mount, debounce on change, flush on uid switch / unmount" so the
// chart components only see a plain state object + narrow updater
// functions. `range` stays out of the persisted shape on purpose — the
// default 7-day window re-arms each session via renderer-local state.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PipetteSettings } from '../../shared/types/pipette-settings'
import { DEFAULT_PIPETTE_SETTINGS } from '../../shared/types/pipette-settings'
import type {
  ActivityFilters,
  AnalyzeFilterSettings,
  DeviceScope,
  HeatmapFilters,
  IntervalFilters,
  LayerFilters,
  WpmFilters,
} from '../../shared/types/analyze-filters'

const DEBOUNCE_MS = 300

export interface AnalyzeFiltersState {
  deviceScope: DeviceScope
  heatmap: Required<HeatmapFilters>
  wpm: Required<WpmFilters>
  interval: Required<IntervalFilters>
  activity: Required<ActivityFilters>
  layer: Required<LayerFilters>
}

export const DEFAULT_ANALYZE_FILTERS: AnalyzeFiltersState = {
  deviceScope: 'own',
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
}

function restoreFilters(saved: AnalyzeFilterSettings | undefined): AnalyzeFiltersState {
  if (!saved) return DEFAULT_ANALYZE_FILTERS
  return {
    deviceScope: saved.deviceScope ?? DEFAULT_ANALYZE_FILTERS.deviceScope,
    heatmap: { ...DEFAULT_ANALYZE_FILTERS.heatmap, ...saved.heatmap },
    wpm: { ...DEFAULT_ANALYZE_FILTERS.wpm, ...saved.wpm },
    interval: { ...DEFAULT_ANALYZE_FILTERS.interval, ...saved.interval },
    activity: { ...DEFAULT_ANALYZE_FILTERS.activity, ...saved.activity },
    layer: { ...DEFAULT_ANALYZE_FILTERS.layer, ...saved.layer },
  }
}

function serializeFilters(state: AnalyzeFiltersState): AnalyzeFilterSettings {
  return {
    deviceScope: state.deviceScope,
    heatmap: state.heatmap,
    wpm: state.wpm,
    interval: state.interval,
    activity: state.activity,
    layer: state.layer,
  }
}

export interface UseAnalyzeFiltersReturn {
  filters: AnalyzeFiltersState
  ready: boolean
  setDeviceScope: (v: DeviceScope) => void
  setHeatmap: (patch: Partial<HeatmapFilters>) => void
  setWpm: (patch: Partial<WpmFilters>) => void
  setInterval: (patch: Partial<IntervalFilters>) => void
  setActivity: (patch: Partial<ActivityFilters>) => void
  setLayer: (patch: Partial<LayerFilters>) => void
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
      scheduleSave(next)
      return next
    })
  }, [scheduleSave])

  const setDeviceScope = useCallback((v: DeviceScope) => {
    update((prev) => ({ ...prev, deviceScope: v }))
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

  return {
    filters,
    ready,
    setDeviceScope,
    setHeatmap,
    setWpm,
    setInterval,
    setActivity,
    setLayer,
  }
}
