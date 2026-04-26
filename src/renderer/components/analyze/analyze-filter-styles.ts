// SPDX-License-Identifier: GPL-2.0-or-later
// Shared Tailwind class strings for the Analyze filter row. Kept here
// so the snapshot select and the From / To / Device controls stay
// visually in sync when one of them is retouched.
//
// `FILTER_LABEL` uses `display: contents` so each label collapses out
// of the layout and the children (text span + control) participate
// directly as grid items. The shared parent grid keeps every label
// column and every control column line-aligned across rows even as
// per-tab filters wrap onto new rows.

export const FILTER_LABEL = 'contents text-[12px] text-content-muted'

export const FILTER_SELECT =
  'rounded-md border border-edge bg-surface px-2 py-1 text-[12px] text-content focus:border-accent focus:outline-none'

// Buttons that sit alongside FILTER_SELECT (export CSV etc). Mirrors the
// select frame so the row reads as a single visual group, with hover /
// disabled affordances added on top.
export const FILTER_BUTTON =
  `${FILTER_SELECT} transition-colors hover:bg-surface-dim disabled:cursor-not-allowed disabled:opacity-40`
