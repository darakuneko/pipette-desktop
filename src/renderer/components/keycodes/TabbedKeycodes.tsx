// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { findKeycode, type Keycode, getKeycodeRevision, isBasic, getAvailableLMMods, deserialize } from '../../../shared/keycodes/keycodes'
import { parseKle } from '../../../shared/kle/kle-parser'
import type { BasicViewType, SplitKeyMode } from '../../../shared/types/app-config'
import { useAppConfig } from '../../hooks/useAppConfig'
import { KEYCODE_CATEGORIES, groupByLayoutRow, type KeycodeCategory, type KeycodeGroup } from './categories'
import { getLayoutsForViewType } from './display-keyboard-defs'
import { X } from 'lucide-react'
import { KeycodeGrid } from './KeycodeGrid'
import { BasicKeyboardView } from './BasicKeyboardView'
import { isShiftedKeycode, getShiftedKeycode } from './SplitKey'

export interface KeycodeIndexEntry { baseIdx: number; shiftedIdx?: number }

/** Expand a flat list of base keycodes: shifted first, then all in original order.
 *  Also builds an index map keyed by base qmkId. */
function expandGrouped(
  keycodes: Keycode[],
  startIdx: number,
  indexMap: Map<string, KeycodeIndexEntry>,
): Keycode[] {
  let idx = startIdx
  const shiftedPairs: { shifted: Keycode; baseQmkId: string; shiftedIdx: number }[] = []
  for (const kc of keycodes) {
    const s = getShiftedKeycode(kc.qmkId)
    if (s) shiftedPairs.push({ shifted: s, baseQmkId: kc.qmkId, shiftedIdx: idx++ })
  }
  const expanded: Keycode[] = shiftedPairs.map((p) => p.shifted)
  for (const kc of keycodes) {
    const pair = shiftedPairs.find((p) => p.baseQmkId === kc.qmkId)
    indexMap.set(kc.qmkId, { baseIdx: idx, shiftedIdx: pair?.shiftedIdx })
    expanded.push(kc)
    idx++
  }
  return expanded
}

/** Expand layout keycodes per physical row using KLE positions.
 *  For each row: shifted in X order, then ALL keys in X order.
 *  Also builds an index map keyed by base qmkId. */
function expandPerRow(
  keycodes: Keycode[],
  kleData: unknown[][],
  startIdx: number,
  indexMap: Map<string, KeycodeIndexEntry>,
): Keycode[] {
  const kle = parseKle(kleData)
  const kcSet = new Set(keycodes.map((k) => k.qmkId))
  const rows = new Map<number, { kc: Keycode; x: number }[]>()
  for (const key of kle.keys) {
    const qmkId = key.labels[0]
    if (!qmkId || !kcSet.has(qmkId)) continue
    const kc = keycodes.find((k) => k.qmkId === qmkId)
    if (!kc) continue
    const y = Math.round(key.y * 2) / 2
    if (!rows.has(y)) rows.set(y, [])
    rows.get(y)!.push({ kc, x: key.x })
  }

  let idx = startIdx
  const expanded: Keycode[] = []
  const sortedRows = [...rows.entries()].sort((a, b) => a[0] - b[0])
  for (const [, keys] of sortedRows) {
    keys.sort((a, b) => a.x - b.x)
    // Record shifted indices first
    const shiftedMap = new Map<string, number>() // baseQmkId → shiftedIdx
    for (const k of keys) {
      const shifted = getShiftedKeycode(k.kc.qmkId)
      if (shifted) {
        shiftedMap.set(k.kc.qmkId, idx)
        expanded.push(shifted)
        idx++
      }
    }
    // Base line: ALL keys in X order
    for (const k of keys) {
      indexMap.set(k.kc.qmkId, { baseIdx: idx, shiftedIdx: shiftedMap.get(k.kc.qmkId) })
      expanded.push(k.kc)
      idx++
    }
  }
  return expanded
}

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
  onKeycodeDoubleClick?: (keycode: Keycode) => void
  onConfirm?: () => void // Confirm current selection (Enter key)
  onKeycodeMultiSelect?: (index: number, keycode: number, event: { ctrlKey: boolean; shiftKey: boolean }, tabKeycodeNumbers: number[]) => void
  pickerSelectedIndices?: Set<number>
  pickerMultiSelectEnabled?: boolean
  onBackgroundClick?: () => void
  onTabChange?: () => void
  onClose?: () => void
  highlightedKeycodes?: Set<string>
  maskOnly?: boolean // When true, only show keycodes with value < 0xFF (for mask inner byte editing)
  lmMode?: boolean  // When true, show MOD_* keycodes for LM inner editing
  tabFooterContent?: Record<string, React.ReactNode> // Tab-specific footer content keyed by tab ID
  tabBarRight?: React.ReactNode // Content rendered at the right end of the tab bar
  panelOverlay?: React.ReactNode // Content rendered as a right-side overlay over the keycodes grid
  showHint?: boolean // Show multi-select usage hint at the bottom
  keyboardPickerContent?: React.ReactNode // Keyboard layout picker shown in a "Keyboard" tab
  tabContentOverride?: Record<string, React.ReactNode> // Custom content that replaces the keycode grid for specific tabs
  basicViewType?: BasicViewType // View type for the basic tab
  splitKeyMode?: SplitKeyMode // 'split' (default) or 'flat' for individual buttons
  remapLabel?: (qmkId: string) => string
}

export function TabbedKeycodes({
  onKeycodeSelect,
  onKeycodeDoubleClick,
  onConfirm,
  onKeycodeMultiSelect,
  pickerSelectedIndices,
  pickerMultiSelectEnabled = false,
  onBackgroundClick,
  onTabChange,
  onClose,
  highlightedKeycodes,
  maskOnly = false,
  lmMode = false,
  tabFooterContent,
  tabBarRight,
  panelOverlay,
  showHint = false,
  keyboardPickerContent,
  tabContentOverride,
  basicViewType,
  splitKeyMode,
  remapLabel,
}: Props) {
  const { t } = useTranslation()
  const { config } = useAppConfig()
  const resolvedBasicViewType = basicViewType ?? config.defaultBasicViewType
  const resolvedSplitKeyMode = splitKeyMode ?? config.defaultSplitKeyMode
  const [activeTab, setActiveTab] = useState('basic')
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  // Guard against spurious double-clicks right after mount (layout shift can
  // cause the second click of an external double-click to land on a key tile)
  const mountTimeRef = useRef(Date.now())
  const MOUNT_DBLCLICK_GUARD_MS = 400
  const guardedDoubleClick = useMemo(() => {
    if (!onKeycodeDoubleClick) return undefined
    return (keycode: Keycode) => {
      if (Date.now() - mountTimeRef.current < MOUNT_DBLCLICK_GUARD_MS) return
      onKeycodeDoubleClick(keycode)
    }
  }, [onKeycodeDoubleClick])

  // Clamp tooltip horizontally after render so it never overflows the container
  useLayoutEffect(() => {
    const el = tooltipRef.current
    if (!el || !tooltip) return
    const w = el.offsetWidth
    const clampedLeft = Math.max(0, Math.min(tooltip.left - w / 2, tooltip.containerWidth - w))
    el.style.left = `${clampedLeft}px`
  }, [tooltip])

  // Enter key confirms current selection and closes the picker
  useEffect(() => {
    if (!onConfirm) return
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return
      const el = e.target as HTMLElement | null
      if (el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.tagName === 'BUTTON' || el?.isContentEditable) return
      e.preventDefault()
      onConfirm()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onConfirm])

  const handleBackgroundClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!(e.target as Element).closest('button')) onBackgroundClick?.()
    },
    [onBackgroundClick],
  )

  const useSplit = resolvedSplitKeyMode !== 'flat'

  const isVisible = useCallback(
    (kc: Keycode): boolean => {
      if (kc.hidden) return false
      if (maskOnly && !lmMode && !isBasic(kc.qmkId)) return false
      if (useSplit && isShiftedKeycode(kc.qmkId)) return false
      return true
    },
    [maskOnly, lmMode, useSplit],
  )

  const revision = getKeycodeRevision()

  const categories = useMemo(
    () => lmMode
      ? [LM_CATEGORY]
      : KEYCODE_CATEGORIES.filter((c) => c.getKeycodes().some(isVisible)),
    [lmMode, isVisible, revision],
  )

  const { activeTabKeycodes, keycodeIndexMap } = useMemo(() => {
    const cat = categories.find((c) => c.id === activeTab)
    if (!cat) return { activeTabKeycodes: [] as Keycode[], keycodeIndexMap: new Map<string, KeycodeIndexEntry>() }

    const indexMap = new Map<string, KeycodeIndexEntry>()

    // For keyboard views (ANSI/ISO/JIS), order by physical layout position
    if (cat.id === 'basic' && resolvedBasicViewType != null && resolvedBasicViewType !== 'list' && !lmMode) {
      const layouts = getLayoutsForViewType(resolvedBasicViewType)
      const kleLayout = parseKle(layouts[0].kle)
      const layoutKeycodes: Keycode[] = []
      const layoutIds = new Set<string>()
      for (const key of kleLayout.keys) {
        const qmkId = key.labels[0]
        if (!qmkId) continue
        const kc = findKeycode(qmkId)
        if (kc && isVisible(kc)) {
          layoutKeycodes.push(kc)
          layoutIds.add(qmkId)
        }
      }
      const groups = cat.getGroups?.(resolvedBasicViewType)?.filter((g) => g.keycodes.some(isVisible))
      const remainingGroups = groups
        ? groups.map((g) => g.keycodes.filter((kc) => !layoutIds.has(kc.qmkId) && isVisible(kc))).filter((arr) => arr.length > 0)
        : []
      const remaining = remainingGroups.flat()

      if (useSplit && !maskOnly) {
        const expandedLayout = expandPerRow(layoutKeycodes, layouts[0].kle, 0, indexMap)
        let offset = expandedLayout.length
        const expandedRemaining = remainingGroups.flatMap((g) => {
          const result = expandGrouped(g, offset, indexMap)
          offset += result.length
          return result
        })
        return { activeTabKeycodes: [...expandedLayout, ...expandedRemaining], keycodeIndexMap: indexMap }
      }

      const keycodes = [...layoutKeycodes, ...remaining]
      keycodes.forEach((kc, i) => indexMap.set(kc.qmkId, { baseIdx: i }))
      return { activeTabKeycodes: keycodes, keycodeIndexMap: indexMap }
    }

    // List/other tabs
    const groups = cat.getGroups?.()?.filter((g) => g.keycodes.some(isVisible))
    let keycodes: Keycode[]
    if (!groups) {
      keycodes = cat.getKeycodes().filter(isVisible)
    } else {
      keycodes = groups.flatMap((g) =>
        g.sections ? g.sections.flatMap((s) => s.filter(isVisible)) : g.keycodes.filter(isVisible),
      )
    }

    if (useSplit && !maskOnly) {
      let offset = 0
      if (groups) {
        const expanded = groups.flatMap((g) => {
          const visible = g.sections
            ? g.sections.flatMap((s) => s.filter(isVisible))
            : g.keycodes.filter(isVisible)
          const result = expandGrouped(visible, offset, indexMap)
          offset += result.length
          return result
        })
        return { activeTabKeycodes: expanded, keycodeIndexMap: indexMap }
      }
      return { activeTabKeycodes: expandGrouped(keycodes, 0, indexMap), keycodeIndexMap: indexMap }
    }

    keycodes.forEach((kc, i) => indexMap.set(kc.qmkId, { baseIdx: i }))
    return { activeTabKeycodes: keycodes, keycodeIndexMap: indexMap }
  }, [categories, activeTab, isVisible, revision, resolvedBasicViewType, maskOnly, lmMode, useSplit])

  // Reset active tab if it no longer exists in the filtered categories
  useEffect(() => {
    const keyboardHidden = activeTab === 'keyboard' && maskOnly
    if (categories.length > 0 && (keyboardHidden || (activeTab !== 'keyboard' && !categories.some((c) => c.id === activeTab)))) {
      setActiveTab(categories[0].id)
      setTooltip(null)
    }
  }, [categories, activeTab, maskOnly])

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

  const activeTabKeycodeNumbers = useMemo(
    () => activeTabKeycodes.map((kc) => deserialize(kc.qmkId)),
    [activeTabKeycodes],
  )

  const handleKeycodeClick = useCallback(
    (kc: Keycode, event: React.MouseEvent, index: number) => {
      const isModified = event.ctrlKey || event.metaKey || event.shiftKey
      if (isModified && onKeycodeMultiSelect) {
        if (!pickerMultiSelectEnabled) onBackgroundClick?.()
        onKeycodeMultiSelect(index, deserialize(kc.qmkId), { ctrlKey: event.ctrlKey || event.metaKey, shiftKey: event.shiftKey }, activeTabKeycodeNumbers)
      } else if (onKeycodeMultiSelect && pickerMultiSelectEnabled) {
        onKeycodeMultiSelect(index, deserialize(kc.qmkId), { ctrlKey: false, shiftKey: false }, activeTabKeycodeNumbers)
      } else {
        onKeycodeSelect?.(kc)
      }
    },
    [onKeycodeMultiSelect, onKeycodeSelect, activeTabKeycodeNumbers, pickerMultiSelectEnabled, onBackgroundClick],
  )

  function renderKeycodeGrid(keycodes: Keycode[], tabId?: string): React.ReactNode {
    const isActive = !tabId || tabId === activeTab
    return (
      <KeycodeGrid
        keycodes={keycodes}
        onClick={handleKeycodeClick}
        onDoubleClick={guardedDoubleClick}
        onHover={handleKeycodeHover}
        onHoverEnd={handleKeycodeHoverEnd}
        highlightedKeycodes={highlightedKeycodes}
        pickerSelectedIndices={isActive ? pickerSelectedIndices : undefined}
        isVisible={isVisible}
        splitKeyMode={maskOnly ? 'flat' : resolvedSplitKeyMode}
        remapLabel={remapLabel}
        keycodeIndexMap={keycodeIndexMap}
      />
    )
  }

  function renderGroup(group: KeycodeGroup, tabId?: string, hint?: string): React.ReactNode {
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
                <div key={i}>{renderKeycodeGrid(section, tabId)}</div>
              ))}
          </div>
        ) : (
          renderKeycodeGrid(group.keycodes, tabId)
        )}
      </div>
    )
  }

  function renderCategoryContent(category: KeycodeCategory): React.ReactNode {
    const isActive = category.id === activeTab
    // Keyboard view for basic tab (ANSI, ISO, or JIS)
    if (category.id === 'basic' && resolvedBasicViewType !== 'list' && resolvedBasicViewType != null && !lmMode) {
      return (
        <BasicKeyboardView
          viewType={resolvedBasicViewType}
          splitKeyMode={maskOnly ? 'flat' : resolvedSplitKeyMode}
          onKeycodeClick={handleKeycodeClick}
          onKeycodeDoubleClick={guardedDoubleClick}
          onKeycodeHover={handleKeycodeHover}
          onKeycodeHoverEnd={handleKeycodeHoverEnd}
          highlightedKeycodes={highlightedKeycodes}
          pickerSelectedIndices={isActive ? pickerSelectedIndices : undefined}
          isVisible={isVisible}
          remapLabel={remapLabel}
          keycodeIndexMap={keycodeIndexMap}
        />
      )
    }

    const override = tabContentOverride && Object.hasOwn(tabContentOverride, category.id) ? tabContentOverride[category.id] : null
    const groups = category.getGroups?.()?.filter((g) => g.keycodes.some(isVisible))

    // Override only — no groups to show below
    if (override && !groups?.length) return override

    // No override, no groups — fall back to flat keycode grid
    if (!override && !groups?.length) {
      return renderKeycodeGrid(category.getKeycodes().filter(isVisible), category.id)
    }

    const rows = groupByLayoutRow(groups ?? [])
    const groupContent = rows.map((row) => (
      <div key={row[0].labelKey} className="flex gap-x-3">
        {row.map((group) => {
          return renderGroup(group, category.id)
        })}
      </div>
    ))

    // Override + groups — render override above groups
    if (override) {
      return <>{override}{groupContent}</>
    }
    return groupContent
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
              onClick={() => { onTabChange?.(); setActiveTab(cat.id); setTooltip(null) }}
            >
              {t(cat.labelKey)}
            </button>
          ))}
          {keyboardPickerContent && !maskOnly && (
            <button
              key="keyboard"
              type="button"
              className={`whitespace-nowrap px-3 py-1.5 text-xs transition-colors border-b-2 ${
                activeTab === 'keyboard'
                  ? 'border-b-accent text-accent font-semibold'
                  : 'border-b-transparent text-content-secondary hover:text-content'
              }`}
              onClick={() => { onTabChange?.(); setActiveTab('keyboard'); setTooltip(null) }}
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
                <X size={16} aria-hidden="true" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Content area below tab bar — relative container for panel overlay */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
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
          {keyboardPickerContent && !maskOnly && (
            <div
              key="keyboard"
              className={`col-start-1 row-start-1 flex min-h-0 flex-col ${activeTab === 'keyboard' ? '' : 'invisible'}`}
            >
              {keyboardPickerContent}
            </div>
          )}
        </div>

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

        {panelOverlay}
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
    </div>
  )
}
