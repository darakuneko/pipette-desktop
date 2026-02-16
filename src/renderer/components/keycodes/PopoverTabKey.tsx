// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { type Keycode, getKeycodeRevision, serialize, isMask, findInnerKeycode, isBasic, isLMKeycode, getAvailableLMMods } from '../../../shared/keycodes/keycodes'
import { KEYCODE_CATEGORIES } from './categories'

interface SearchEntry {
  keycode: Keycode
  categoryId: string
  searchText: string
  /** Individual lowercased tokens for exact-match ranking */
  tokens: string[]
  detail: string
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
  maskOnly?: boolean
  onKeycodeSelect: (kc: Keycode) => void
}

const MAX_RESULTS = 50

export function PopoverTabKey({ currentKeycode, maskOnly, onKeycodeSelect }: Props) {
  const { t } = useTranslation()
  const initialQuery = useMemo(() => {
    const serialized = serialize(currentKeycode)
    if (isMask(serialized)) {
      if (maskOnly) {
        const inner = findInnerKeycode(serialized)
        return inner ? stripPrefix(inner.qmkId) : stripPrefix(serialized)
      }
      return serialized.substring(0, serialized.indexOf('('))
    }
    return stripPrefix(serialized)
  }, [currentKeycode, maskOnly])
  const [query, setQuery] = useState(initialQuery)

  const lmMode = maskOnly && isLMKeycode(currentKeycode)

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
        if (maskOnly && !isBasic(kc.qmkId)) continue
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
  }, [lmMode, maskOnly, getKeycodeRevision()])

  const results = useMemo(() => {
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
  }, [query, searchIndex])

  return (
    <div className="flex flex-col gap-2">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('editor.keymap.keyPopover.searchPlaceholder')}
        className="w-full rounded border border-edge bg-surface px-2.5 py-1.5 text-sm focus:border-accent focus:outline-none"
        autoFocus
        data-testid="popover-search-input"
      />
      <div className="max-h-[240px] overflow-y-auto">
        {query.trim() && results.length === 0 && (
          <div className="px-2 py-3 text-center text-xs text-content-muted">
            {t('editor.keymap.keyPopover.noResults')}
          </div>
        )}
        {results.map((entry) => (
          <button
            key={`${entry.categoryId}-${entry.keycode.qmkId}`}
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-dim"
            onClick={() => onKeycodeSelect(entry.keycode)}
            data-testid={`popover-result-${entry.keycode.qmkId}`}
          >
            <span className="min-w-[60px] font-mono text-xs font-medium">
              {entry.keycode.label}
            </span>
            <span className="truncate text-content-secondary text-xs">
              {entry.detail}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
