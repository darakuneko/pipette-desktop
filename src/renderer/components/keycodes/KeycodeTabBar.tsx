// SPDX-License-Identifier: GPL-2.0-or-later

import { useId, useMemo, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { ICON_MD, SEGMENT_TOGGLE_ACTIVE, SEGMENT_TOGGLE_INACTIVE } from '../../constants/ui-tokens'
import { Tooltip } from '../ui/Tooltip'
import type { KeycodeCategory } from './categories'
import { KEYBOARD_TAB_ID } from './keycode-tab-order'
import { useKeycodeTabReorder } from './use-keycode-tab-reorder'

export interface KeycodeTabBarProps {
  categories: KeycodeCategory[]
  effectiveTab: string
  selectTab: (id: string) => void
  keyboardTabAvailable: boolean
  tabBarRight?: ReactNode
  onClose?: () => void
  /** Lets the user reorder the tabs (long-press, Shift+F10 or ContextMenu
   *  on a tab). Every bar shows the saved order either way. */
  reorderable?: boolean
}

const TAB_BASE = 'whitespace-nowrap px-3 py-1.5 text-xs transition-colors border-b-2'
const TAB_ACTIVE = 'border-b-accent text-accent font-semibold'
const TAB_INACTIVE = 'border-b-transparent text-content-secondary hover:text-content'
// Outline only: an outline takes no layout space, so entering the mode
// under a held pointer never moves the tabs.
const TAB_REORDERING = 'cursor-grab outline outline-1 outline-dashed -outline-offset-1'

/** The tab bar at the top of `TabbedKeycodes`: one tab per category, the
 *  optional "Keyboard" tab, the right-hand slot (`tabBarRight` + close) and,
 *  in reorder mode, the hint / Reset / Done row below the tabs.
 *  Tabs are shown in the per-keyboard saved order; `TabbedKeycodes` keeps
 *  using the canonical order for selection and content. */
export function KeycodeTabBar({
  categories,
  effectiveTab,
  selectTab,
  keyboardTabAvailable,
  tabBarRight,
  onClose,
  reorderable = false,
}: KeycodeTabBarProps) {
  const { t } = useTranslation()
  const barRef = useRef<HTMLDivElement>(null)
  const hintId = useId()

  const labelKeys = useMemo(() => {
    const keys = new Map(categories.map((c) => [c.id, c.labelKey]))
    if (keyboardTabAvailable) keys.set(KEYBOARD_TAB_ID, 'editor.keymap.keyboardTab')
    return keys
  }, [categories, keyboardTabAvailable])
  const visibleIds = useMemo(() => [...labelKeys.keys()], [labelKeys])

  const reorder = useKeycodeTabReorder({
    enabled: reorderable,
    visibleIds,
    barRef,
    onSelectTab: selectTab,
    describeMove: (id, position, total) =>
      t('editor.keymap.tabReorder.moved', { name: t(labelKeys.get(id) ?? id), position, total }),
    enterMessage: t('editor.keymap.tabReorder.hint'),
  })

  function tabClassName(id: string): string {
    const state = effectiveTab === id ? TAB_ACTIVE : TAB_INACTIVE
    if (!reorder.active) return `${TAB_BASE} ${state}`
    const outline = reorder.dropTargetId === id && reorder.dragId !== id ? 'outline-accent' : 'outline-edge'
    return `${TAB_BASE} ${state} ${TAB_REORDERING} ${outline} ${reorder.dragId === id ? 'opacity-50' : ''}`
  }

  return (
    <div ref={barRef}>
      <div className="flex border-b border-edge-subtle px-3 pt-1">
        <div className="flex gap-0.5 overflow-x-auto">
          {reorder.orderedIds.map((id) => (
            <button
              key={id}
              type="button"
              className={tabClassName(id)}
              aria-describedby={reorder.active ? hintId : undefined}
              aria-keyshortcuts={reorderable && !reorder.active ? 'Shift+F10' : undefined}
              {...reorder.tabProps(id)}
            >
              {t(labelKeys.get(id) ?? id)}
            </button>
          ))}
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
      {reorderable && <span className="sr-only" aria-live="polite">{reorder.announcement}</span>}
      {/* Below the tabs, so opening it under a held pointer moves no tab. */}
      {reorder.active && (
        <div className="flex items-center gap-2 border-b border-edge-subtle px-3 py-1">
          <span id={hintId} className="text-xs text-content-muted">{t('editor.keymap.tabReorder.hint')}</span>
          <Tooltip content={t('editor.keymap.tabReorder.resetLabel')} wrapperClassName="ml-auto">
            <button
              type="button"
              data-tab-reorder-action=""
              data-testid="keycode-tab-reorder-reset"
              className={`${SEGMENT_TOGGLE_INACTIVE} disabled:opacity-50 disabled:cursor-not-allowed`}
              disabled={!reorder.canReset}
              onClick={reorder.reset}
            >
              {t('common.reset')}
            </button>
          </Tooltip>
          <button
            type="button"
            data-tab-reorder-action=""
            data-testid="keycode-tab-reorder-done"
            className={SEGMENT_TOGGLE_ACTIVE}
            onClick={reorder.exit}
          >
            {t('common.done')}
          </button>
        </div>
      )}
    </div>
  )
}
