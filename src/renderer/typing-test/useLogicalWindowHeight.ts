// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import type { RefObject } from 'react'

/** Reading-window height (px) for `displayLines` LOGICAL lines, given each
 *  rendered row's measured bottom edge relative to the window's content top
 *  (natural/unscrolled layout position) in row order — real (tatoeba/
 *  fileImport) or synthetic (monkeytype, see useVisualLines) rows are the
 *  same shape. Returns the bottom of the min(displayLines, rowBottoms.length)
 *  -th row, but never shorter than `minHeight` (the existing --tt-lines CSS
 *  floor): short texts (fewer or shorter rows than displayLines) keep the
 *  blank-window minimum instead of shrinking. Falls back to `minHeight`
 *  outright when unmeasured (empty rowBottoms — jsdom, or before the first
 *  paint) — pixel-identical to the pre-logical-line-window fixed height.
 *  Pure so the edge cases are unit-testable without mounting a component. */
export function logicalWindowHeight(rowBottoms: number[], displayLines: number, minHeight: number): number {
  if (rowBottoms.length === 0) return minHeight
  const idx = Math.max(0, Math.min(displayLines, rowBottoms.length) - 1)
  return Math.max(minHeight, rowBottoms[idx])
}

/** Measures `[data-line-row]` elements inside `containerRef` (real or
 *  synthetic line rows — see TypingTestView) and derives the reading
 *  window's height from `logicalWindowHeight`, so the Lines setting counts
 *  LOGICAL lines (one wrapped sentence = one line) rather than visual rows.
 *  `null` `lines` (flat word-flow: unmeasured monkeytype, or jsdom) falls
 *  back to `minHeight` — the same fixed value the CSS --tt-lines var already
 *  produces, so the flat layout stays pixel-identical to before this
 *  feature existed.
 *
 *  Row bottoms are normalized against the container's own scrollTop
 *  (`getBoundingClientRect().bottom` reflects the current scroll-follow
 *  position, not the row's natural layout position) so a mid-run scroll
 *  never skews the measurement — this hook never depends on scroll
 *  position, only on `lines`/`displayLines`/`minHeight` identity and
 *  container width.
 *
 *  Recomputed on `lines` identity change, `displayLines`/`fontSize` (folded
 *  into `minHeight` by the caller) change, and container width change
 *  (ResizeObserver — a no-op shim under jsdom), mirroring useVisualLines's
 *  measurement triggers. Never per keystroke: rows are static per run —
 *  typed-state coloring (see WordDisplay) changes color/underline only,
 *  never font-weight/size, so a row never re-wraps mid-run. */
export function useLogicalWindowHeight(
  containerRef: RefObject<HTMLDivElement | null>,
  lines: number[][] | null,
  displayLines: number,
  minHeight: number,
): number {
  const [height, setHeight] = useState(minHeight)

  const measure = useCallback(() => {
    const container = containerRef.current
    if (!container || !lines) {
      setHeight(minHeight)
      return
    }
    const rows = container.querySelectorAll<HTMLElement>('[data-line-row]')
    if (rows.length === 0) {
      setHeight(minHeight)
      return
    }
    const containerTop = container.getBoundingClientRect().top
    const scrollTop = container.scrollTop
    const rowBottoms = Array.from(rows, (row) => row.getBoundingClientRect().bottom - containerTop + scrollTop)
    setHeight(logicalWindowHeight(rowBottoms, displayLines, minHeight))
  }, [containerRef, lines, displayLines, minHeight])

  // `lines` identity change (real regroup, or useVisualLines resolving/
  // reresolving) or `displayLines`/fontSize change (folded into `minHeight`)
  // → one remeasure, once the rows have rendered with the new content.
  useLayoutEffect(() => {
    measure()
  }, [measure])

  // Container width change (window resize, sidebar toggle, etc.) →
  // remeasure. jsdom's ResizeObserver is a no-op shim, so this never fires
  // in tests — the initial useLayoutEffect above is what those rely on.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver(() => measure())
    observer.observe(container)
    return () => observer.disconnect()
  }, [containerRef, measure])

  return height
}
