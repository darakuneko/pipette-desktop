// SPDX-License-Identifier: GPL-2.0-or-later
//
// One entry hover bubble per key picker. Every tile of every grid in the
// picker (`TileGrids.tsx`) shares the same two mouse handlers, which read
// the entry from the tile's `data-entry-kind` / `data-entry-index`. The
// bubble state lives in `TileEntryHoverBubble`, rendered once inside the
// picker (`TabbedKeycodes`), so opening or closing the bubble re-renders
// only that component — never the grids or the component that built them.
// Unmounting it with the picker drops a pending open and a shown bubble.

import { useLayoutEffect, useMemo, useRef, type MouseEvent, type RefObject } from 'react'
import type { HoverEntryKind, HoverEntrySources } from './hover-entry'
import { useEntryHover, type UseEntryHoverReturn } from './use-entry-hover'
import { EntryHoverBubble } from './EntryHoverBubble'

export interface TileHoverHandlers {
  onMouseEnter: (e: MouseEvent<HTMLElement>) => void
  onMouseLeave: () => void
}

type BubbleControls = Pick<UseEntryHoverReturn, 'showEntry' | 'hide'>

export interface TileEntryHover {
  /** Spread onto every tile. Referentially stable. */
  handlers: TileHoverHandlers
  /** Cancels a pending open and closes the bubble. Referentially stable. */
  hide: () => void
  /** Set by the mounted `TileEntryHoverBubble`; null while none is. */
  controlsRef: RefObject<BubbleControls | null>
}

export function useTileEntryHover(): TileEntryHover {
  const controlsRef = useRef<BubbleControls | null>(null)
  return useMemo(() => {
    const hide = (): void => { controlsRef.current?.hide() }
    const onMouseEnter = (e: MouseEvent<HTMLElement>): void => {
      const { entryKind, entryIndex } = e.currentTarget.dataset
      // A tile without the attributes resolves to no entry and just closes.
      controlsRef.current?.showEntry(entryKind as HoverEntryKind, Number(entryIndex), e.currentTarget.getBoundingClientRect())
    }
    return { handlers: { onMouseEnter, onMouseLeave: hide }, hide, controlsRef }
  }, [])
}

interface TileEntryHoverBubbleProps {
  hover: TileEntryHover
  sources: HoverEntrySources
  enabled: boolean
}

export function TileEntryHoverBubble({ hover, sources, enabled }: TileEntryHoverBubbleProps): JSX.Element {
  const { bubble, showEntry, hide } = useEntryHover(sources, enabled)
  const { controlsRef } = hover
  useLayoutEffect(() => {
    const controls = { showEntry, hide }
    controlsRef.current = controls
    return () => {
      if (controlsRef.current === controls) controlsRef.current = null
    }
  }, [controlsRef, showEntry, hide])
  return <EntryHoverBubble bubble={bubble} />
}
