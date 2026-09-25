// SPDX-License-Identifier: GPL-2.0-or-later

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { ICON_MD } from '../../constants/ui-tokens'
import type { KeycodeCategory } from './categories'

export interface KeycodeTabBarProps {
  categories: KeycodeCategory[]
  effectiveTab: string
  selectTab: (id: string) => void
  keyboardTabAvailable: boolean
  tabBarRight?: ReactNode
  onClose?: () => void
}

/** The tab bar at the top of `TabbedKeycodes`: one tab per category, the
 *  optional "Keyboard" tab, and the right-hand slot (`tabBarRight` + close). */
export function KeycodeTabBar({
  categories,
  effectiveTab,
  selectTab,
  keyboardTabAvailable,
  tabBarRight,
  onClose,
}: KeycodeTabBarProps) {
  const { t } = useTranslation()
  return (
    <div className="flex border-b border-edge-subtle px-3 pt-1">
      <div className="flex gap-0.5 overflow-x-auto">
        {categories.map((cat) => (
          <button
            key={cat.id}
            type="button"
            className={`whitespace-nowrap px-3 py-1.5 text-xs transition-colors border-b-2 ${
              effectiveTab === cat.id
                ? 'border-b-accent text-accent font-semibold'
                : 'border-b-transparent text-content-secondary hover:text-content'
            }`}
            onClick={() => selectTab(cat.id)}
          >
            {t(cat.labelKey)}
          </button>
        ))}
        {keyboardTabAvailable && (
          <button
            key="keyboard"
            type="button"
            className={`whitespace-nowrap px-3 py-1.5 text-xs transition-colors border-b-2 ${
              effectiveTab === 'keyboard'
                ? 'border-b-accent text-accent font-semibold'
                : 'border-b-transparent text-content-secondary hover:text-content'
            }`}
            onClick={() => selectTab('keyboard')}
          >
            {t('editor.keymap.keyboardTab')}
          </button>
        )}
      </div>
      {(tabBarRight || onClose) && (
        <div className="ml-auto flex shrink-0 items-center gap-2 border-b-2 border-b-transparent py-1.5">
          {tabBarRight}
          {onClose && (
            <button
              type="button"
              data-testid="tabbed-keycodes-close"
              className="rounded p-1 text-content-secondary hover:bg-surface-dim hover:text-content"
              onClick={onClose}
              aria-label={t('common.close')}
            >
              <X size={ICON_MD} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
    </div>
  )
}
