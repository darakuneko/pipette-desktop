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
// after the first's `reorder` call has resolved AND the caller has
// re-rendered with the refreshed entries.
//
// That second half of the guarantee is the part `place()` cannot
// actually make on its own: the store's `reorder`/`refresh` functions
// resolve once `setState` has been *called*, not once the component has
// *re-rendered* with the new state — React schedules that separately,
// on its own timer. A multi-file import batch that calls `place()` once
// per file in a tight loop has no guarantee a render lands between
// iterations, so a later file's sorted-insert position can be computed
// against a snapshot that is missing an earlier file's insert (or, if
// some unrelated background refresh raced in, one that already contains
// an id the caller is about to insert a second time). `placeMany` below
// exists for exactly this case: it takes every result in a batch at
// once and positions them as a group with a single pure computation
// (`computeSortedInsertOrderMany`) against a snapshot taken once before
// the batch started — no dependency on any render happening in between,
// and at most one `reorder` call for the whole batch. `place()` itself
// is untouched and still used for every single-item flow (Hub download,
// rename auto-sync, etc.), where the race does not apply in practice —
// those are separate user-triggered actions with real time between them.
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
//
// DIRECTION RACE (batch): `placeMany`'s merge computation must not read
// `directionRef.current` at execution time either — a batch's file-save
// loop can take a while (several IPC round trips), and the user is free
// to click the Name-sort toggle (asc <-> desc) while it runs. Reading
// live direction there would merge `toInsert` against one direction
// while `beforeEntries` (captured at batch start) reflects the other,
// producing a persisted order that is sorted in neither direction.
// `snapshotEntries()` therefore captures direction alongside entries in
// one `BatchSnapshot`, and `placeMany` uses only that frozen value —
// the whole batch is placed consistently against the state that existed
// when it began, exactly like `beforeEntries` already was. `place()`
// (single-item) is untouched and keeps reading live direction: those
// are separate user-triggered actions with no long-running loop for a
// toggle to land inside of.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { NameSortEntry, SortDirection } from './useNameSort'
import { computeSortedInsertOrder, computeSortedInsertOrderMany } from './sorted-insert'

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

/** Frozen pre-batch state for `placeMany`: both the entries list and the
 *  sort direction as they stood when the batch started, captured
 *  together by `snapshotEntries()` so neither can drift independently
 *  while the batch's file-save loop runs (see the DIRECTION RACE note
 *  in the module doc). */
export interface BatchSnapshot {
  entries: NameSortEntry[]
  direction: SortDirection
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
   * Call synchronously once, right before starting a multi-file import
   * batch's store calls. Returns the entries list AND sort direction
   * (not just ids) as they stood before any file in the batch was saved
   * — pass the result to `placeMany` so the batch's merge computation
   * never depends on `entriesRef`/`directionRef` (which can drift
   * mid-batch; see the RAPID-INSERT RACE and DIRECTION RACE notes in
   * the module doc).
   */
  snapshotEntries: () => BatchSnapshot
  /**
   * Call after the store operation resolves with the placed entry's
   * `{ id, name }`. Serialized — queues behind any in-flight placement
   * so both compute their sorted-insert position against up-to-date
   * data (see the P1 note in the module doc).
   */
  place: (result: NameSortEntry, opts?: PlacementOptions) => Promise<void>
  /**
   * Batch-aware counterpart to `place()` for a multi-file import: pass
   * every processed result (successes only — the caller already
   * dedupes by id and skips failures) plus the `BatchSnapshot` captured
   * via `snapshotEntries()` before the batch started. Positions every
   * newly-inserted result as a group in one pure computation — against
   * the snapshot's frozen entries AND direction, never live state — and
   * issues at most one `reorder` call for the whole batch. See the
   * RAPID-INSERT RACE and DIRECTION RACE notes in the module doc for why
   * this differs from calling `place()` once per result.
   *
   * `originalCount` drives ONLY the auto-scroll suppression below — it
   * is the true number of files the batch selected/processed BEFORE any
   * same-id dedupe collapsed `results`, so a 2-file selection that
   * happens to dedupe down to one placed result (both files overwrote
   * the same existing pack) still reads as a batch and does not scroll.
   * Defaults to `results.length` — a caller with no dedupe step of its
   * own (there is currently only one caller, `useImportBatch`, and it
   * always passes this explicitly) sees identical behavior to before
   * this parameter existed. Never affects the reorder computation or
   * the last-result feedback anchor, both of which still operate on the
   * actual (deduped) `results`.
   */
  placeMany: (results: NameSortEntry[], snapshot: BatchSnapshot, originalCount?: number) => Promise<void>
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

  const snapshotEntries = useCallback((): BatchSnapshot => {
    return { entries: entriesRef.current, direction: directionRef.current }
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

  const placeMany = useCallback((
    results: NameSortEntry[],
    snapshot: BatchSnapshot,
    originalCount: number = results.length,
  ): Promise<void> => {
    const run = async (): Promise<void> => {
      if (results.length === 0) return
      const { entries: beforeEntries, direction: beforeDirection } = snapshot
      const beforeIds = new Set(beforeEntries.map((entry) => entry.id))
      const toInsert = results.filter((r) => !beforeIds.has(r.id))
      if (toInsert.length > 0) {
        // Merged purely from `beforeEntries` + `toInsert` + the
        // snapshot's own `beforeDirection` — never from
        // `entriesRef.current`/`directionRef.current` — so this cannot
        // be corrupted by a background refresh, or a Name-sort toggle,
        // landing partway through the batch (see the RAPID-INSERT RACE
        // and DIRECTION RACE notes in the module doc).
        const orderedIds = computeSortedInsertOrderMany(beforeEntries, toInsert, beforeDirection)
        if (orderedIds) {
          const reorderResult = await reorderRef.current(orderedIds)
          if (!reorderResult.success) onReorderErrorRef.current(reorderResult.error)
        }
      }
      // Feedback anchors on the last result processed — same "last one
      // wins" convention the calling modals already use for e.g.
      // switching the active language/theme after a batch import.
      const last = results[results.length - 1]
      const lastIsInsert = !beforeIds.has(last.id)
      showFeedback(lastIsInsert
        ? tRef.current('common.importedNamed', { name: last.name })
        : tRef.current('common.updatedNamed', { name: last.name }))
      // Auto-scroll only when the batch collapsed to a single result —
      // for a 2+ file batch there is no single "the" imported row to
      // jump to (see the multi-import UX plan's no-auto-scroll
      // requirement), so leave the user's scroll position alone rather
      // than jumping to an arbitrary one of several new rows. Gated on
      // `originalCount`, NOT `results.length`: two files that both
      // overwrote the same existing pack still collapse `results` to a
      // single entry, but the user genuinely selected 2 files, so this
      // must still read as a batch (see the P1 "count/scroll uses
      // deduped set" fix note in useImportBatch.ts).
      if (originalCount <= 1) {
        scheduleScroll(`${rowTestidPrefixRef.current}-row-${last.id}`)
      }
    }
    const settled = queueRef.current.then(run, run)
    queueRef.current = settled.then(() => undefined, () => undefined)
    return settled
  }, [showFeedback, scheduleScroll])

  return { feedback, snapshotBeforeIds, snapshotEntries, place, placeMany }
}
