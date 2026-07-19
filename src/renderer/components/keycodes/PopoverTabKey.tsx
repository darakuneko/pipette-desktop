// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useRef, useCallback, useLayoutEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { type Keycode, getKeycodeRevision, serialize, isMask, findInnerKeycode, isBasic, isLMKeycode, getAvailableLMMods, extractBasicKey } from '../../../shared/keycodes/keycodes'
import { KEYCODE_CATEGORIES } from './categories'
import { getRemapDisplayLabel } from './KeycodeGrid'

interface SearchEntry {
  keycode: Keycode
  categoryId: string
  searchText: string
  /** Individual lowercased tokens for exact-match ranking */
  tokens: string[]
  detail: string
  /** Set when the active Key Label pack remaps this keycode's legend —
   *  same value `KeycodeGrid`/`KeyWidget` render on the keycap itself.
   *  `undefined` means "not remapped", not merely "unset". */
  displayLabel?: string
  /** Gated remap-tint decision for this row (Plan-qwerty-select-no-rewrite):
   *  usually `displayLabel != null`, but diverges from it once a Rewrite is
   *  applied — the legend goes raw (`displayLabel` undefined) while the
   *  keycodes the Rewrite actually changed still need the blue tint. See
   *  the `isRemapped` prop below. */
  remapped: boolean
}

/**
 * Flatten a possibly multi-line label ("(\n8") into a single display
 * line ("( 8") — mirrors how the keycap grid stacks `\n`-separated
 * parts visually; the search-result row has no room for that layout,
 * so it reads left-to-right instead.
 */
function flattenLabel(label: string): string {
  return label.split('\n').map((line) => line.trim()).filter(Boolean).join(' ')
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
  emptyInitial?: boolean
  maskOnly?: boolean
  modMask?: number
  lmMode?: boolean
  basicKeyOnly?: boolean
  onKeycodeSelect: (kc: Keycode) => void
  onClose?: () => void
  /** Active Key Label pack's per-key legend override, threaded from
   *  the same source `KeycodeGrid`/`BasicKeyboardView` already use
   *  (see `useDevicePrefs`/`useKeyboardLayout`) so the picker's search
   *  index and result rows agree with what the keymap grid shows. */
  remapLabel?: (qmkId: string) => string
  /** Gated remap-tint predicate — same source `KeycodeGrid` receives.
   *  Decides row color instead of `displayLabel != null` when present, so
   *  applied-mode Rewrite targets stay tinted even though their legend is
   *  raw. Falls back to `displayLabel != null` (the old behavior) when
   *  absent, so callers that only pass `remapLabel` are unaffected. */
  isRemapped?: (qmkId: string) => boolean
}

const MAX_RESULTS = 50

export function PopoverTabKey({ currentKeycode, emptyInitial, maskOnly, modMask = 0, lmMode: lmModeProp, basicKeyOnly, onKeycodeSelect, onClose, remapLabel, isRemapped }: Props) {
  const hasModMask = modMask > 0
  const { t } = useTranslation()
  const initialQuery = useMemo(() => {
    if (emptyInitial) return ''
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
  }, [currentKeycode, emptyInitial, maskOnly, modMask, basicKeyOnly])
  const [query, setQuery] = useState(initialQuery)
  const [suppressResults, setSuppressResults] = useState(false)

  const lmMode = lmModeProp || (maskOnly && isLMKeycode(currentKeycode))

  const searchIndex = useMemo(() => {
    const entries: SearchEntry[] = []

    // LM inner: show modifier keycodes instead of basic keycodes
    if (lmMode) {
      for (const kc of getAvailableLMMods()) {
        const searchParts = [stripPrefix(kc.qmkId), kc.label, kc.tooltip].filter((p): p is string => Boolean(p))
        const tokens = searchParts.map((p) => p.toLowerCase())
        entries.push({
          keycode: kc,
          categoryId: 'lm-mods',
          searchText: tokens.join(' '),
          tokens,
          detail: [kc.qmkId, kc.tooltip].filter(Boolean).join(' \u00b7 '),
          remapped: false,
        })
      }
      return entries
    }

    for (const cat of KEYCODE_CATEGORIES) {
      for (const kc of cat.getKeycodes()) {
        if (kc.hidden) continue
        if ((maskOnly || hasModMask || basicKeyOnly) && !isBasic(kc.qmkId)) continue
        const extraAliases = kc.alias.slice(1)
        const displayLabel = getRemapDisplayLabel(kc.qmkId, remapLabel)
        // Falls back to `displayLabel != null` (the pre-Rewrite behavior)
        // when `isRemapped` is absent, so callers that only pass
        // `remapLabel` see the exact same coloring as before. When present,
        // `isRemapped` is the source of truth — in applied mode the legend
        // goes raw (`displayLabel` undefined) but a Rewrite TARGET keycode
        // must still show the tint.
        const remapped = isRemapped ? isRemapped(kc.qmkId) : displayLabel != null
        const searchParts = [
          stripPrefix(kc.qmkId),
          kc.label,
          ...kc.alias.map(stripPrefix),
          kc.tooltip,
        ].filter((p): p is string => Boolean(p))
        const detailParts = [kc.qmkId, kc.tooltip, ...extraAliases].filter((p): p is string => Boolean(p))
        // Surface the default label in the detail line for a remapped
        // entry so the underlying key stays identifiable even though
        // the headline label now shows the pack's text.
        if (displayLabel) detailParts.push(flattenLabel(kc.label))
        // A pack-remapped label (e.g. "(\n8") must be searchable by its
        // own text, not just the default label/qmkId/tooltip \u2014
        // otherwise a search that only matches the *default* label of a
        // DIFFERENT keycode (e.g. default "( 9" for KC_9) can shadow
        // the actually-relabeled key the user is looking for (issue
        // #294). Each line of a multi-line remap becomes its own token
        // so an exact match on either line (e.g. "(" or "8") ranks this
        // entry in the "exact" bucket, same as any other exact token
        // match \u2014 default label/qmkId/tooltip tokens are kept as-is so
        // searching by the default name still works too.
        const remapTokens = displayLabel
          ? displayLabel.split('\n').map((line) => line.trim()).filter(Boolean)
          : []
        const tokens = [...searchParts, ...remapTokens].map((p) => p.toLowerCase())
        entries.push({
          keycode: kc,
          categoryId: cat.id,
          searchText: tokens.join(' '),
          tokens,
          detail: detailParts.join(' \u00b7 '),
          displayLabel,
          remapped,
        })
      }
    }
    return entries
  }, [lmMode, maskOnly, hasModMask, basicKeyOnly, remapLabel, isRemapped, getKeycodeRevision()])

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
    <div ref={containerRef} className="relative flex min-h-0 flex-1 flex-col gap-2">
      <input
        type="text"
        value={query}
        onChange={(e) => { setSuppressResults(false); setQuery(e.target.value) }}
        placeholder={t('editor.keymap.keyPopover.searchPlaceholder')}
        className="w-full rounded border border-edge bg-surface px-2.5 py-1.5 text-sm focus:border-accent focus:outline-none"
        autoFocus
        data-testid="popover-search-input"
      />
      <div className="min-h-0 flex-1 overflow-y-auto" onScroll={handleDetailMouseLeave}>
        {query.trim() && results.length === 0 && (
          suppressResults && onClose ? (
            <button
              type="button"
              className="w-full rounded px-2 py-3 text-center text-xs text-content-muted hover:bg-surface-dim"
              onClick={onClose}
              data-testid="popover-close-hint"
            >
              <div>{t('editor.keymap.keyPopover.keySelected', { key: query })}</div>
              <div className="mt-1 text-accent">{t('editor.keymap.keyPopover.clickToClose')}</div>
            </button>
          ) : (
            <div className="px-2 py-3 text-center text-xs text-content-muted">
              {suppressResults
                ? t('editor.keymap.keyPopover.keySelected', { key: query })
                : t('editor.keymap.keyPopover.noResults')}
            </div>
          )
        )}
        {results.map((entry) => {
          // Same treatment as the keymap grid: a remapped key's legend
          // (from the active Key Label pack) replaces the default label
          // and is colored the same as `KeycodeButton`'s own remapped
          // keys (`text-key-label-remap`), so a pack-driven result is
          // visually identifiable as such at a glance.
          const displayText = flattenLabel(entry.displayLabel ?? entry.keycode.label)
          return (
            <button
              key={`${entry.categoryId}-${entry.keycode.qmkId}`}
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-dim"
              onClick={() => { setTooltip(null); onKeycodeSelect(entry.keycode); setSuppressResults(true); setQuery(entry.keycode.label || stripPrefix(entry.keycode.qmkId)) }}
              data-testid={`popover-result-${entry.keycode.qmkId}`}
            >
              <span className={`min-w-keycode font-mono text-xs font-medium ${entry.remapped ? 'text-key-label-remap' : ''}`}>
                {displayText}
              </span>
              <span
                className="truncate text-content-secondary text-xs"
                onMouseEnter={handleDetailMouseEnter}
                onMouseLeave={handleDetailMouseLeave}
              >
                {entry.detail}
              </span>
            </button>
          )
        })}
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
