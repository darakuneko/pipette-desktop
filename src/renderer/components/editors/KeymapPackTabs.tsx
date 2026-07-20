// SPDX-License-Identifier: GPL-2.0-or-later
//
// Vertical tab strip shown to the left of the keymap surface whenever a
// permutation Key Label pack is active (Plan-qwerty-select-no-rewrite v7 —
// シミュレーションタブ方式, gated by `remapKind === 'simulated'` in
// `KeymapEditor`). Top button = the pack's own name (simulation, read-
// only); bottom button = "Base" (the real keymap, fully editable). Reuses
// the existing horizontal tab color/weight rule (`border-accent
// text-accent` active vs `text-content-secondary` inactive — see
// `PackTabButton`/`modal-tabs.tsx`) rotated onto the trailing edge, since
// the tabs sit to the LEFT of the content they select.

import { useTranslation } from 'react-i18next'

export type KeymapPackTab = 'pack' | 'base'

interface KeymapPackTabsProps {
  activeTab: KeymapPackTab
  onTabChange: (tab: KeymapPackTab) => void
  /** Display name of the active Key Label pack — the top tab's label. */
  packName: string
}

function tabButtonClass(active: boolean): string {
  const base = 'flex flex-1 items-center justify-center rounded-l-md border-r-2 px-2 py-2 text-center text-xs font-medium transition-colors'
  return active
    ? `${base} border-r-accent bg-surface-alt text-accent`
    : `${base} border-r-transparent text-content-secondary hover:text-content`
}

export function KeymapPackTabs({ activeTab, onTabChange, packName }: KeymapPackTabsProps): JSX.Element {
  const { t } = useTranslation()

  return (
    <div role="tablist" aria-label={t('keyLabels.keymapApply.tabsLabel')} className="flex w-20 shrink-0 flex-col gap-1 self-stretch" data-testid="keymap-pack-tabs">
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
