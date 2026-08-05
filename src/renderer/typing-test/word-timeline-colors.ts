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
  /** i18n key for this entry's former parenthetical explanation — now
   *  shown via a hover tooltip on the label instead of inline text (see
   *  `LegendSwatch` in KeystrokeTimelinePanel.tsx). Undefined for entries
   *  whose head word alone was already the whole label (`normal`,
   *  `mistake`, `leadIn`). */
  tooltipKey?: string
}

/** Legend entries in on-screen order — `WordTimelineView` maps over this
 *  instead of hand-maintaining one `LegendSwatch` per kind in JSX. */
export const TIMELINE_LEGEND: Record<TimelineFillKind, TimelineLegendEntry> = {
  normal: { swatchClass: 'bg-accent', labelKey: 'editor.typingTest.history.timeline.legend.normal' },
  mistake: { swatchClass: 'bg-danger', labelKey: 'editor.typingTest.history.timeline.legend.mistake' },
  overlap: {
    swatchClass: 'bg-warning',
    labelKey: 'editor.typingTest.history.timeline.legend.overlap',
    tooltipKey: 'editor.typingTest.history.timeline.legend.overlapTooltip',
  },
  unjudged: {
    swatchClass: 'bg-content-muted',
    labelKey: 'editor.typingTest.history.timeline.legend.unjudged',
    tooltipKey: 'editor.typingTest.history.timeline.legend.unjudgedTooltip',
  },
  blank: {
    swatchClass: 'bg-content-muted opacity-40',
    labelKey: 'editor.typingTest.history.timeline.legend.blank',
    tooltipKey: 'editor.typingTest.history.timeline.legend.blankTooltip',
  },
  leadIn: { swatchClass: 'bg-edge-strong', labelKey: 'editor.typingTest.history.timeline.legend.leadIn' },
}

/** Fill for a word-boundary divider inside a LINE row's SVG strip
 *  (`LineTimelineRow.tsx`) — purely structural (marks where one word's
 *  keystrokes end and the next begins on the line's shared axis), not a
 *  semantic "kind" like the ones above, so it has no `TIMELINE_LEGEND`
 *  entry of its own. Uses the same subtle hairline-divider token
 *  `style.css` reserves for this purpose elsewhere (`--color-edge-subtle`). */
export const WORD_SEPARATOR_FILL = 'var(--color-edge-subtle)'

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

/** Per-fill-kind label TEXT color for the LINE view's on-bar keystroke
 *  labels (`LineTimelineRow.tsx`) — same philosophy as `KeyWidget`'s
 *  `FILL_INVERT_TABLE`: every fill a
 *  keystroke can render as gets an explicit, theme-aware class instead of
 *  one default that quietly breaks on fills bright enough to need dark
 *  text. `normal`/`mistake` are safe with the plain inverse token in both
 *  themes — their fills (`accent`/`danger`) swap SATURATION, not
 *  lightness, across the theme pair, so `content-inverse`'s own light/dark
 *  flip already lands on a readable color both times. `overlap` (warning)
 *  and `unjudged` (muted) don't get that lucky symmetry:
 *  - `unjudged`'s fill (`content-muted`) is lighter in the light theme and
 *    darker in the dark theme — exactly the shape `text-content` (not
 *    `-inverse`) already flips to match, so it needs no `dark:` override.
 *  - `overlap`'s fill (`warning`) is a MID orange in light but a bright
 *    yellow in dark (`--warning` actually gets LIGHTER in dark mode, the
 *    one fill that doesn't track the usual "brighten for dark bg"
 *    pattern) — both instances need dark text, so this is the one entry
 *    that pins to `text-content` unconditionally in the base class and
 *    overrides to `content-inverse` under `dark:` (which happens to also
 *    resolve dark, since `content-inverse` itself is near-black in the
 *    dark theme).
 *  Expressed purely as Tailwind classes (`dark:` variant) rather than a
 *  JS theme read — the row picks up the right color for free from
 *  whichever CSS rule matches, the same way the SVG fills above already
 *  do via CSS custom properties. */
export const TIMELINE_LABEL_CLASS: Record<'normal' | 'mistake' | 'overlap' | 'unjudged', string> = {
  normal: 'text-content-inverse',
  mistake: 'text-content-inverse',
  overlap: 'text-content dark:text-content-inverse',
  unjudged: 'text-content',
}

/** Mirrors `fillForKeystroke`'s own branching (see its doc comment for
 *  the priority order) — returns the on-bar label's text color class
 *  instead of the bar's own fill. */
export function labelClassForKeystroke(seg: KeystrokeSegment): string {
  if (seg.overlapped === true) return TIMELINE_LABEL_CLASS.overlap
  if (seg.correct === false) return TIMELINE_LABEL_CLASS.mistake
  if (seg.correct === undefined) return TIMELINE_LABEL_CLASS.unjudged
  return TIMELINE_LABEL_CLASS.normal
}
