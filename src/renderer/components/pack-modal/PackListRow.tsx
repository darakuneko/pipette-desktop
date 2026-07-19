// SPDX-License-Identifier: GPL-2.0-or-later
//
// Shared "one entry" row scaffold for the three pack modals' Installed
// tab. Two shapes exist, differing only in their inner content layout
// (both now support the same drag-grip `sideColumn` + `draggable`
// wiring, per Phase 2 — see the plan's note that the shapes would
// converge once reorder landed everywhere):
//   - "stacked" (Language Packs, Theme Packs): first line has an
//     inline leading control (select circle) + name + metadata
//     columns + primary actions, second line has the result badge +
//     Hub action buttons.
//   - "sideColumn" (Key Labels): first line has name + metadata
//     columns + primary actions (no inline leading control — Key
//     Labels has no per-row "active" selection), second line is fully
//     custom (its "has a Hub post" and "no Hub post" variants use
//     different wrapper classes, so it is passed through as-is rather
//     than decomposed into badge/hubActions).
//
// Phase 3 may unify the second line further (Delete cascade, Updated
// column, Author/isMine) — the shape discriminator still isn't
// load-bearing API, just today's cheapest way to keep three rows'
// worth of pre-existing markup pixel-identical.

import type { ReactNode } from 'react'

export interface PackListRowProps {
  testid: string
  shape?: 'stacked' | 'sideColumn'
  /** Stacked shape only: highlights the active/selected entry. */
  active?: boolean
  /** Full-height leading column (drag grip). Builtin / non-store rows
   *  (English, the theme selector bar) have no store entry to drag and
   *  omit this — see each modal for which rows opt in. */
  sideColumn?: ReactNode
  draggable?: boolean
  onDragStart?: () => void
  onDragOver?: () => void
  onDragEnd?: () => void
  /** Stacked shape only: inline slot before the name (select circle). */
  leadingControl?: ReactNode
  name: ReactNode
  /** Metadata columns rendered after the name in the first line. */
  columns?: ReactNode
  /** Primary row actions (Export/Delete or its confirm pair). */
  actions: ReactNode
  /** Stacked shape only: composed into the shared second-line wrapper. */
  badge?: ReactNode
  hubActions?: ReactNode
  /** sideColumn shape only: fully custom second-line content. */
  secondLine?: ReactNode
}

export function PackListRow({
  testid,
  shape = 'stacked',
  active,
  sideColumn,
  draggable,
  onDragStart,
  onDragOver,
  onDragEnd,
  leadingControl,
  name,
  columns,
  actions,
  badge,
  hubActions,
  secondLine,
}: PackListRowProps): JSX.Element {
  const dragProps = draggable ? {
    draggable: true,
    onDragOver: (e: React.DragEvent<HTMLDivElement>) => { e.preventDefault(); onDragOver?.() },
    onDrop: (e: React.DragEvent<HTMLDivElement>) => { e.preventDefault() },
    onDragStart: (e: React.DragEvent<HTMLDivElement>) => {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', '')
      onDragStart?.()
    },
    onDragEnd: () => { onDragEnd?.() },
  } : {}

  if (shape === 'sideColumn') {
    return (
      <div
        className="flex rounded border border-edge bg-surface"
        data-testid={testid}
        {...dragProps}
      >
        {sideColumn}
        <div className="flex-1 min-w-0 px-3 py-2">
          <div className="flex items-center gap-3">
            <div className="flex-1 min-w-0 text-sm font-medium">{name}</div>
            {columns}
            {actions}
          </div>
          {secondLine}
        </div>
      </div>
    )
  }

  return (
    <div
      className={`flex rounded border bg-surface ${active ? 'border-accent' : 'border-edge'}`}
      data-testid={testid}
      {...dragProps}
    >
      {sideColumn}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex items-center gap-3 px-3 py-2">
          {leadingControl}
          <div className="flex-1 min-w-0 text-sm font-medium">{name}</div>
          {columns}
          {actions}
        </div>
        <div className="flex items-center gap-3 px-3 pb-2">
          <span className="flex-1 min-w-0">{badge}</span>
          {hubActions}
        </div>
      </div>
    </div>
  )
}
