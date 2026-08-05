// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { findKeycode, type Keycode, getKeycodeRevision, isBasic, getAvailableLMMods, deserialize } from '../../../shared/keycodes/keycodes'
import { parseKle } from '../../../shared/kle/kle-parser'
import type { BasicViewType, SplitKeyMode } from '../../../shared/types/app-config'
import { useAppConfig } from '../../hooks/useAppConfig'
import { KEYCODE_CATEGORIES, groupByLayoutRow, type KeycodeCategory, type KeycodeGroup } from './categories'
import { getLayoutsForViewType } from './display-keyboard-defs'
import { X } from 'lucide-react'
import { ICON_MD } from '../../constants/ui-tokens'
import { UpwardSelect } from '../UpwardSelect'
import { KeycodeGrid } from './KeycodeGrid'
import { BasicKeyboardView } from './BasicKeyboardView'
import { isShiftedKeycode, getShiftedKeycode } from './SplitKey'
import { BUBBLE_BASE, computeBubblePosition } from '../ui/Tooltip'
import { useSharedHoverBubble } from '../../hooks/use-shared-hover-bubble'

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

// Shared bubble contract: 8px
// offset, `computeBubblePosition` viewport clamping, `BUBBLE_BASE` skin,
// 300ms open delay via `useSharedHoverBubble`. A canonicalized shared
// bubble rather than per-key `Tooltip` wraps — every category's key grid
// mounts simultaneously (inactive tabs stay in the DOM, just visually
// hidden, to keep tab-switch instant and preserve scroll position), so a
// per-key `Tooltip` would multiply its portal + effects across hundreds
// of tiles that are never all visible at once.
interface TooltipState {
  keycode: Keycode
  rect: DOMRect
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
  onBasicViewTypeChange?: (v: BasicViewType) => void
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
  onBasicViewTypeChange,
  splitKeyMode,
  remapLabel,
}: Props) {
  const { t } = useTranslation()
  const { config } = useAppConfig()
  const resolvedBasicViewType = basicViewType ?? config.defaultBasicViewType
  const resolvedSplitKeyMode = splitKeyMode ?? config.defaultSplitKeyMode
  const basicViewOptions = useMemo(() => [
    { id: 'ansi', name: t('settings.basicViewTypeAnsi') },
    { id: 'iso', name: t('settings.basicViewTypeIso') },
    { id: 'jis', name: t('settings.basicViewTypeJis') },
    { id: 'list', name: t('settings.basicViewTypeList') },
  ], [t])
  const [activeTab, setActiveTab] = useState('basic')
  const { target: tooltip, show: showTooltip, hide: hideTooltip } = useSharedHoverBubble<TooltipState>()
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number } | null>(null)
  const tooltipId = useId()
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

  // Position the bubble centered above the hovered key, clamped to the
  // VIEWPORT (not just this container) so it never clips at the screen's
  // left/right edge — same contract every canonical `Tooltip` follows.
  useLayoutEffect(() => {
    const el = tooltipRef.current
    if (!el || !tooltip) { setTooltipPos(null); return }
    setTooltipPos(computeBubblePosition(
      tooltip.rect,
      el.getBoundingClientRect(),
      'top',
      'center',
      8,
      { width: window.innerWidth, height: window.innerHeight },
    ))
  }, [tooltip])

  // Enter key confirms current selection and closes the picker.
  // Always block the browser's native "Enter re-clicks the focused button"
  // for buttons inside the picker surface — otherwise picking a keycode
  // leaves that tile focused and a subsequent Enter silently inserts the
  // same keycode again. Buttons outside the picker (e.g. the modal's
  // Save/Cancel) still let native Enter→click through.
  //
  // When onConfirm is provided, Enter also commits (TapDance / Combo / etc.
  // use this for the "press Enter to close" UI hint).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return
      const el = e.target as HTMLElement | null
      if (el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.isContentEditable) return
      if (el?.tagName === 'BUTTON' && !containerRef.current?.contains(el)) return
      e.preventDefault()
      onConfirm?.()
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

  // Whether the special "keyboard" tab is currently shown at all. Kept as a
  // plain boolean (not the keyboardPickerContent node itself) so effectiveTab
  // below only recomputes when availability actually flips, not on every
  // parent re-render that hands us a fresh JSX reference.
  const keyboardTabAvailable = Boolean(keyboardPickerContent) && !maskOnly

  // activeTab records only the tab the user last explicitly picked; it is
  // never rewritten by availability changes. effectiveTab is the derived
  // value actually used for rendering: if activeTab is temporarily
  // unavailable (e.g. maskOnly narrowing categories, or the keyboard tab
  // disappearing), it falls back to the first category, and automatically
  // snaps back to activeTab once that tab becomes available again.
  const effectiveTab = useMemo(() => {
    const available = activeTab === 'keyboard' ? keyboardTabAvailable : categories.some((c) => c.id === activeTab)
    if (available) return activeTab
    return categories[0]?.id ?? activeTab
  }, [activeTab, categories, keyboardTabAvailable])

  const { activeTabKeycodes, keycodeIndexMap } = useMemo(() => {
    const cat = categories.find((c) => c.id === effectiveTab)
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
  }, [categories, effectiveTab, isVisible, revision, resolvedBasicViewType, maskOnly, lmMode, useSplit])

  // Clear any open tooltip whenever the rendered tab changes, whether from a
  // user click or an automatic fallback/restore driven by effectiveTab.
  useEffect(() => {
    hideTooltip()
  }, [effectiveTab, hideTooltip])

  const selectTab = useCallback(
    (id: string) => {
      onTabChange?.()
      setActiveTab(id)
      hideTooltip()
    },
    [onTabChange, hideTooltip],
  )

  const handleKeycodeHover = useCallback(
    (kc: Keycode, rect: DOMRect) => {
      showTooltip({ keycode: kc, rect })
    },
    [showTooltip],
  )

  const handleKeycodeHoverEnd = useCallback(() => {
    hideTooltip()
  }, [hideTooltip])

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
    const isActive = !tabId || tabId === effectiveTab
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
    const isActive = category.id === effectiveTab
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
      className="relative flex flex-col rounded-xl border border-edge bg-picker-bg min-h-0 flex-1"
      data-testid="tabbed-keycodes-root"
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
                effectiveTab === cat.id
                  ? 'border-b-accent text-accent font-semibold'
                  : 'border-b-transparent text-content-secondary hover:text-content'
              }`}
              onClick={() => selectTab(cat.id)}
            >
              {t(cat.labelKey)}
            </button>
          ))}
          {keyboardPickerContent && !maskOnly && (
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

      {/* Content area below tab bar — relative container for panel overlay */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Keycodes — all tabs rendered in a single grid cell; inactive tabs are
            invisible but still contribute to layout, keeping the height stable.
            Each tab scrolls independently so only overflowing tabs show a scrollbar. */}
        <div className="grid grid-rows-1 min-h-0 flex-1 overflow-hidden p-2">
          {categories.map((cat) => (
            <div
              key={cat.id}
              className={`col-start-1 row-start-1 overflow-y-auto ${cat.id === effectiveTab ? '' : 'invisible'}`}
            >
              {renderCategoryContent(cat)}
            </div>
          ))}
          {keyboardPickerContent && !maskOnly && (
            <div
              key="keyboard"
              className={`col-start-1 row-start-1 flex min-h-0 flex-col ${effectiveTab === 'keyboard' ? '' : 'invisible'}`}
            >
              {keyboardPickerContent}
            </div>
          )}
        </div>

        {tabFooterContent?.[effectiveTab] && (
          <div className="border-t border-edge-subtle px-3 py-2">
            {tabFooterContent[effectiveTab]}
          </div>
        )}

        {(showHint || (effectiveTab === 'basic' && onBasicViewTypeChange)) && (
          <div className="flex items-center justify-between px-3 pb-1.5">
            {showHint && (
              <p className="text-xs text-content-muted">{t('editor.keymap.pickerHint')}</p>
            )}
            {effectiveTab === 'basic' && onBasicViewTypeChange && (
              <UpwardSelect
                aria-label={t('editorSettings.basicViewType')}
                value={resolvedBasicViewType}
                options={basicViewOptions}
                onChange={(v) => onBasicViewTypeChange(v as BasicViewType)}
              />
            )}
          </div>
        )}

        {panelOverlay}
      </div>

      {/* Tooltip — rendered outside the scroll container to avoid clipping.
          `BUBBLE_BASE` already positions `fixed`, so this needs no
          container-relative math (unlike the old absolute-positioned
          version) — `tooltipPos` is computed straight from the hovered
          key's own viewport rect via `computeBubblePosition`. */}
      {tooltip && (
        <div
          ref={tooltipRef}
          role="tooltip"
          id={tooltipId}
          className={BUBBLE_BASE}
          style={{
            top: tooltipPos?.top ?? tooltip.rect.top,
            left: tooltipPos?.left ?? tooltip.rect.left,
          }}
        >
          <div className="text-2xs leading-snug text-content-muted whitespace-nowrap">
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
