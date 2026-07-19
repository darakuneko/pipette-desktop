// SPDX-License-Identifier: GPL-2.0-or-later
//
// Shared "Name" toolbar sort for the pack modals' Installed tab.
// Three states:
//   - 'asc' / 'desc' — a sort is currently applied; clicking the button
//     toggles between the two, persisting the new order via the same
//     `reorder` mechanism drag uses (drag, the sort button, and any
//     dropdown consumer all stay consistent — one source of order truth).
//   - 'free' — the list is in some order the user arranged by hand
//     (drag), or an order that doesn't match either sort. There is no
//     click path back to 'free': it is only entered by a drag (see
//     `markFree`) or detected fresh when the modal opens.
//
// The state is DERIVED once per modal-open rather than stored anywhere:
// on open, the current reorderable list (whatever scope the sort
// applies to — includes QWERTY for Key Labels, excludes builtins for
// Language/Theme Packs) is compared against name-asc and name-desc
// sorted copies of itself. Equal to one → that state; equal to
// neither, or 0-1 items → 'free'. This runs exactly once per open
// session (not on every render, and not again while still open even if
// the list changes later) via React's documented "adjust state during
// rendering" pattern: a ref tracks whether the current open=true span
// has already been handled, so the conditional `setDirection` call
// below only ever fires on the first render after `open` flips to
// true — no `useEffect` round trip, so no stale-state flash.

import { useRef, useState } from 'react'

export type SortDirection = 'asc' | 'desc' | 'free'

export interface NameSortEntry {
  id: string
  name: string
}

export interface UseNameSortOptions {
  /** Whether the modal is currently open — gates the once-per-open
   *  state detection below. */
  open: boolean
  /** Whether the underlying store has finished its initial load (e.g.
   *  `!store.loading`). The modal can mount already `open` before the
   *  store's async metas load resolves; without this gate, detection
   *  would run against an empty list on that very first render, latch
   *  'free', and never re-derive for the rest of the open session (the
   *  once-per-open latch below only re-arms on close→reopen, not on
   *  data arriving mid-session). A genuinely empty *loaded* store still
   *  correctly derives 'free' via `detectSortState`'s `length <= 1` case. */
  ready: boolean
  /** The current reorderable list, in its persisted display order, at
   *  the moment the modal opens. Only read for that one-time detection;
   *  `toggle` takes its own (possibly fresher) entries argument. */
  entries: NameSortEntry[]
  reorder: (orderedIds: string[]) => Promise<{ success: boolean; error?: string }>
  onError: (error: string | undefined) => void
}

export interface UseNameSortResult {
  direction: SortDirection
  pending: boolean
  /** Flips 'asc' ⇄ 'desc' (from 'free', the first click lands on
   *  'asc'), sorts `entries` by the new direction, and persists the
   *  result via `reorder`. */
  toggle: (entries: NameSortEntry[]) => Promise<void>
  /** Called after a successful manual drag reorder — the list is now
   *  in an arbitrary, user-arranged order, so the triangle disappears
   *  until the button is clicked again or the modal is reopened. */
  markFree: () => void
}

export function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' })
}

function idsMatch(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

/**
 * Pure detection function, exported for direct unit testing of the
 * matrix (asc list / desc list / shuffled / 0-1 items) independent of
 * the hook's render-timing plumbing.
 *
 * A list whose names are all equal (any tie-only list, including
 * every 0-1-item list) matches both the asc- and desc-sorted copies of
 * itself, since a stable `Array.prototype.sort` leaves ties in their
 * original relative order in both directions. Asc is checked first, so
 * an all-equal list always resolves to 'asc' rather than 'free' — a
 * deliberate, documented convention (confirmed via review), not an
 * accidental fallthrough.
 */
export function detectSortState(entries: NameSortEntry[]): SortDirection {
  if (entries.length <= 1) return 'free'
  const ids = entries.map((e) => e.id)
  const ascIds = entries.slice().sort((a, b) => compareNames(a.name, b.name)).map((e) => e.id)
  if (idsMatch(ids, ascIds)) return 'asc'
  const descIds = entries.slice().sort((a, b) => -compareNames(a.name, b.name)).map((e) => e.id)
  if (idsMatch(ids, descIds)) return 'desc'
  return 'free'
}

export function useNameSort({ open, ready, entries, reorder, onError }: UseNameSortOptions): UseNameSortResult {
  const [direction, setDirection] = useState<SortDirection>('free')
  const [pending, setPending] = useState(false)
  const openHandledRef = useRef(false)

  if (open && ready && !openHandledRef.current) {
    openHandledRef.current = true
    const detected = detectSortState(entries)
    if (detected !== direction) setDirection(detected)
  } else if (!open && openHandledRef.current) {
    openHandledRef.current = false
  }

  const toggle = async (toggleEntries: NameSortEntry[]): Promise<void> => {
    const nextDirection: SortDirection = direction === 'asc' ? 'desc' : 'asc'
    const sign = nextDirection === 'asc' ? 1 : -1
    const orderedIds = toggleEntries
      .slice()
      .sort((a, b) => sign * compareNames(a.name, b.name))
      .map((entry) => entry.id)
    setDirection(nextDirection)
    setPending(true)
    try {
      const result = await reorder(orderedIds)
      if (!result.success) onError(result.error)
    } finally {
      setPending(false)
    }
  }

  const markFree = (): void => {
    setDirection('free')
  }

  return { direction, pending, toggle, markFree }
}
