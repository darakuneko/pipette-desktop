// SPDX-License-Identifier: GPL-2.0-or-later
//
// Vertical index-tab strip shown to the right of the keymap surface
// whenever a permutation Key Label pack is active (Plan-qwerty-select-
// no-rewrite v7 — シミュレーションタブ方式, gated by `remapKind ===
// 'simulated'` in `KeymapEditor`). Top button = the pack's own name
// (simulation, read-only); bottom button = "Base" (the real keymap, fully
// editable). Styled like a paper file-divider index tab: narrow, attached
// flush to the keymap pane's edge (see the `flex items-stretch` wrapper in
// `KeymapEditor`), with the label rotated 90° via `writing-mode`.
//
// Outline: every tab's outer (top/right/bottom) sides borrow the keymap
// pane's own `border-2 border-edge-subtle` (see `KeyboardPane`'s
// `PANE_CLASS`) so the "ear" sticking out past the pane reads as one
// continuous stroke rather than a second, competing outline. Both tabs
// (active AND inactive) drop their inner (left) border entirely and
// overlap the pane's border by the same 2px via `-ml-0.5` — this is what
// keeps requirement 1 (one unbroken stroke, never a doubled/thicker line)
// true regardless of active state: the pane's own right border, for the
// vertical span a tab covers, is painted over by that tab's background
// (later in DOM order) rather than sitting beside a second border of its
// own. The two states differ ONLY in fill: the active tab's
// `bg-surface-alt` matches the pane's interior, so the overlap is
// invisible and the tab reads as a literal extension of the panel; the
// inactive tab's dimmer `bg-surface-dim` still covers the same border
// line cleanly, just with a visible color step — reading as a separate,
// recessed sticky rather than a doubled outline. `text-accent` is the
// sole remaining active-state indicator now that the border itself is
// identical in both states (same convention as `PackTabButton`/
// `modal-tabs.tsx`).

import { useTranslation } from 'react-i18next'

export type KeymapPackTab = 'pack' | 'base'

interface KeymapPackTabsProps {
  activeTab: KeymapPackTab
  onTabChange: (tab: KeymapPackTab) => void
  /** Display name of the active Key Label pack — the top tab's label. */
  packName: string
}

function tabButtonClass(active: boolean): string {
  // `[writing-mode:vertical-rl]` flows the label top-to-bottom with each
  // glyph rotated 90° (default `text-orientation: mixed` upright-only for
  // CJK) — the real look of a paper index tab's sideways label. Width is
  // sized to the rotated text alone (`w-7` = 28px), not stretched to fill
  // the pane's height, so each tab reads as its own small sticky rather
  // than one continuous column. No left border on either state — `-ml-0.5`
  // (2px, matching the pane's `border-2`) overlaps the pane's own right
  // border instead of drawing a second one beside it, which is what keeps
  // the junction a single stroke in both states (see the file-level
  // comment for the full merge rationale).
  const base = 'flex w-7 -ml-0.5 items-center justify-center whitespace-nowrap rounded-r-md border-t-2 border-r-2 border-b-2 border-edge-subtle px-1 py-2 text-center text-xs font-medium transition-colors [writing-mode:vertical-rl]'
  return active
    ? `${base} bg-surface-alt text-accent`
    : `${base} bg-surface-dim text-content-secondary hover:text-content`
}

export function KeymapPackTabs({ activeTab, onTabChange, packName }: KeymapPackTabsProps): JSX.Element {
  const { t } = useTranslation()

  return (
    // `pt-3` (12px) clears the keymap pane's `rounded-xl` (12px) top-right
    // corner so the top tab starts below the curve instead of colliding
    // with it. No `gap-*` between the two buttons — they sit flush against
    // each other, like real stacked index tabs.
    <div role="tablist" aria-label={t('keyLabels.keymapApply.tabsLabel')} className="flex w-7 shrink-0 flex-col self-start pt-3" data-testid="keymap-pack-tabs">
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === 'pack'}
        className={tabButtonClass(activeTab === 'pack')}
        onClick={() => onTabChange('pack')}
        data-testid="keymap-pack-tab-simulation"
      >
        {packName}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === 'base'}
        className={tabButtonClass(activeTab === 'base')}
        onClick={() => onTabChange('base')}
        data-testid="keymap-pack-tab-base"
      >
        {t('keyLabels.keymapApply.baseTab')}
      </button>
    </div>
  )
}
