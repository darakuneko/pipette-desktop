// SPDX-License-Identifier: GPL-2.0-or-later
//
// Hover wiring for one picker tile grid (`TileGrids.tsx`): per-tile mouse
// handlers plus the grid's single shared `EntryHoverBubble`.

import { useMemo, type MouseEvent, type ReactNode } from 'react'
import type { HoverEntryKind, HoverEntrySources } from './hover-entry'
import { useEntryHover } from './use-entry-hover'
import { EntryHoverBubble } from './EntryHoverBubble'

export interface TileHoverProps {
  onMouseEnter?: (e: MouseEvent<HTMLElement>) => void
  onMouseLeave?: () => void
}

export interface TileHover {
  tileHoverProps: (index: number) => TileHoverProps
  bubble: ReactNode
}

export function useTileHover<K extends HoverEntryKind>(
  kind: K,
  entries: NonNullable<HoverEntrySources[K]>,
  enabled: boolean,
): TileHover {
  const sources = useMemo<HoverEntrySources>(() => ({ [kind]: entries }), [kind, entries])
  const { bubble, showEntry, hide } = useEntryHover(sources, enabled)
  const tileHoverProps = (index: number): TileHoverProps => (enabled
    ? { onMouseEnter: (e) => showEntry(kind, index, e.currentTarget.getBoundingClientRect()), onMouseLeave: hide }
    : {})
  return { tileHoverProps, bubble: <EntryHoverBubble bubble={bubble} /> }
}
