// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { type Keycode, getKeycodeRevision, isBasic, getAvailableLMMods } from '../../../shared/keycodes/keycodes'
import { KEYCODE_CATEGORIES, type KeycodeCategory, type KeycodeGroup } from './categories'
import { X } from 'lucide-react'
import { KeycodeButton } from './KeycodeButton'

const LM_CATEGORY: KeycodeCategory = {
  id: 'lm-mods',
  labelKey: 'keycodes.modifiers',
  getKeycodes: getAvailableLMMods,
}

const TOOLTIP_VERTICAL_GAP = 4

interface TooltipState {
  keycode: Keycode
  top: number
  left: number
  containerWidth: number
}

interface Props {
  onKeycodeSelect?: (keycode: Keycode) => void
  onKeycodeMultiSelect?: (keycode: Keycode, event: { ctrlKey: boolean; shiftKey: boolean }, tabKeycodes: Keycode[]) => void
  pickerSelectedKeycodes?: Set<string>
  onBackgroundClick?: () => void
  onClose?: () => void
  highlightedKeycodes?: Set<string>
  maskOnly?: boolean // When true, only show keycodes with value < 0xFF (for mask inner byte editing)
  lmMode?: boolean  // When true, show MOD_* keycodes for LM inner editing
  tabFooterContent?: Record<string, React.ReactNode> // Tab-specific footer content keyed by tab ID
  tabBarRight?: React.ReactNode // Content rendered at the right end of the tab bar
  showHint?: boolean // Show multi-select usage hint at the bottom
}

export function TabbedKeycodes({ onKeycodeSelect, onKeycodeMultiSelect, pickerSelectedKeycodes, onBackgroundClick, onClose, highlightedKeycodes, maskOnly = false, lmMode = false, tabFooterContent, tabBarRight, showHint = false }: Props) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState('basic')
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)

  // Clamp tooltip horizontally after render so it never overflows the container
  useLayoutEffect(() => {
    const el = tooltipRef.current
    if (!el || !tooltip) return
    const w = el.offsetWidth
    const clampedLeft = Math.max(0, Math.min(tooltip.left - w / 2, tooltip.containerWidth - w))
    el.style.left = `${clampedLeft}px`
  }, [tooltip])

  const handleBackgroundClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!(e.target as Element).closest('button')) onBackgroundClick?.()
    },
    [onBackgroundClick],
  )

  const isVisible = useCallback(
    (kc: Keycode): boolean => !kc.hidden && (!maskOnly || lmMode || isBasic(kc.qmkId)),
    [maskOnly, lmMode],
  )

  const revision = getKeycodeRevision()

  const categories = useMemo(
    () => lmMode
      ? [LM_CATEGORY]
      : KEYCODE_CATEGORIES.filter((c) => c.getKeycodes().some(isVisible)),
    [lmMode, isVisible, revision],
  )

  const activeTabKeycodes = useMemo(() => {
    const cat = categories.find((c) => c.id === activeTab)
    if (!cat) return []
    const groups = cat.getGroups?.()?.filter((g) => g.keycodes.some(isVisible))
    if (!groups) return cat.getKeycodes().filter(isVisible)
    return groups.flatMap((g) =>
      g.sections
        ? g.sections.flatMap((s) => s.filter(isVisible))
        : g.keycodes.filter(isVisible),
    )
  }, [categories, activeTab, isVisible, revision])

  // Reset active tab if it no longer exists in the filtered categories
  useEffect(() => {
    if (categories.length > 0 && !categories.some((c) => c.id === activeTab)) {
      setActiveTab(categories[0].id)
      setTooltip(null)
    }
  }, [categories, activeTab])

  const handleKeycodeHover = useCallback(
    (kc: Keycode, rect: DOMRect) => {
      const containerRect = containerRef.current?.getBoundingClientRect()
      if (!containerRect) return
      setTooltip({
        keycode: kc,
        top: rect.top - containerRect.top,
        left: rect.left - containerRect.left + rect.width / 2,
        containerWidth: containerRect.width,
      })
    },
    [],
  )

  const handleKeycodeHoverEnd = useCallback(() => {
    setTooltip(null)
  }, [])

  const handleKeycodeClick = useCallback(
    (kc: Keycode, event: React.MouseEvent) => {
      const isModified = event.ctrlKey || event.metaKey || event.shiftKey
      if (isModified && onKeycodeMultiSelect) {
        onKeycodeMultiSelect(kc, { ctrlKey: event.ctrlKey || event.metaKey, shiftKey: event.shiftKey }, activeTabKeycodes)
      } else {
        onKeycodeSelect?.(kc)
      }
    },
    [onKeycodeMultiSelect, onKeycodeSelect, activeTabKeycodes],
  )

  function renderKeycodeGrid(keycodes: Keycode[]): React.ReactNode {
    return (
      <div className="flex flex-wrap gap-1">
        {keycodes.filter(isVisible).map((kc) => (
          <KeycodeButton
            key={kc.qmkId}
            keycode={kc}
            onClick={handleKeycodeClick}
            onHover={handleKeycodeHover}
            onHoverEnd={handleKeycodeHoverEnd}
            highlighted={highlightedKeycodes?.has(kc.qmkId)}
            selected={pickerSelectedKeycodes?.has(kc.qmkId)}
          />
        ))}
      </div>
    )
  }

  function renderGroup(group: KeycodeGroup, hint?: string): React.ReactNode {
    return (
      <div key={group.labelKey}>
        <h4 className="text-xs font-normal text-content-muted px-1 pt-2 pb-1">
          {t(group.labelKey)}{hint && ` - ${hint}`}
        </h4>
        {group.sections ? (
          <div className="space-y-1">
            {group.sections
              .filter((s) => s.some(isVisible))
              .map((section, i) => (
                <div key={i}>{renderKeycodeGrid(section)}</div>
              ))}
          </div>
        ) : (
          renderKeycodeGrid(group.keycodes)
        )}
      </div>
    )
  }

  function renderCategoryContent(category: KeycodeCategory): React.ReactNode {
    const groups = category.getGroups?.()?.filter((g) => g.keycodes.some(isVisible))
    if (!groups) {
      return renderKeycodeGrid(category.getKeycodes().filter(isVisible))
    }

    const hint = category.hintKey ? t(category.hintKey) : undefined
    let hintUsed = false
    const rows: KeycodeGroup[][] = []
    for (const group of groups) {
      const prev = rows[rows.length - 1]
      if (prev != null && group.layoutRow != null && prev[0].layoutRow === group.layoutRow) {
        prev.push(group)
      } else {
        rows.push([group])
      }
    }
    return rows.map((row) => (
      <div key={row[0].labelKey} className="flex gap-x-3">
        {row.map((group) => {
          const groupHint = !hintUsed && hint ? hint : undefined
          if (groupHint) hintUsed = true
          return renderGroup(group, groupHint)
        })}
      </div>
    ))
  }

  return (
    <div
      ref={containerRef}
      className="relative flex flex-col rounded-[10px] border border-edge bg-picker-bg min-h-0 flex-1"
      onClick={handleBackgroundClick}
    >
      {/* Tab bar */}
      <div className="flex border-b border-edge-subtle px-3 pt-1">
        <div className="flex gap-0.5 overflow-x-auto">
          {categories.map((cat) => (
            <button
              key={cat.id}
              type="button"
              className={`whitespace-nowrap px-3 py-1.5 text-xs transition-colors border-b-2 ${
                activeTab === cat.id
                  ? 'border-b-accent text-accent font-semibold'
                  : 'border-b-transparent text-content-secondary hover:text-content'
              }`}
              onClick={() => { setActiveTab(cat.id); setTooltip(null) }}
            >
              {t(cat.labelKey)}
            </button>
          ))}
        </div>
        {(tabBarRight || onClose) && (
          <div className="ml-auto mb-1.5 flex shrink-0 items-center gap-2 self-center">
            {tabBarRight}
            {onClose && (
              <button
                type="button"
                data-testid="tabbed-keycodes-close"
                className="rounded p-1 text-content-secondary hover:bg-surface-dim hover:text-content"
                onClick={onClose}
                aria-label={t('common.close')}
              >
                <X size={16} aria-hidden="true" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Keycodes — all tabs rendered in a single grid cell; inactive tabs are
          invisible but still contribute to layout, keeping the height stable.
          Each tab scrolls independently so only overflowing tabs show a scrollbar. */}
      <div className="grid grid-rows-1 min-h-0 flex-1 overflow-hidden p-2">
        {categories.map((cat) => (
          <div
            key={cat.id}
            className={`col-start-1 row-start-1 overflow-y-auto ${cat.id === activeTab ? '' : 'invisible'}`}
          >
            {renderCategoryContent(cat)}
          </div>
        ))}
      </div>

      {/* Tooltip — rendered outside the scroll container to avoid clipping */}
      {tooltip && (
        <div
          ref={tooltipRef}
          className="pointer-events-none absolute z-50 rounded-md border border-edge bg-surface-alt px-2.5 py-1.5 shadow-lg"
          style={{
            top: tooltip.top - TOOLTIP_VERTICAL_GAP,
            left: tooltip.left,
            transform: 'translateY(-100%)',
          }}
        >
          <div className="text-[10px] leading-snug text-content-muted whitespace-nowrap">
            {tooltip.keycode.qmkId}
          </div>
          {tooltip.keycode.tooltip && (
            <div className="text-xs font-medium text-content whitespace-nowrap">
              {tooltip.keycode.tooltip}
            </div>
          )}
        </div>
      )}

      {tabFooterContent?.[activeTab] && (
        <div className="border-t border-edge-subtle px-3 py-2">
          {tabFooterContent[activeTab]}
        </div>
      )}

      {showHint && (
        <p className="px-3 pb-1.5 text-[11px] text-content-muted">
          {t('editor.keymap.pickerHint')}
        </p>
      )}
    </div>
  )
}
