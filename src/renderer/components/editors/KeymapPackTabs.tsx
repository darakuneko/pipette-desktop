// SPDX-License-Identifier: GPL-2.0-or-later
//
// Vertical index-tab strip shown to the right of the keymap surface
// whenever a permutation Key Label pack is active (Plan-qwerty-select-
// no-rewrite v7 — シミュレーションタブ方式, gated by `remapKind ===
// 'simulated'` in `KeymapEditor`). Top button = the pack's own name
// (simulation, read-only); bottom button = "Base" (the real keymap, fully
// editable). Styled like a paper file-divider index tab: narrow, attached
// flush to the keymap pane's edge (see the `flex items-stretch` wrapper in
// `KeymapEditor`), with the label rotated 90° via `writing-mode`. Reuses
// the existing tab color/weight rule (`border-accent text-accent` active
// vs `text-content-secondary` inactive — see `PackTabButton`/
// `modal-tabs.tsx`), with the connecting border moved onto each tab's
// LEADING (left) edge since the tabs sit to the RIGHT of the content they
// select.

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
  // than one continuous column.
  const base = 'flex w-7 items-center justify-center whitespace-nowrap rounded-r-md border-l-2 px-1 py-2 text-center text-xs font-medium transition-colors [writing-mode:vertical-rl]'
  return active
    ? `${base} border-l-accent bg-surface-alt text-accent`
    : `${base} border-l-transparent bg-surface-dim text-content-secondary hover:text-content`
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
