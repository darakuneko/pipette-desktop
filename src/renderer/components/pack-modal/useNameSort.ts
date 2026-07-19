// SPDX-License-Identifier: GPL-2.0-or-later
//
// Shared "Name" toolbar sort for the pack modals' Installed tab. Each
// click toggles ascending ⇄ descending and applies the sort to the
// PERSISTED order as a one-shot via the same `reorder` mechanism drag
// uses — drag, the sort button, and any dropdown consumer all stay
// consistent because there is exactly one source of order truth.
//
// The toggle direction is ephemeral per modal-open: a plain `useState`
// that starts at `'asc'` and is not persisted anywhere, matching the
// plan's "asc first click, desc second, asc third…" spec.
//
// Sort key is locale-aware display-name compare with `sensitivity:
// 'base'` — the same comparator Key Labels already uses to sort its
// Hub result rows (`buildHubRows` in `KeyLabelsModal.tsx`).

import { useState } from 'react'

export type SortDirection = 'asc' | 'desc'

export interface NameSortEntry {
  id: string
  name: string
}

export interface UseNameSortOptions {
  reorder: (orderedIds: string[]) => Promise<{ success: boolean; error?: string }>
  onError: (error: string | undefined) => void
}

export interface UseNameSortResult {
  /** The direction *last applied* (descriptive — matches the
   *  neighboring toolbar/tab buttons' `aria-pressed` convention of
   *  describing current state, not a preview of the next click).
   *  Seeded to `'desc'` internally so the very first click flips to
   *  `'asc'` and applies it, matching the plan's "asc first click,
   *  desc second, asc third…" spec; nothing has been sorted yet at
   *  that seed value, so it is never shown before the first click's
   *  own render (this hook has no "unsorted" display state to track). */
  direction: SortDirection
  pending: boolean
  /** Flips `direction`, sorts `entries` by the new direction, and
   *  persists the result via `reorder`. */
  toggle: (entries: NameSortEntry[]) => Promise<void>
}

export function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' })
}

export function useNameSort({ reorder, onError }: UseNameSortOptions): UseNameSortResult {
  const [direction, setDirection] = useState<SortDirection>('desc')
  const [pending, setPending] = useState(false)

  const toggle = async (entries: NameSortEntry[]): Promise<void> => {
    const nextDirection: SortDirection = direction === 'asc' ? 'desc' : 'asc'
    const sign = nextDirection === 'asc' ? 1 : -1
    const orderedIds = entries
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

  return { direction, pending, toggle }
}
