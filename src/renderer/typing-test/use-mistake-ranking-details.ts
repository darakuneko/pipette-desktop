// SPDX-License-Identifier: GPL-2.0-or-later
// Aggregates buildMissedDetails(log) ACROSS every run log available for
// the History Analysis tab's mistake ranking — unlike
// KeystrokeTimelinePanel's single-run table, MistakeRankingSection.tsx's
// own data source spans every result in the active tab. The merge logic
// (mergeMissedDetails) stays unit-testable without mounting a component
// or mocking IPC.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { TypingTestResult } from '../../shared/types/pipette-settings'
import type { RunKeystrokeLog } from '../../shared/types/typing-run-log'
import { buildMissedDetails, type MissedCharDetail } from './missed-details'
import { useSyncUnitApplied } from '../hooks/use-sync-unit-applied'

/** Sums `source` into `target` in place — `typedCounts` per typed char,
 *  `movedOnCount` as a running total. */
function mergeMissedDetailInto(target: MissedCharDetail, source: MissedCharDetail): void {
  for (const [typedChar, n] of Object.entries(source.typedCounts)) {
    target.typedCounts[typedChar] = (target.typedCounts[typedChar] ?? 0) + n
  }
  target.movedOnCount += source.movedOnCount
}

/** Merges N per-run detail maps (each `buildMissedDetails(log)`'s own
 *  return value) into one, summing `typedCounts` per key and
 *  `movedOnCount` across every map that has an entry for that key. A key
 *  present in only SOME of the maps still merges correctly — the
 *  contributing runs' own figures simply accumulate onto whatever the
 *  other runs already contributed, with no special-casing needed for
 *  "this run has nothing to say about this key". */
export function mergeMissedDetails(perRunDetails: readonly Map<string, MissedCharDetail>[]): Map<string, MissedCharDetail> {
  const merged = new Map<string, MissedCharDetail>()
  for (const details of perRunDetails) {
    for (const [key, detail] of details) {
      let entry = merged.get(key)
      if (!entry) {
        entry = { typedCounts: {}, movedOnCount: 0 }
        merged.set(key, entry)
      }
      mergeMissedDetailInto(entry, detail)
    }
  }
  return merged
}

/** Fetches every run log referenced by `results` (via its own `runId`)
 *  that `availableRunIds` confirms actually has a saved log, and returns
 *  the MERGED `buildMissedDetails()` map across all of them.
 *
 *  LAZY: this hook does nothing at all until it's actually mounted with a
 *  real `uid` — `MistakeRankingSection` (and therefore this hook) only
 *  mounts once the History modal's Analysis view is switched to
 *  (`HistorySections` is a ternary branch in `TypingTestHistory.tsx`, not
 *  always-rendered), so no extra "is the view active" gate is needed here.
 *
 *  CACHED PER MOUNT: fetched logs are kept in a `useRef` Map (runId ->
 *  log-or-null), which — being a ref — survives every re-render without
 *  itself triggering one. Each effect run only fetches runIds NOT already
 *  in the cache (a tab switch, or new results being merged in, adds runIds
 *  incrementally rather than re-fetching everything already known).
 *
 *  BATCH, not progressive: cached logs merge immediately; on a
 *  `[uid, runIds]` change (with a truthy `uid`) every uncached log fetches
 *  in parallel via `Promise.allSettled`, and they land together once all
 *  settle (a cancelled batch commits nothing), rather than one merge per
 *  fetch. Trade-off: a slow fetch among many delays the whole batch
 *  instead of only its own row — accepted since a typical tab has a
 *  bounded number of runs, and the progressive alternative would need
 *  incremental per-item state merging.
 *
 *  A result with no `runId`, or a `runId` not in `availableRunIds` (the
 *  run predates the log feature, was evicted by retention, or was saved
 *  without recording consent), simply never enters `runIds` at all — it
 *  contributes counts only via `MistakeRankingSection`'s own `mistakes`
 *  aggregation, with no per-key detail (renders `EMPTY_STAT_VALUE` in
 *  Typed instead / Moved on). A per-log fetch error (rejected promise, or
 *  `{ success: false }`) is caught and treated the same as "no log" for
 *  that one run — it's swallowed here, never thrown, and never blocks the
 *  rest of the batch. Every successfully-fetched log is also
 *  independently subject to `buildMissedDetails`'s own
 *  `charCorrelationUnavailable` bailout (an empty per-run map, not an
 *  error).
 *
 *  A sync merge of this keyboard's run logs (`keyboards/{uid}/runs`)
 *  re-reads every log in `runIds`, cached or not, and the next committed
 *  batch replaces the whole cache; a batch started before the merge is
 *  dropped. Until that commit the previous details stay visible. Logs the
 *  merge removed drop out through `availableRunIds`, which the caller
 *  re-reads on the same notification (`useRunLogAvailability`). */
export function useAggregatedMissedDetails(
  uid: string | undefined,
  results: readonly TypingTestResult[],
  availableRunIds: ReadonlySet<string> | undefined,
): Map<string, MissedCharDetail> {
  const cacheRef = useRef<Map<string, RunKeystrokeLog | null>>(new Map())
  // Has no meaning of its own — bumped once a fetch batch settles, purely
  // to retrigger the merge below (cacheRef.current is a ref, invisible to
  // React's dependency comparison).
  const [fetchVersion, setFetchVersion] = useState(0)
  // Bumped by a sync merge: re-runs the fetch, and a batch started under an
  // older generation is dropped instead of cached. The ref moves in the
  // handler itself: a batch can settle after a second notification but
  // before React runs the effect cleanup, and must not commit then. The
  // handler leaves `fetchVersion` alone so the merge below keeps the
  // previous details.
  const [syncGeneration, setSyncGeneration] = useState(0)
  const syncGenerationRef = useRef(0)
  // Set by a sync merge until a batch commits: fetch every log in `runIds`
  // and replace the cache with the result.
  const refetchAllRef = useRef(false)

  useSyncUnitApplied(
    (unit) => uid !== undefined && unit === `keyboards/${uid}/runs`,
    () => {
      syncGenerationRef.current += 1
      refetchAllRef.current = true
      setSyncGeneration(syncGenerationRef.current)
    },
  )

  const runIds = useMemo(() => {
    const ids = new Set<string>()
    if (!availableRunIds) return ids
    for (const result of results) {
      if (result.runId && availableRunIds.has(result.runId)) ids.add(result.runId)
    }
    return ids
  }, [results, availableRunIds])

  useEffect(() => {
    if (!uid) return
    const refetchAll = refetchAllRef.current
    const commit = (entries: readonly { runId: string; log: RunKeystrokeLog | null }[]): void => {
      if (refetchAll) {
        refetchAllRef.current = false
        cacheRef.current.clear()
      }
      for (const { runId, log } of entries) cacheRef.current.set(runId, log)
      setFetchVersion((v) => v + 1)
    }
    const missing = Array.from(runIds).filter((runId) => refetchAll || !cacheRef.current.has(runId))
    if (missing.length === 0) {
      if (refetchAll) commit([])
      return
    }
    const generation = syncGenerationRef.current
    let cancelled = false
    Promise.allSettled(
      missing.map((runId) =>
        window.vialAPI.typingRunLogGet(uid, runId)
          .then((res) => ({ runId, log: res.success && res.data ? res.data : null }))
          .catch(() => ({ runId, log: null as RunKeystrokeLog | null })),
      ),
    ).then((settled) => {
      if (cancelled || generation !== syncGenerationRef.current) return
      // Only a bug in the .catch() above (which never throws) could reach
      // 'rejected' here — defensive, not a real code path.
      commit(settled.flatMap((outcome) => (outcome.status === 'fulfilled' ? [outcome.value] : [])))
    })
    return () => { cancelled = true }
  }, [uid, runIds, syncGeneration])

  return useMemo(() => {
    const perRunDetails: Map<string, MissedCharDetail>[] = []
    for (const runId of runIds) {
      const log = cacheRef.current.get(runId)
      if (log) perRunDetails.push(buildMissedDetails(log))
    }
    return mergeMissedDetails(perRunDetails)
    // `fetchVersion` deliberately participates in this dependency list —
    // see its own doc comment above.
  }, [runIds, fetchVersion])
}
