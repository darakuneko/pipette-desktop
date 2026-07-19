// SPDX-License-Identifier: GPL-2.0-or-later

import type { ReactNode } from 'react'
import type { HubCategory } from '../../../shared/hub-urls'
import { PackHubEmptyState } from './PackHubEmptyState'

export interface PackHubTabProps<TRow> {
  rows: TRow[]
  /** Must return an element with its own `key` set (matches the row's
   * previous inline `key={...}` on the mapped JSX). */
  renderRow: (row: TRow) => ReactNode
  hubSearched: boolean
  emptyText: string
  emptyTestid: string
  hubOrigin: string
  category: HubCategory
  initialLinkTestid: string
}

/**
 * Hub tab body shared by Language Packs and Theme Packs: an empty-state
 * hint/message, or the list of Hub result rows. Key Labels keeps its
 * own HubTable (its empty state and row list share one container
 * instead of an early return, and its wrapper carries an extra
 * `text-sm` class), so it is not routed through this component.
 */
export function PackHubTab<TRow>({
  rows,
  renderRow,
  hubSearched,
  emptyText,
  emptyTestid,
  hubOrigin,
  category,
  initialLinkTestid,
}: PackHubTabProps<TRow>): JSX.Element {
  if (rows.length === 0) {
    return (
      <PackHubEmptyState
        as="p"
        className="py-4 text-center text-sm text-content-muted"
        testid={emptyTestid}
        hubSearched={hubSearched}
        emptyText={emptyText}
        hubOrigin={hubOrigin}
        category={category}
        initialLinkTestid={initialLinkTestid}
      />
    )
  }
  return <div className="space-y-2">{rows.map(renderRow)}</div>
}
