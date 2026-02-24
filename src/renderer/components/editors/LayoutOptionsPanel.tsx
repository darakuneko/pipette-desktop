// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useMemo, useRef } from 'react'
import type { LayoutOption } from '../../../shared/layout-options'
import { ROW_CLASS } from './modal-controls'

export interface LayoutOptionsPanelProps {
  options: LayoutOption[]
  values: Map<number, number>
  onChange: (index: number, value: number) => void
}

export function LayoutOptionsPanel({ options, values, onChange }: LayoutOptionsPanelProps) {
  // Compute the widest select option label to align all selects
  const hasSelect = options.some((opt) => opt.labels.length > 2)
  const selectRef = useRef<HTMLSelectElement>(null)
  const [selectWidth, setSelectWidth] = useState<number | undefined>(undefined)

  useEffect(() => {
    if (!hasSelect || !selectRef.current) return
    // Measure the natural width of the hidden sizer select
    setSelectWidth(selectRef.current.offsetWidth)
  }, [hasSelect, options])

  // All choice labels across all selects (for the sizer)
  const allChoiceLabels = useMemo(
    () => options.filter((o) => o.labels.length > 2).flatMap((o) => o.labels.slice(1)),
    [options],
  )

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      {/* Hidden sizer select to measure the widest option */}
      {hasSelect && (
        <select
          ref={selectRef}
          className="invisible absolute rounded border border-edge px-2.5 py-1.5 text-[13px]"
          tabIndex={-1}
          aria-hidden="true"
        >
          {allChoiceLabels.map((label, i) => (
            <option key={i}>{label}</option>
          ))}
        </select>
      )}
      {options.map((opt) => {
        const val = values.get(opt.index) ?? 0
        const isBoolean = opt.labels.length <= 2
        return (
          <label key={opt.index} className={`${ROW_CLASS} cursor-pointer`}>
            <span className="text-[13px] font-medium text-content">{opt.labels[0]}</span>
            {isBoolean ? (
              <input
                type="checkbox"
                checked={val === 1}
                onChange={() => onChange(opt.index, val === 1 ? 0 : 1)}
              />
            ) : (
              <select
                value={val}
                onChange={(e) => onChange(opt.index, Number(e.target.value))}
                className="rounded border border-edge bg-surface px-2.5 py-1.5 text-[13px] text-content focus:border-accent focus:outline-none"
                style={selectWidth ? { width: selectWidth } : undefined}
              >
                {opt.labels.slice(1).map((label, i) => (
                  <option key={i} value={i}>{label}</option>
                ))}
              </select>
            )}
          </label>
        )
      })}
    </div>
  )
}
