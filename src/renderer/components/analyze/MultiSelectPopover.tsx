// SPDX-License-Identifier: GPL-2.0-or-later
// Presentational multi-select popover shared by every Analyze filter
// dropdown (App / TypingTest via ScopeMultiSelect, Results via RunSelect).
// It owns the trigger button, the checkbox popover, the "none" sentinel,
// the selection toggle, the button summary label, and the stale-value
// prune — everything except *where the options come from*. Each caller
// owns its own fetch and feeds the resolved `options` in.
//
// Options are `{ value, label }`: `value` is the stored/queried key, `label`
// is what the user sees (they're identical for App/TypingTest, but differ
// for Results where value = run id, label = run name). `value` (the prop)
// is the selected key list; empty = the "no filter" choice.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AnchoredPopover } from '../ui/AnchoredPopover'
import { FILTER_SELECT } from './analyze-filter-styles'

export interface MultiSelectOption {
  value: string
  label: string
}

interface Props {
  options: MultiSelectOption[]
  value: string[]
  onChange: (next: string[]) => void
  /** i18n key prefix for the no-filter / multi-select summary labels,
   *  e.g. `analyze.filters.appOption` → `.none` / `.multi`. */
  i18nPrefix: string
  ariaLabel?: string
  testId: string
}

export function MultiSelectPopover({ options, value, onChange, i18nPrefix, ariaLabel, testId }: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  // Drop stale selected values silently once the refreshed option list no
  // longer contains them (e.g. after a device-scope / material change).
  useEffect(() => {
    if (value.length === 0) return
    if (options.length === 0) return
    const known = new Set(options.map((o) => o.value))
    const filtered = value.filter((v) => known.has(v))
    if (filtered.length !== value.length) onChange(filtered)
  }, [options, value, onChange])

  const valueSet = useMemo(() => new Set(value), [value])
  const labelByValue = useMemo(() => new Map(options.map((o) => [o.value, o.label])), [options])

  const buttonLabel = useMemo(() => {
    if (value.length === 0) return t(`${i18nPrefix}.none`)
    if (value.length === 1) return labelByValue.get(value[0]) ?? value[0]
    return t(`${i18nPrefix}.multi`, { first: labelByValue.get(value[0]) ?? value[0], rest: value.length - 1 })
  }, [value, t, i18nPrefix, labelByValue])

  const toggle = (v: string) => {
    if (valueSet.has(v)) onChange(value.filter((x) => x !== v))
    else onChange([...value, v])
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
        className={`${FILTER_SELECT} max-w-filter-trigger truncate text-left`}
        onClick={() => setOpen((prev) => !prev)}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={buttonLabel}
        data-testid={testId}
      >
        {buttonLabel}
      </button>
      <AnchoredPopover
        anchorRef={triggerRef}
        open={open}
        onClose={handleClose}
        // The trigger sits at the right side of the filter rows, so align
        // the panel's right edge to it and let it grow leftward — a fixed
        // max width plus wrapping labels keeps it inside the viewport.
        align="right"
        // z-60 (see --z-60): the panel portals to document.body, so inside
        // the z-50 filter modal it must sit above the modal overlay — same
        // tier as the AnalyzeExportModal dropdown overlay.
        className="z-60 max-h-72 min-w-dropdown max-w-dropdown overflow-y-auto rounded-md border border-edge bg-surface p-1 text-xs shadow-lg"
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
          const checked = valueSet.has(o.value)
          return (
            <label
              key={o.value}
              className="flex w-full cursor-pointer items-start gap-2 rounded px-2 py-1 text-content transition-colors hover:bg-surface-dim"
              data-testid={`${testId}-option-${o.value}`}
            >
              <input
                type="checkbox"
                className="cursor-pointer"
                checked={checked}
                onChange={() => toggle(o.value)}
              />
              {/* Long labels wrap inside the fixed-width panel (no ellipsis —
                  the full name must stay readable when picking a test). */}
              <span className="min-w-0 flex-1 break-words">{o.label}</span>
            </label>
          )
        })}
      </AnchoredPopover>
    </>
  )
}
