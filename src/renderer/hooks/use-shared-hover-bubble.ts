// SPDX-License-Identifier: GPL-2.0-or-later
//
// State + timer management for a SINGLE shared hover bubble reused across
// many hover targets — the keycode picker's key grid, its search result
// rows, the keyboard-layout picker's key tiles. Wrapping every one of
// those targets in its own `Tooltip` (portal + a few effects + a ref each)
// is fine for a handful of triggers but too costly when a screen can
// render hundreds of them at once (see TabbedKeycodes/PopoverTabKey/
// LayoutPickerContent's own perf-sensitive doc comments — this is the
// "canonicalized shared bubble" half of the tooltip-unification pass,
// as opposed to wrapping each target in `Tooltip` directly).
//
// Behavior mirrors `Tooltip.tsx`'s own contract even though the mechanism
// differs: `Tooltip` delays the CSS opacity transition so a fast hover
// never shows anything (mount stays, paint doesn't); this hook instead
// delays the STATE update itself (nothing mounts until the timer fires),
// which is the natural fit here since these call sites build their own
// bubble content function-by-function rather than rendering a fixed
// child. Either mechanism produces the same "no flash on a quick hover
// pass, close is instant" behavior from the user's perspective.

import { useCallback, useEffect, useRef, useState } from 'react'

/** Same default as `Tooltip.tsx`'s `openDelay` prop. Kept as its own
 *  constant (not imported from Tooltip.tsx) since these call sites don't
 *  render a `Tooltip` at all — this is a parallel, deliberately-matched
 *  value, not a shared prop default. */
export const SHARED_BUBBLE_OPEN_DELAY_MS = 300

export interface SharedHoverBubble<T> {
  /** The currently-shown hover target, or null while closed/pending. */
  target: T | null
  /** Call from the hovered element's mouse-enter handler. Schedules
   *  `target` to be set after `SHARED_BUBBLE_OPEN_DELAY_MS` — repeated
   *  calls (moving between adjacent targets) restart the timer, so only
   *  a genuine dwell opens the bubble. */
  show: (value: T) => void
  /** Call from the mouse-leave handler. Cancels any pending open and
   *  clears the bubble immediately — closing is never delayed. */
  hide: () => void
}

export function useSharedHoverBubble<T>(): SharedHoverBubble<T> {
  const [target, setTarget] = useState<T | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  const show = useCallback((value: T) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      setTarget(value)
    }, SHARED_BUBBLE_OPEN_DELAY_MS)
  }, [])

  const hide = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setTarget(null)
  }, [])

  return { target, show, hide }
}
