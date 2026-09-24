// SPDX-License-Identifier: GPL-2.0-or-later
//
// State for the entry hover bubble: one shared bubble per surface (a key
// picker's tile tabs, the editable keymap pane), opened after the shared
// 300 ms dwell. The bubble reads its entry from the current `sources` on every
// render, so an edit to the hovered entry shows up right away and an entry
// that stops being configured closes it.

import { useCallback, useEffect, useMemo } from 'react'
import { useSharedHoverBubble } from '../../hooks/use-shared-hover-bubble'
import { useLatestRef } from '../../hooks/use-latest-ref'
import { resolveHoverEntry, type HoverEntry, type HoverEntryKind, type HoverEntrySources } from './hover-entry'

export interface EntryHoverBubbleState {
  index: number
  entry: HoverEntry
  /** Viewport rect of the hovered tile / key the bubble anchors to. */
  rect: DOMRect
}

export interface UseEntryHoverReturn {
  /** The bubble to show, or null. */
  bubble: EntryHoverBubbleState | null
  /** Schedules the bubble for entry `index` of `kind`, or closes it when
   *  that entry is missing, not configured or the hover is turned off.
   *  Referentially stable. */
  showEntry: (kind: HoverEntryKind, index: number, rect: DOMRect) => void
  /** Cancels a pending open and closes the bubble. Referentially stable. */
  hide: () => void
}

interface Target {
  kind: HoverEntryKind
  index: number
  rect: DOMRect
}

export function useEntryHover(sources: HoverEntrySources, enabled: boolean): UseEntryHoverReturn {
  const { target, show, hide } = useSharedHoverBubble<Target>()

  // Read through a ref so `showEntry` keeps one identity across edits — it
  // reaches memoized key / encoder widgets.
  const latestRef = useLatestRef({ sources, enabled })

  const showEntry = useCallback((kind: HoverEntryKind, index: number, rect: DOMRect) => {
    const s = latestRef.current
    if (!s.enabled || !resolveHoverEntry(s.sources, kind, index)) {
      hide()
      return
    }
    show({ kind, index, rect })
  }, [latestRef, show, hide])

  // Turning the hover off drops a pending open as well as a shown bubble.
  useEffect(() => {
    if (!enabled) hide()
  }, [enabled, hide])

  const value = target && enabled ? resolveHoverEntry(sources, target.kind, target.index)?.value : undefined
  // Kept stable while the target and the entry's own data are, so the
  // bubble only re-measures when something it shows changed. `value` was
  // resolved for `target.kind`, so the pair is a valid `HoverEntry`.
  const bubble = useMemo(
    () => (target && value ? { index: target.index, entry: { kind: target.kind, value } as HoverEntry, rect: target.rect } : null),
    [target, value],
  )
  return { bubble, showEntry, hide }
}
