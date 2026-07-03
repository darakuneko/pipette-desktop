// SPDX-License-Identifier: GPL-2.0-or-later
// Single owner of typing-test run labeling, shared by `RunSelect`
// (option labels) and `AnalyzePane` (the summary chip's Source segment)
// so both surfaces resolve the exact same display name for the same run
// — including the fallbacks for runs that never recorded a History
// entry (e.g. an unnamed run with Save Unnamed off).
//
// `labelFor` resolves in four tiers:
//   1. History entry with a saved name        → the name
//   2. History entry without a name           → its saved ISO date, formatted
//   3. No History entry, but a run row exists → the run's first analytics
//      minute (`firstMs`), formatted with the same formatter
//   4. Nothing known about the id             → the raw run id
//
// Both fetches stay lazy: `uid === null` skips the settings (History)
// fetch; `query` absent/null skips the run-rows fetch — the chip only
// passes a query while a run filter is actually active, and the rows
// fetch keeps RunSelect's 150 ms debounce so range scrubbing doesn't
// fan out one IPC per intermediate value.

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { TypingTestResult } from '../../shared/types/pipette-settings'
import { scopeToSelectValue, type DeviceScope } from '../../shared/types/analyze-filters'
import type { RangeMs } from '../components/analyze/analyze-types'
import { formatDateTime } from '../components/editors/store-modal-shared'

const EMPTY_LABELS: ReadonlyMap<string, string> = new Map()
const EMPTY_RUNS: RunRow[] = []

export interface RunRow {
  runId: string
  firstMs: number
}

/** Scope of the run-rows fetch — mirrors what RunSelect always queried:
 * distinct run ids in the range + device scope + material scope. */
export interface RunLabelsQuery {
  range: RangeMs
  deviceScopes: readonly DeviceScope[]
  /** Selected TypingTest material labels; empty = every material. */
  materialScopes: string[]
}

export interface UseRunLabelsReturn {
  /** Run rows for `query` (empty while no query / still fetching). */
  runs: RunRow[]
  /** Resolve a run id to its display label — see the module doc comment
   * for the four-tier fallback. */
  labelFor: (runId: string) => string
}

/** Nameless-run date stamp — the single fallback formatter for tiers
 * 2 and 3, so a run without a saved name reads identically in the
 * Results dropdown and the summary chip. */
export function formatRunDateLabel(input: string | number): string {
  return formatDateTime(input)
}

/** Build the runId → display-name map from a History list. A saved
 * name wins; nameless entries fall back to their saved ISO date. */
export function buildRunLabelMap(
  results: readonly TypingTestResult[] | undefined,
): ReadonlyMap<string, string> {
  const byRunId = new Map<string, string>()
  for (const r of results ?? []) {
    if (r.runId) byRunId.set(r.runId, r.name || formatRunDateLabel(r.date))
  }
  return byRunId
}

/** Fetch + memoise run labels for `uid`. Pass `uid = null` to skip the
 * History fetch, and omit `query` (or pass `null`) to skip the run-rows
 * fetch — `labelFor` then only has tiers 1/2/4 to work with. */
export function useRunLabels(
  uid: string | null,
  query?: RunLabelsQuery | null,
): UseRunLabelsReturn {
  const [labels, setLabels] = useState<ReadonlyMap<string, string>>(EMPTY_LABELS)
  const [runs, setRuns] = useState<RunRow[]>(EMPTY_RUNS)

  // History labels — only depend on the keyboard, so range scrubbing
  // never re-reads settings.
  useEffect(() => {
    if (!uid) {
      setLabels(EMPTY_LABELS)
      return
    }
    let cancelled = false
    void window.vialAPI
      .pipetteSettingsGet(uid)
      .then((prefs) => {
        if (!cancelled) setLabels(buildRunLabelMap(prefs?.typingTestResults))
      })
      .catch(() => { if (!cancelled) setLabels(EMPTY_LABELS) })
    return () => { cancelled = true }
  }, [uid])

  // Primitive projections of `query` so the effect keys on values, not
  // on the (per-render fresh) object identity.
  const hasQuery = query != null
  const fromMs = query?.range.fromMs ?? 0
  const toMs = query?.range.toMs ?? 0
  const scopeKey = query ? scopeToSelectValue(query.deviceScopes[0] ?? 'own') : ''
  const materialKey = query ? query.materialScopes.join('|') : ''

  // Run rows — refetched on range / scope / material change, debounced
  // 150 ms so range scrubbing doesn't fan out one IPC per intermediate
  // value (mirrors ScopeMultiSelect).
  useEffect(() => {
    if (!uid || !hasQuery) {
      setRuns(EMPTY_RUNS)
      return
    }
    let cancelled = false
    const id = window.setTimeout(() => {
      const materials = materialKey.length > 0 ? materialKey.split('|') : []
      window.vialAPI
        .typingAnalyticsListTypingTestRunsForRange(uid, fromMs, toMs, scopeKey, materials)
        .then((rows) => { if (!cancelled) setRuns(rows) })
        .catch(() => { if (!cancelled) setRuns(EMPTY_RUNS) })
    }, 150)
    return () => {
      cancelled = true
      window.clearTimeout(id)
    }
  }, [uid, hasQuery, fromMs, toMs, scopeKey, materialKey])

  const firstMsById = useMemo(() => {
    const m = new Map<string, number>()
    for (const run of runs) m.set(run.runId, run.firstMs)
    return m
  }, [runs])

  const labelFor = useCallback((runId: string): string => {
    const historyLabel = labels.get(runId)
    if (historyLabel !== undefined) return historyLabel
    const firstMs = firstMsById.get(runId)
    if (firstMs !== undefined) return formatRunDateLabel(firstMs)
    return runId
  }, [labels, firstMsById])

  return { runs, labelFor }
}
