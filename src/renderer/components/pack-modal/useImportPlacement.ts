// SPDX-License-Identifier: GPL-2.0-or-later
//
// Consolidates the "place a freshly-imported/downloaded entry" tail
// shared by all three pack modals' file-import and Hub-download paths:
// snapshot the pre-operation id set → decide overwrite vs. insert →
// compute the sorted-insert position (skipped for the 'free' Name-sort
// state, or for an overwrite) → persist via `reorder` → toolbar
// feedback text → scroll the affected row into view. This used to be
// duplicated inline at all 5 call sites (LanguagePacksModal's
// persistImportedPack covers both its own file-import and Hub-download
// paths; Key Labels and Theme Packs each have one of each) — the
// duplication had already drifted once (Theme Packs' Hub-download path
// silently swallowed a failed reorder that the file-import path
// checked; see the P2 note below).
//
// Also absorbs the (removed) useImportFeedback and useScrollRowIntoView
// hooks — every site that needed one needed the other, so splitting
// them into two hooks bought nothing but two extra call sites to keep
// in sync.
//
// Each caller still owns the actual store call (validation, coverage
// computation, Hub metadata enrichment, hub auto-sync — these differ
// per feature) and its own existing per-row `PackActionResult` badge;
// this hook only owns the placement tail. Usage:
//
//   const beforeIds = placement.snapshotBeforeIds()
//   const result = await store.applyImport(raw, opts)
//   if (result.success && result.meta) {
//     await placement.place({ id: result.meta.id, name: result.meta.name }, { beforeIds })
//   }
//
// Key Labels' Hub download skips the snapshot entirely — its
// DUPLICATE_NAME guard (main-side) already rejects any name collision
// before the download can succeed, so every successful download there
// is unconditionally a new entry:
//
//   await placement.place({ id, name }, { alwaysInsert: true })
//
// RAPID-INSERT RACE (P1): two placements fired in quick succession (two
// imports, or an import racing a Hub download) must not each compute
// their insert position from a stale render closure — the second one
// needs to see the first's already-inserted entry, or its `reorder`
// call persists an order that is missing the first's id entirely (not
// just mis-sorted — `reorder` is a full-list replacement, so silently
// dropping an id is the real risk, not just wrong position). Every
// value `place()` reads (`entries`, `direction`, `reorder`, the error
// callback, `t`, `open`, the testid prefix) comes from a ref updated on
// every render — never the closure captured when `place` itself was
// created — and placements are serialized through an internal promise
// chain (`queueRef`) so the second one's order computation only runs
// after the first's `reorder` call has resolved and the caller has
// re-rendered with the refreshed entries.
//
// REORDER-FAILURE VISIBILITY (P2): a failed sorted-insert `reorder`
// call is surfaced via `onReorderError` (each site's existing
// setActionError) but does NOT suppress the "Imported {{name}}"
// feedback — the import/download itself genuinely succeeded (the file
// is on disk / the post is downloaded); only its *position* failed to
// persist. Showing "Imported" alongside a visible error is the
// coherent read: the entry is there (probably at the bottom, wherever
// the store's own append landed it), the position just didn't stick.
//
// FEEDBACK/CLOSE RACE (P2): if a placement's `reorder` (or the whole
// call) resolves after the modal has already closed, showing feedback
// then would surface stale text on the next open. `showFeedback` checks
// an `open` ref at the moment it would actually display something, not
// when the placement started; the auto-clear timer is also torn down
// immediately on close so it cannot fire into a since-reopened session.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { NameSortEntry, SortDirection } from './useNameSort'
import { computeSortedInsertOrder } from './sorted-insert'

const AUTO_CLEAR_MS = 5000

export interface UseImportPlacementOptions {
  open: boolean
  /** Current reorderable list, in persisted display order — same
   *  scope as passed to `useNameSort` (includes QWERTY for Key Labels,
   *  excludes builtins for Language/Theme Packs). */
  entries: NameSortEntry[]
  direction: SortDirection
  reorder: (orderedIds: string[]) => Promise<{ success: boolean; error?: string }>
  /** Row testid is `${rowTestidPrefix}-row-${id}`. */
  rowTestidPrefix: string
  /** Surfaces a failed sorted-insert `reorder` call — each site decides
   *  how (typically `setActionError`). Not called for anything else;
   *  the underlying import/download's own success/failure is the
   *  caller's responsibility. */
  onReorderError: (error: string | undefined) => void
}

export interface PlacementOptions {
  /** From `snapshotBeforeIds()`, called before the store operation.
   *  Omit only when `alwaysInsert` is set. */
  beforeIds?: Set<string>
  /** Skips the overwrite check entirely and always treats `result` as
   *  a new entry — for sites where overwriting is already provably
   *  impossible (Key Labels' Hub download; see the module doc). */
  alwaysInsert?: boolean
}

export interface UseImportPlacementResult {
  /** Current toolbar "Imported {{name}}" / "Updated {{name}}" text, or
   *  null. Rendered via `PackManagerModal`'s `importFeedback` slot. */
  feedback: string | null
  /** Call synchronously right before starting the underlying
   *  import/download store call. */
  snapshotBeforeIds: () => Set<string>
  /**
   * Call after the store operation resolves with the placed entry's
   * `{ id, name }`. Serialized — queues behind any in-flight placement
   * so both compute their sorted-insert position against up-to-date
   * data (see the P1 note in the module doc).
   */
  place: (result: NameSortEntry, opts?: PlacementOptions) => Promise<void>
}

export function useImportPlacement({
  open,
  entries,
  direction,
  reorder,
  rowTestidPrefix,
  onReorderError,
}: UseImportPlacementOptions): UseImportPlacementResult {
  const { t } = useTranslation()
  const [feedback, setFeedback] = useState<string | null>(null)
  const [scrollTarget, setScrollTarget] = useState<string | null>(null)

  // Always-latest refs, updated unconditionally every render (a plain
  // assignment during render, not an effect — this is the "adjust a
  // ref during render" pattern: it never affects this render's output,
  // only what a later async callback sees). `place()` and
  // `snapshotBeforeIds()` are memoized with empty dep arrays and read
  // exclusively from these, so their identities stay stable across
  // renders while still always observing the latest values, however
  // long a queued placement had to wait its turn.
  const entriesRef = useRef(entries)
  entriesRef.current = entries
  const directionRef = useRef(direction)
  directionRef.current = direction
  const reorderRef = useRef(reorder)
  reorderRef.current = reorder
  const onReorderErrorRef = useRef(onReorderError)
  onReorderErrorRef.current = onReorderError
  const tRef = useRef(t)
  tRef.current = t
  const openRef = useRef(open)
  openRef.current = open
  const rowTestidPrefixRef = useRef(rowTestidPrefix)
  rowTestidPrefixRef.current = rowTestidPrefix

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const showFeedback = useCallback((message: string) => {
    // The modal may have closed while this placement's store call /
    // reorder was in flight — don't resurrect stale text for the next
    // time it opens.
    if (!openRef.current) return
    clearTimer()
    setFeedback(message)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      setFeedback(null)
    }, AUTO_CLEAR_MS)
  }, [clearTimer])

  // Modal closed: clear immediately and cancel any pending timer.
  useEffect(() => {
    if (!open) {
      clearTimer()
      setFeedback(null)
    }
  }, [open, clearTimer])

  // Unmount: tear down any pending timer.
  useEffect(() => clearTimer, [clearTimer])

  // Scroll-into-view (absorbed from the removed useScrollRowIntoView).
  // An effect keyed off `scrollTarget` so it runs after the triggering
  // state update(s) — the sorted-insert reorder and the resulting
  // row-list re-render — have committed and painted; scrolling
  // synchronously at the call site would find the row at its old
  // position and then jump again once the reorder lands.
  useEffect(() => {
    if (!scrollTarget) return
    const el = document.querySelector(`[data-testid="${scrollTarget}"]`)
    el?.scrollIntoView({ block: 'nearest' })
    setScrollTarget(null)
  }, [scrollTarget])
  const scheduleScroll = useCallback((testid: string) => setScrollTarget(testid), [])

  const snapshotBeforeIds = useCallback((): Set<string> => {
    return new Set(entriesRef.current.map((entry) => entry.id))
  }, [])

  // Serializes placements so a second one's order computation always
  // sees the first's already-settled insert. `queueRef` holds a
  // "settle regardless" tail so one placement's failure never wedges
  // the chain for the next; the promise returned to the *caller*
  // (`settled`) still reflects this specific placement's own outcome.
  const queueRef = useRef<Promise<void>>(Promise.resolve())

  const place = useCallback((
    result: NameSortEntry,
    opts?: PlacementOptions,
  ): Promise<void> => {
    const run = async (): Promise<void> => {
      const isInsert = opts?.alwaysInsert === true || !(opts?.beforeIds?.has(result.id) ?? false)
      if (isInsert) {
        const orderedIds = computeSortedInsertOrder(entriesRef.current, result, directionRef.current)
        if (orderedIds) {
          const reorderResult = await reorderRef.current(orderedIds)
          if (!reorderResult.success) onReorderErrorRef.current(reorderResult.error)
        }
        // Shown regardless of whether the reorder above succeeded —
        // see the "REORDER-FAILURE VISIBILITY" note in the module doc.
        showFeedback(tRef.current('common.importedNamed', { name: result.name }))
      } else {
        showFeedback(tRef.current('common.updatedNamed', { name: result.name }))
      }
      scheduleScroll(`${rowTestidPrefixRef.current}-row-${result.id}`)
    }
    const settled = queueRef.current.then(run, run)
    queueRef.current = settled.then(() => undefined, () => undefined)
    return settled
  }, [showFeedback, scheduleScroll])

  return { feedback, snapshotBeforeIds, place }
}
