// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

/** Groups sequential indices into rows by their measured offsetTop — two
 *  words share a row iff they measured the same offsetTop (the browser lays
 *  every word of one flex-wrap row out at the same top). Pure so the greedy
 *  grouping — including the edge cases (no words, everything on one row) —
 *  is unit-testable without mounting a component. */
export function groupByOffsetTop(offsetTops: number[]): number[][] {
  const rows: number[][] = []
  let current: number[] = []
  let currentTop: number | null = null
  for (let i = 0; i < offsetTops.length; i++) {
    const top = offsetTops[i]
    if (current.length > 0 && top !== currentTop) {
      rows.push(current)
      current = []
    }
    current.push(i)
    currentTop = top
  }
  if (current.length > 0) rows.push(current)
  return rows
}

export interface VisualLines {
  /** Word-index groupings for each measured row, or null when inactive, not
   *  yet measured, or the container hasn't laid out (width 0 — e.g. jsdom,
   *  or before the first paint). Callers fall back to the flat word-flow
   *  layout when null. */
  lines: number[][] | null
  /** Attach to the invisible mirror container: same width/font/flex-wrap as
   *  the real words row, containing one plain `data-mirror-word` span per
   *  word (see `TypingTestView`). */
  mirrorRef: RefObject<HTMLDivElement | null>
}

/** Measures word-wrap row boundaries for monkeytype modes (words/time/quote
 *  — whenever `state.lineBreaks` is empty) via a hidden DOM mirror rather
 *  than a canvas/character-ratio estimate: the mirror shares the exact
 *  font-mono / flex-wrap / gap classes with the real words row, so it
 *  reproduces CJK widths, kerning, and zoom exactly — the same flex
 *  algorithm the browser already ran for the real content.
 *
 *  Recomputed only on word-list identity change, font-size change, or
 *  container width change (ResizeObserver — a no-op shim under jsdom), plus
 *  one initial measurement on mount. Never per keystroke: none of those
 *  three change while a run is in progress. `active` gates every effect —
 *  callers pass `false` whenever real line breaks are already present
 *  (tatoeba/fileImport), skipping the measurement entirely. */
export function useVisualLines(
  containerRef: RefObject<HTMLDivElement | null>,
  words: string[],
  fontSize: number,
  active: boolean,
): VisualLines {
  const mirrorRef = useRef<HTMLDivElement>(null)
  const [lines, setLines] = useState<number[][] | null>(null)

  const measure = useCallback(() => {
    if (!active) {
      setLines(null)
      return
    }
    const container = containerRef.current
    const mirror = mirrorRef.current
    if (!container || !mirror) return
    // Not laid out yet (pre-paint, or jsdom — which never lays elements
    // out) — keep the flat fallback deterministic rather than grouping
    // every word onto one bogus zero-offset row.
    if (container.getBoundingClientRect().width === 0) {
      setLines(null)
      return
    }
    const spans = mirror.querySelectorAll<HTMLElement>('[data-mirror-word]')
    // Mirror content is rendered from the same `words` this measurement
    // call closed over; a length mismatch means a stale render slipped in
    // between commit and this effect — skip and wait for the next one
    // rather than grouping against out-of-sync spans.
    if (spans.length !== words.length) return
    setLines(groupByOffsetTop(Array.from(spans, (span) => span.offsetTop)))
  }, [active, containerRef, words.length])

  // `active` flipping, word-list identity change, or font-size change → one
  // remeasure (or, if now inactive, a clear — both handled inside `measure`
  // itself) once the mirror has re-rendered with the new content.
  useLayoutEffect(() => {
    measure()
  }, [measure, words, fontSize])

  // Container width change (window resize, sidebar toggle, etc.) →
  // remeasure. jsdom's ResizeObserver is a no-op shim, so this never fires
  // in tests — the initial useLayoutEffect above is what those rely on.
  useEffect(() => {
    if (!active) return
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver(() => measure())
    observer.observe(container)
    return () => observer.disconnect()
  }, [active, containerRef, measure])

  return { lines, mirrorRef }
}
