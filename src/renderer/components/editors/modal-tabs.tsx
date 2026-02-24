// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'

export type ModalTabId = 'tools' | 'data' | 'notification' | 'about'

export type DataModalTabId = 'tapDance' | 'macro' | 'combo' | 'keyOverride' | 'altRepeatKey' | 'hubPost'

const TAB_BASE = 'px-4 py-2 text-[13px] font-medium transition-colors border-b-2'

function tabClass(active: boolean): string {
  if (active) return `${TAB_BASE} border-b-accent text-content`
  return `${TAB_BASE} border-b-transparent text-content-muted hover:text-content`
}

export interface TabDef<T extends string = string> {
  id: T
  labelKey: string
}

interface ModalTabBarProps<T extends string = string> {
  tabs: readonly TabDef<T>[]
  activeTab: T
  onTabChange: (id: T) => void
  idPrefix: string
  testIdPrefix: string
}

export function ModalTabBar<T extends string = string>({ tabs, activeTab, onTabChange, idPrefix, testIdPrefix }: ModalTabBarProps<T>) {
  const { t } = useTranslation()

  return (
    <div role="tablist" className="flex px-5 border-b border-edge shrink-0" data-testid={`${testIdPrefix}-tabs`}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          id={`${idPrefix}-tab-${tab.id}`}
          type="button"
          role="tab"
          aria-selected={activeTab === tab.id}
          aria-controls={activeTab === tab.id ? `${idPrefix}-panel-${tab.id}` : undefined}
          className={tabClass(activeTab === tab.id)}
          onClick={() => onTabChange(tab.id)}
          data-testid={`${testIdPrefix}-tab-${tab.id}`}
        >
          {t(tab.labelKey)}
        </button>
      ))}
    </div>
  )
}

interface ModalTabPanelProps<T extends string = string> {
  activeTab: T
  idPrefix: string
  children: React.ReactNode
}

export function ModalTabPanel<T extends string = string>({ activeTab, idPrefix, children }: ModalTabPanelProps<T>) {
  return (
    <div
      role="tabpanel"
      id={`${idPrefix}-panel-${activeTab}`}
      aria-labelledby={`${idPrefix}-tab-${activeTab}`}
      className="flex-1 overflow-y-auto px-5 pb-5"
    >
      {children}
    </div>
  )
}
