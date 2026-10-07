// SPDX-License-Identifier: GPL-2.0-or-later
//
// Per-row edit state (a rename draft, a delete confirmation) outlives its row
// when a sync merge removes the row. Clearing it keeps a stale draft from
// reopening, or committing on blur, if a row with that id shows up again.

import { useEffect } from 'react'
import { useLatestRef } from './use-latest-ref'

export interface RowEditState<TId extends string | number> {
  /** Row the state belongs to, or null when nothing is pending. */
  id: TId | null
  clear: () => void
}

/** Clears every `edits` entry whose row is missing from `ids`. Runs when
 *  `ids` changes, so pass a memoized array. */
export function useDropVanishedEdits<TId extends string | number>(
  ids: readonly TId[],
  edits: readonly RowEditState<TId>[],
): void {
  const editsRef = useLatestRef(edits)

  useEffect(() => {
    const present = new Set<TId>(ids)
    for (const edit of editsRef.current) {
      if (edit.id !== null && !present.has(edit.id)) edit.clear()
    }
  }, [ids, editsRef])
}
