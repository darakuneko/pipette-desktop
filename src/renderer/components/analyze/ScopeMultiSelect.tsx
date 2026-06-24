// SPDX-License-Identifier: GPL-2.0-or-later
// Shared multi-select filter for the Analyze panel, backing both the
// App-name and TypingTest filters. The option list is fetched for the
// current uid + device scope + range via the injected `fetchOptions`, so
// it always reflects what actually has data — picking a value that no
// longer exists is impossible.
//
// `value` is a `string[]`; the empty array is the "no filter" choice
// (every minute, including mixed/unknown). Stale persisted names that
// disappear from the option list are silently dropped on the next
// `onChange`. Renders as a button that opens a checkbox popover so the
// filter row stays compact even with a long-tail list.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { scopeToSelectValue, type DeviceScope } from '../../../shared/types/analyze-filters'
import { AnchoredPopover } from '../ui/AnchoredPopover'
import type { RangeMs } from './analyze-types'
import { FILTER_SELECT } from './analyze-filter-styles'

interface ScopeOption {
  name: string
  keystrokes: number
}

interface Props {
  uid: string
  range: RangeMs
  deviceScopes: readonly DeviceScope[]
  value: string[]
  onChange: (next: string[]) => void
  ariaLabel?: string
  testId: string
  // Fetches the available option names for the uid + range + device scope.
  fetchOptions: (uid: string, fromMs: number, toMs: number, scope: string) => Promise<ScopeOption[]>
  // i18n key prefix for the no-filter / multi-select labels, e.g.
  // `analyze.filters.appOption` → `.none` / `.multi`.
  i18nPrefix: string
}

export function ScopeMultiSelect({
  uid,
  range,
  deviceScopes,
  value,
  onChange,
  ariaLabel,
  testId,
  fetchOptions,
  i18nPrefix,
}: Props) {
  const { t } = useTranslation()
  const [options, setOptions] = useState<ScopeOption[]>([])
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const scope = scopeToSelectValue(deviceScopes[0] ?? 'own')

  useEffect(() => {
    // 150 ms debounce so range scrubbing (date-picker drag) doesn't fan
    // out one IPC per intermediate value before the user lands on the
    // final range.
    let cancelled = false
    const id = window.setTimeout(() => {
      fetchOptions(uid, range.fromMs, range.toMs, scope)
        .then((rows) => {
          if (cancelled) return
          setOptions(rows.map((r) => ({ name: r.name, keystrokes: r.keystrokes })))
        })
        .catch(() => {
          if (!cancelled) setOptions([])
        })
    }, 150)
    return () => {
      cancelled = true
      window.clearTimeout(id)
    }
  }, [uid, range.fromMs, range.toMs, scope, fetchOptions])

  // Drop stale persisted names silently — the parent's normalize step
  // already trims unknowns on load, but this catches the in-flight case
  // where the option list refreshes after a device-scope change.
  useEffect(() => {
    if (value.length === 0) return
    if (options.length === 0) return
    const known = new Set(options.map((o) => o.name))
    const filtered = value.filter((v) => known.has(v))
    if (filtered.length !== value.length) onChange(filtered)
  }, [options, value, onChange])

  const valueSet = useMemo(() => new Set(value), [value])

  const buttonLabel = useMemo(() => {
    if (value.length === 0) return t(`${i18nPrefix}.none`)
    if (value.length === 1) return value[0]
    return t(`${i18nPrefix}.multi`, { first: value[0], rest: value.length - 1 })
  }, [value, t, i18nPrefix])

  const toggle = (name: string) => {
    if (valueSet.has(name)) onChange(value.filter((v) => v !== name))
    else onChange([...value, name])
  }

  const clearAll = () => {
    if (value.length === 0) return
    onChange([])
  }

  // Memoised so AnchoredPopover's outside-click / Escape effect doesn't
  // tear down + re-attach window listeners on every parent render.
  const handleClose = useCallback(() => setOpen(false), [])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`${FILTER_SELECT} text-left`}
        onClick={() => setOpen((prev) => !prev)}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid={testId}
      >
        {buttonLabel}
      </button>
      <AnchoredPopover
        anchorRef={triggerRef}
        open={open}
        onClose={handleClose}
        className="z-20 max-h-72 min-w-dropdown overflow-y-auto rounded-md border border-edge bg-surface p-1 text-xs shadow-lg"
        role="listbox"
        aria-multiselectable
      >
        <button
          type="button"
          // The no-filter sentinel. Disable it once the user has picked
          // anything specific so they have to clear the multi-select
          // intentionally before re-entering the unfiltered view.
          className="w-full rounded px-2 py-1 text-left text-content-secondary transition-colors hover:bg-surface-dim disabled:cursor-not-allowed disabled:opacity-40"
          onClick={clearAll}
          disabled={value.length === 0}
          data-testid={`${testId}-option-none`}
        >
          {t(`${i18nPrefix}.none`)}
        </button>
        {options.length > 0 && <div className="my-1 border-t border-edge" />}
        {options.map((o) => {
          const checked = valueSet.has(o.name)
          return (
            <label
              key={o.name}
              className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-content transition-colors hover:bg-surface-dim"
              data-testid={`${testId}-option-${o.name}`}
            >
              <input
                type="checkbox"
                className="cursor-pointer"
                checked={checked}
                onChange={() => toggle(o.name)}
              />
              <span className="flex-1 truncate">{o.name}</span>
            </label>
          )
        })}
      </AnchoredPopover>
    </>
  )
}
