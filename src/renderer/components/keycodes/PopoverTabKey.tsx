// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useRef, useCallback, useLayoutEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { type Keycode, getKeycodeRevision, serialize, isMask, findInnerKeycode, isBasic, isLMKeycode, getAvailableLMMods, extractBasicKey } from '../../../shared/keycodes/keycodes'
import { KEYCODE_CATEGORIES } from './categories'

interface SearchEntry {
  keycode: Keycode
  categoryId: string
  searchText: string
  /** Individual lowercased tokens for exact-match ranking */
  tokens: string[]
  detail: string
}

interface DetailTooltipState {
  text: string
  top: number
  left: number
  containerWidth: number
}

const TOOLTIP_VERTICAL_GAP = 4

/**
 * Strip text before and including the first underscore.
 * Only searches for underscores in the name portion before any parenthesized argument,
 * so "KC_A" -> "A", "KC_KP_SLASH" -> "KP_SLASH", but "LT0(KC_A)" is returned unchanged.
 */
function stripPrefix(id: string): string {
  const parenIdx = id.indexOf('(')
  const nameBeforeParen = parenIdx >= 0 ? id.substring(0, parenIdx) : id
  const underscoreIdx = nameBeforeParen.indexOf('_')
  return underscoreIdx >= 0 ? id.slice(underscoreIdx + 1) : id
}

interface Props {
  currentKeycode: number
  maskOnly?: boolean
  modMask?: number
  lmMode?: boolean
  basicKeyOnly?: boolean
  onKeycodeSelect: (kc: Keycode) => void
}

const MAX_RESULTS = 50

export function PopoverTabKey({ currentKeycode, maskOnly, modMask = 0, lmMode: lmModeProp, basicKeyOnly, onKeycodeSelect }: Props) {
  const hasModMask = modMask > 0
  const { t } = useTranslation()
  const initialQuery = useMemo(() => {
    // When modifier strip is active or in LT/SH_T mode, show the inner basic key
    if (modMask > 0 || basicKeyOnly) {
      const basicCode = extractBasicKey(currentKeycode)
      if (basicCode === 0) return ''
      return stripPrefix(serialize(basicCode))
    }
    // LM keycodes need special handling: when mod=0, serialize returns "LM0(0x0)"
    // and findInnerKeycode returns null, so the generic mask fallback would show
    // "LM0(0x0)" stripped instead of an empty search box.
    if (maskOnly && isLMKeycode(currentKeycode)) {
      const inner = findInnerKeycode(serialize(currentKeycode))
      return inner ? stripPrefix(inner.qmkId) : ''
    }
    const serialized = serialize(currentKeycode)
    if (isMask(serialized)) {
      if (maskOnly) {
        const inner = findInnerKeycode(serialized)
        return inner ? stripPrefix(inner.qmkId) : stripPrefix(serialized)
      }
      return serialized.substring(0, serialized.indexOf('('))
    }
    return stripPrefix(serialized)
  }, [currentKeycode, maskOnly, modMask, basicKeyOnly])
  const [query, setQuery] = useState(initialQuery)
  const [suppressResults, setSuppressResults] = useState(false)

  const lmMode = lmModeProp || (maskOnly && isLMKeycode(currentKeycode))

  const searchIndex = useMemo(() => {
    const entries: SearchEntry[] = []

    // LM inner: show modifier keycodes instead of basic keycodes
    if (lmMode) {
      for (const kc of getAvailableLMMods()) {
        const searchParts = [stripPrefix(kc.qmkId), kc.label, kc.tooltip].filter(Boolean)
        const tokens = searchParts.map((p) => p.toLowerCase())
        entries.push({
          keycode: kc,
          categoryId: 'lm-mods',
          searchText: tokens.join(' '),
          tokens,
          detail: [kc.qmkId, kc.tooltip].filter(Boolean).join(' \u00b7 '),
        })
      }
      return entries
    }

    for (const cat of KEYCODE_CATEGORIES) {
      for (const kc of cat.getKeycodes()) {
        if (kc.hidden) continue
        if ((maskOnly || hasModMask || basicKeyOnly) && !isBasic(kc.qmkId)) continue
        const extraAliases = kc.alias.slice(1)
        const searchParts = [
          stripPrefix(kc.qmkId),
          kc.label,
          ...kc.alias.map(stripPrefix),
          kc.tooltip,
        ].filter(Boolean)
        const detailParts = [kc.qmkId, kc.tooltip, ...extraAliases].filter(Boolean)
        const tokens = searchParts.map((p) => p.toLowerCase())
        entries.push({
          keycode: kc,
          categoryId: cat.id,
          searchText: tokens.join(' '),
          tokens,
          detail: detailParts.join(' \u00b7 '),
        })
      }
    }
    return entries
  }, [lmMode, maskOnly, hasModMask, basicKeyOnly, getKeycodeRevision()])

  const results = useMemo(() => {
    if (suppressResults) return []
    const q = query.trim().toLowerCase()
    if (!q) return []
    const exact: SearchEntry[] = []
    const partial: SearchEntry[] = []
    for (const e of searchIndex) {
      if (!e.searchText.includes(q)) continue
      if (e.tokens.includes(q)) exact.push(e)
      else partial.push(e)
    }
    return [...exact, ...partial].slice(0, MAX_RESULTS)
  }, [query, searchIndex, suppressResults])

  // Tooltip for truncated detail text (styled like key picker tooltip in TabbedKeycodes)
  const [tooltip, setTooltip] = useState<DetailTooltipState | null>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Clamp tooltip horizontally after render so it never overflows the container
  useLayoutEffect(() => {
    const el = tooltipRef.current
    if (!el || !tooltip) return
    const w = el.offsetWidth
    const clampedLeft = Math.max(0, Math.min(tooltip.left, tooltip.containerWidth - w))
    el.style.left = `${clampedLeft}px`
  }, [tooltip])

  const handleDetailMouseEnter = useCallback((e: React.MouseEvent<HTMLSpanElement>) => {
    const span = e.currentTarget
    if (span.scrollWidth <= span.clientWidth) return
    const containerRect = containerRef.current?.getBoundingClientRect()
    if (!containerRect) return
    const spanRect = span.getBoundingClientRect()
    setTooltip({
      text: span.textContent ?? '',
      top: spanRect.top - containerRect.top,
      left: spanRect.left - containerRect.left,
      containerWidth: containerRect.width,
    })
  }, [])

  const handleDetailMouseLeave = useCallback(() => setTooltip(null), [])

  return (
    <div ref={containerRef} className="relative flex flex-col gap-2">
      <input
        type="text"
        value={query}
        onChange={(e) => { setSuppressResults(false); setQuery(e.target.value) }}
        placeholder={t('editor.keymap.keyPopover.searchPlaceholder')}
        className="w-full rounded border border-edge bg-surface px-2.5 py-1.5 text-sm focus:border-accent focus:outline-none"
        autoFocus
        data-testid="popover-search-input"
      />
      <div className="max-h-[240px] overflow-y-auto" onScroll={handleDetailMouseLeave}>
        {query.trim() && results.length === 0 && (
          <div className="px-2 py-3 text-center text-xs text-content-muted">
            {suppressResults
              ? t('editor.keymap.keyPopover.keySelected', { key: query })
              : t('editor.keymap.keyPopover.noResults')}
          </div>
        )}
        {results.map((entry) => (
          <button
            key={`${entry.categoryId}-${entry.keycode.qmkId}`}
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-dim"
            onClick={() => { setTooltip(null); onKeycodeSelect(entry.keycode); setSuppressResults(true); setQuery(entry.keycode.label) }}
            data-testid={`popover-result-${entry.keycode.qmkId}`}
          >
            <span className="min-w-[60px] font-mono text-xs font-medium">
              {entry.keycode.label}
            </span>
            <span
              className="truncate text-content-secondary text-xs"
              onMouseEnter={handleDetailMouseEnter}
              onMouseLeave={handleDetailMouseLeave}
            >
              {entry.detail}
            </span>
          </button>
        ))}
      </div>
      {tooltip && (
        <div
          ref={tooltipRef}
          className="pointer-events-none absolute z-50 rounded-md border border-edge bg-surface-alt px-2.5 py-1.5 shadow-lg"
          style={{ top: tooltip.top - TOOLTIP_VERTICAL_GAP, transform: 'translateY(-100%)' }}
        >
          <div className="text-xs font-medium text-content whitespace-nowrap">
            {tooltip.text}
          </div>
        </div>
      )}
    </div>
  )
}
