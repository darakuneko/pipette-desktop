// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useRef, useCallback, useId, useLayoutEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { type Keycode, getKeycodeRevision, serialize, isMask, findInnerKeycode, isBasic, isLMKeycode, getAvailableLMMods, extractBasicKey } from '../../../shared/keycodes/keycodes'
import { KEYCODE_CATEGORIES } from './categories'
import { getRemapDisplayLabel } from './KeycodeGrid'
import { BUBBLE_BASE, computeBubblePosition } from '../ui/Tooltip'
import { useSharedHoverBubble } from '../../hooks/use-shared-hover-bubble'

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

// Shared bubble contract: a canonicalized shared bubble (same
// BUBBLE_BASE skin, computeBubblePosition viewport clamping, 300ms open
// delay as the canonical `Tooltip`), not a per-row `Tooltip` wrap — up to
// MAX_RESULTS (50) rows can be mounted at once, each with its own
// truncated-detail hover target, so a per-row `Tooltip` would mount that
// many portals + effects for a hover affordance only ever one row shows
// at a time.
interface DetailTooltipState {
  text: string
  rect: DOMRect
}

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
}

const MAX_RESULTS = 50

export function PopoverTabKey({ currentKeycode, emptyInitial, maskOnly, modMask = 0, lmMode: lmModeProp, basicKeyOnly, onKeycodeSelect, onClose, remapLabel }: Props) {
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
        })
      }
    }
    return entries
  }, [lmMode, maskOnly, hasModMask, basicKeyOnly, remapLabel, getKeycodeRevision()])

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
  const { target: tooltip, show: showTooltip, hide: hideTooltip } = useSharedHoverBubble<DetailTooltipState>()
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number } | null>(null)
  const tooltipId = useId()
  const tooltipRef = useRef<HTMLDivElement>(null)

  // Position the bubble left-aligned above the truncated span, clamped to
  // the VIEWPORT (not just this container) so it never clips at the
  // screen's left/right edge.
  useLayoutEffect(() => {
    const el = tooltipRef.current
    if (!el || !tooltip) { setTooltipPos(null); return }
    setTooltipPos(computeBubblePosition(
      tooltip.rect,
      el.getBoundingClientRect(),
      'top',
      'start',
      8,
      { width: window.innerWidth, height: window.innerHeight },
    ))
  }, [tooltip])

  const handleDetailMouseEnter = useCallback((e: React.MouseEvent<HTMLSpanElement>) => {
    const span = e.currentTarget
    if (span.scrollWidth <= span.clientWidth) return
    showTooltip({ text: span.textContent ?? '', rect: span.getBoundingClientRect() })
  }, [showTooltip])

  const handleDetailMouseLeave = useCallback(() => hideTooltip(), [hideTooltip])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
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
              onClick={() => { hideTooltip(); onKeycodeSelect(entry.keycode); setSuppressResults(true); setQuery(entry.keycode.label || stripPrefix(entry.keycode.qmkId)) }}
              data-testid={`popover-result-${entry.keycode.qmkId}`}
            >
              <span className={`min-w-keycode font-mono text-xs font-medium ${entry.displayLabel != null ? 'text-key-label-remap' : ''}`}>
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
          role="tooltip"
          id={tooltipId}
          className={BUBBLE_BASE}
          style={{
            top: tooltipPos?.top ?? tooltip.rect.top,
            left: tooltipPos?.left ?? tooltip.rect.left,
          }}
        >
          <div className="text-xs font-medium text-content whitespace-nowrap">
            {tooltip.text}
          </div>
        </div>
      )}
    </div>
  )
}
