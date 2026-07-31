// SPDX-License-Identifier: GPL-2.0-or-later
// Semantic fills (+ legend swatch classes) for the word-timeline SVG
// strips. Same idiom as `KeyWidget`'s color constants
// (`components/keyboard/constants.ts`): a CSS custom-property reference
// string passed straight to SVG `fill`, so no hex ever appears in JSX and
// both themes stay correct for free. Kept out of `word-timeline.ts` (the
// pure, zoom-independent model) since FILL is presentation, not model
// data — unlike a keystroke's tooltip `label`, which DOES live in the
// model (`resolveLabel`, computed once per `buildWordTimeline` call)
// rather than being re-derived on every hover.

import type { KeystrokeSegment } from './word-timeline'

/** The finite set of visual "kinds" a timeline bar/marker can render as —
 *  shared by `TIMELINE_FILL` (SVG fill) and `TIMELINE_LEGEND` (swatch
 *  class + label) so the two can never drift: adding a kind to one
 *  without the other is a compile error. */
export type TimelineFillKind = 'normal' | 'mistake' | 'overlap' | 'unjudged' | 'blank' | 'leadIn'

export const TIMELINE_FILL: Record<TimelineFillKind, string> = {
  normal: 'var(--color-accent)',
  mistake: 'var(--color-danger)',
  overlap: 'var(--color-warning)',
  unjudged: 'var(--color-content-muted)',
  blank: 'var(--color-content-muted)',
  leadIn: 'var(--color-edge-strong)',
}

export interface TimelineLegendEntry {
  /** Tailwind class for the legend's small swatch square — kept
   *  separate from `TIMELINE_FILL` since a Tailwind bg-* utility and an
   *  SVG `fill` CSS-var reference aren't interchangeable, and `blank`
   *  needs an extra opacity modifier its swatch fill doesn't. */
  swatchClass: string
  labelKey: string
}

/** Legend entries in on-screen order — `WordTimelineView` maps over this
 *  instead of hand-maintaining one `LegendSwatch` per kind in JSX. */
export const TIMELINE_LEGEND: Record<TimelineFillKind, TimelineLegendEntry> = {
  normal: { swatchClass: 'bg-accent', labelKey: 'editor.typingTest.history.timeline.legend.normal' },
  mistake: { swatchClass: 'bg-danger', labelKey: 'editor.typingTest.history.timeline.legend.mistake' },
  overlap: { swatchClass: 'bg-warning', labelKey: 'editor.typingTest.history.timeline.legend.overlap' },
  unjudged: { swatchClass: 'bg-content-muted', labelKey: 'editor.typingTest.history.timeline.legend.unjudged' },
  blank: { swatchClass: 'bg-content-muted opacity-40', labelKey: 'editor.typingTest.history.timeline.legend.blank' },
  leadIn: { swatchClass: 'bg-edge-strong', labelKey: 'editor.typingTest.history.timeline.legend.leadIn' },
}

/** Priority order for a keystroke's fill when more than one condition
 *  applies (e.g. a mistake that also overlapped the previous key):
 *  overlap first (this view exists to make overlap visible even on an
 *  otherwise-correct press), then mistake, then "no verdict at all",
 *  then the plain default. Mirrors the legend's own ordering in the
 *  `history.timeline.legend` i18n block. */
export function fillForKeystroke(seg: KeystrokeSegment): string {
  if (seg.overlapped === true) return TIMELINE_FILL.overlap
  if (seg.correct === false) return TIMELINE_FILL.mistake
  if (seg.correct === undefined) return TIMELINE_FILL.unjudged
  return TIMELINE_FILL.normal
}
