// SPDX-License-Identifier: GPL-2.0-or-later

/** Fetches every saved run log for `uid` that a `typingTestHistory` row
 *  references, for Weak Spot Training's timing signals (slowness/stall —
 *  see weak-spot-timing.ts/weak-spot-profile.ts). Mirrors
 *  use-mistake-ranking-details.ts's `useAggregatedMissedDetails` fetch
 *  shape closely (same `typingRunLogList`/`typingRunLogGet` IPC pair,
 *  same ref-cached-by-runId batch-fetch pattern) with one deliberate
 *  difference: that hook only fetches for the History modal's CURRENT
 *  tab's results (and only once the Analysis view is mounted at all) —
 *  this one fetches for the keyboard's WHOLE retained history (bounded to
 *  <=MAX_RUN_LOGS_PER_KEYBOARD by the store's own retention, same cost
 *  ceiling as that feature already accepts) and runs whenever a keyboard
 *  is connected, independent of whether History is ever opened — Weak
 *  Spot Training must work without the user ever visiting History. */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { TypingTestResult } from '../../../shared/types/pipette-settings'
import type { RunKeystrokeLog } from '../../../shared/types/typing-run-log'

const EMPTY_LOGS: ReadonlyMap<string, RunKeystrokeLog> = new Map()

/** Returns a `runId -> RunKeystrokeLog` map covering every `results` row
 *  whose `runId` actually has a saved log for `uid` — a row with no
 *  `runId`, or one the store doesn't have (predates the log feature,
 *  recording consent was off, or retention evicted it), simply has no
 *  entry; `weak-spot-profile.ts`'s aggregation already treats a missing
 *  entry as "no timing data for this run" and falls back to mistakes-only
 *  weakness, exactly per the plan's "log absent" rule.
 *
 *  LAZY/CACHED the same way `useAggregatedMissedDetails` is: a `useRef`
 *  Map survives re-renders without forcing one, only runIds not already
 *  cached are fetched on each effect run, and a whole batch commits via
 *  one `Promise.allSettled` rather than a progressive per-item update
 *  (same simplicity trade-off, same rationale — see that hook's own doc
 *  comment). `uid` changing (keyboard switch) resets caching implicitly:
 *  a fresh `runIds` set for the new uid naturally has nothing cached yet,
 *  and stale entries from the previous uid are simply never read again
 *  (never actively cleared — harmless, bounded by history size). */
export function useWeakSpotRunLogs(
  uid: string | undefined,
  results: readonly TypingTestResult[],
): ReadonlyMap<string, RunKeystrokeLog> {
  const cacheRef = useRef<Map<string, RunKeystrokeLog | null>>(new Map())
  const availableRunIdsRef = useRef<Set<string> | null>(null)
  // Has no meaning of its own — bumped once availability or a fetch batch
  // settles, purely to retrigger the final useMemo (the refs above are
  // invisible to React's dependency comparison).
  const [version, setVersion] = useState(0)

  const candidateRunIds = useMemo(() => {
    const ids = new Set<string>()
    for (const r of results) {
      if (r.runId) ids.add(r.runId)
    }
    return ids
  }, [results])

  // Fetch the uid's available-run-id index once per uid.
  useEffect(() => {
    availableRunIdsRef.current = null
    if (!uid) return
    let cancelled = false
    window.vialAPI.typingRunLogList(uid)
      .then((res) => {
        if (cancelled) return
        availableRunIdsRef.current = new Set(res.success && res.entries ? res.entries.map((e) => e.id) : [])
        setVersion((v) => v + 1)
      })
      .catch(() => {
        if (cancelled) return
        availableRunIdsRef.current = new Set()
        setVersion((v) => v + 1)
      })
    return () => { cancelled = true }
  }, [uid])

  useEffect(() => {
    if (!uid) return
    const available = availableRunIdsRef.current
    if (!available) return // index not loaded yet — the effect above will retrigger this one via `version`
    const missing = Array.from(candidateRunIds).filter((runId) => available.has(runId) && !cacheRef.current.has(runId))
    if (missing.length === 0) return
    let cancelled = false
    Promise.allSettled(
      missing.map((runId) =>
        window.vialAPI.typingRunLogGet(uid, runId)
          .then((res) => ({ runId, log: res.success && res.data ? res.data : null }))
          .catch(() => ({ runId, log: null as RunKeystrokeLog | null })),
      ),
    ).then((settled) => {
      if (cancelled) return
      for (const outcome of settled) {
        if (outcome.status === 'fulfilled') cacheRef.current.set(outcome.value.runId, outcome.value.log)
      }
      setVersion((v) => v + 1)
    })
    return () => { cancelled = true }
    // `version` deliberately participates: it's what retriggers this
    // effect once the availability fetch above lands.
  }, [uid, candidateRunIds, version])

  return useMemo(() => {
    if (cacheRef.current.size === 0) return EMPTY_LOGS
    const map = new Map<string, RunKeystrokeLog>()
    for (const runId of candidateRunIds) {
      const log = cacheRef.current.get(runId)
      if (log) map.set(runId, log)
    }
    return map
    // `version` deliberately participates in this dependency list (not
    // read in the body above) — same shape as useAggregatedMissedDetails's
    // own `fetchVersion` dependency: it's what invalidates this memo once
    // an availability or log-fetch batch lands and mutates the refs.
  }, [candidateRunIds, version])
}
