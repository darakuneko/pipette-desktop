// SPDX-License-Identifier: GPL-2.0-or-later
// Multi-select Device filter for the Analyze panel. Replaces the old
// single-scope <select> so up to two scopes (own / all / remote hash)
// can ride alongside each other for the WPM / Interval / Ergonomics /
// Layer comparison overlays. Heatmap / Activity / StreakGoal still
// consume the first entry only — that's a parent-side concern, this
// widget just edits the array.
//
// Behaviour rules (mirrors `normalizeDeviceScopes` in the shared
// validator so UI / setter / persisted shape stay in lock-step):
//   - `'all'` is exclusive: picking it clears everything else; picking
//     a non-`'all'` while `'all'` is active drops `'all'`.
//   - The cap is `MAX_DEVICE_SCOPES` (2) for non-`'all'` selections.
//   - Toggling an already-selected entry deselects it; the parent
//     setter back-fills `['own']` on empty.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  MAX_DEVICE_SCOPES,
  isAllScope,
  isOwnScope,
  scopeToSelectValue,
  type DeviceScope,
} from '../../../shared/types/analyze-filters'
import { FILTER_SELECT } from './analyze-filter-styles'

interface Props {
  value: readonly DeviceScope[]
  remoteHashes: readonly string[]
  onChange: (next: DeviceScope[]) => void
  /** `'multi'` (default): up to `MAX_DEVICE_SCOPES` selections with
   * checkboxes and the existing `'all'`-exclusive rule. `'single'`:
   * radio-like behaviour where the dropdown stays at exactly one
   * pick — clicking any row replaces the current selection so the
   * caller can never receive an array longer than 1. Used by the
   * Heatmap / Activity tabs which only consume a single scope. */
  mode?: 'multi' | 'single'
  ariaLabel?: string
  testId?: string
}

function scopeLabel(scope: DeviceScope, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (isOwnScope(scope)) return t('analyze.filters.deviceOption.own')
  if (isAllScope(scope)) return t('analyze.filters.deviceOption.all')
  return t('analyze.filters.deviceOption.hashShort', { hash: scope.machineHash.slice(0, 8) })
}

export function DeviceMultiSelect({
  value,
  remoteHashes,
  onChange,
  mode = 'multi',
  ariaLabel,
  testId = 'analyze-filter-device',
}: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const handleOutside = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', handleEscape)
    window.addEventListener('mousedown', handleOutside)
    return () => {
      window.removeEventListener('keydown', handleEscape)
      window.removeEventListener('mousedown', handleOutside)
    }
  }, [open])

  const valueKeys = useMemo(() => new Set(value.map(scopeToSelectValue)), [value])
  const buttonLabel = value.length === 0
    ? t('analyze.filters.deviceOption.own')
    : value.map((scope) => scopeLabel(scope, t)).join(', ')

  const toggle = (scope: DeviceScope): void => {
    const key = scopeToSelectValue(scope)
    if (mode === 'single') {
      // Radio-style: clicking the already-selected row is a no-op
      // (deselection would leave the filter empty and the parent
      // would normalize it back to `['own']`, which feels unprovoked).
      // Any other click replaces the current pick outright.
      if (valueKeys.has(key)) return
      onChange([scope])
      return
    }
    if (valueKeys.has(key)) {
      onChange(value.filter((s) => scopeToSelectValue(s) !== key))
      return
    }
    if (isAllScope(scope)) {
      // `'all'` is exclusive — replace any current selection outright
      // so the UI shows immediate feedback; the normalizer would do the
      // same on its own but doing it here keeps the click optimistic.
      onChange(['all'])
      return
    }
    const withoutAll = value.filter((s) => !isAllScope(s))
    onChange([...withoutAll, scope])
  }

  // Cap reached for non-'all' picks: the only allowed clicks are
  // already-selected entries (deselection) or 'all' (which replaces).
  // Single mode never caps because a click always replaces the
  // current pick instead of accumulating.
  const atCap = mode === 'multi' && value.length >= MAX_DEVICE_SCOPES && !value.some(isAllScope)

  const renderRow = (scope: DeviceScope, label: string, optionKey: string) => {
    const key = scopeToSelectValue(scope)
    const checked = valueKeys.has(key)
    const disabled = atCap && !checked && !isAllScope(scope)
    return (
      <label
        key={optionKey}
        className={`flex items-center gap-2 px-3 py-1 text-[12px] transition-colors ${
          disabled
            ? 'cursor-not-allowed text-content-muted opacity-60'
            : 'cursor-pointer text-content-secondary hover:bg-surface-dim'
        }`}
        title={key.startsWith('hash:') ? key.slice('hash:'.length) : undefined}
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={() => toggle(scope)}
          data-testid={`${testId}-option-${optionKey}`}
        />
        <span className="truncate">{label}</span>
      </label>
    )
  }

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        type="button"
        className={`${FILTER_SELECT} flex items-center gap-1 text-left`}
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        data-testid={testId}
      >
        <span className="max-w-[14rem] truncate">{buttonLabel}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div
          className="absolute z-50 mt-1 min-w-full rounded-md border border-edge bg-surface py-1 shadow-lg"
          role="listbox"
          data-testid={`${testId}-menu`}
        >
          {/* Order: own → remote hashes → all. The exclusive `'all'`
           * aggregate sits at the bottom because it acts as a "switch
           * away from the per-device picks" — keeping the per-device
           * options grouped together up top reads better than burying
           * the hashes between them. */}
          {renderRow('own', t('analyze.filters.deviceOption.own'), 'own')}
          {remoteHashes.map((hash) =>
            renderRow(
              { kind: 'hash', machineHash: hash },
              t('analyze.filters.deviceOption.hashShort', { hash: hash.slice(0, 8) }),
              `hash:${hash}`,
            ),
          )}
          {renderRow('all', t('analyze.filters.deviceOption.all'), 'all')}
        </div>
      )}
    </div>
  )
}
