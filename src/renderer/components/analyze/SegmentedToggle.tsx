// SPDX-License-Identifier: GPL-2.0-or-later
// Generic segmented button group shared by the Analyze filter dimension
// toggle (App / TypingTest) and the Bigrams gram toggle (2 / 3). Owns the
// role="group" + aria-pressed markup and the SEGMENT_TOGGLE_* styling so
// both call sites stay visually and behaviorally identical.

import { SEGMENT_TOGGLE_ACTIVE, SEGMENT_TOGGLE_INACTIVE } from '../../constants/ui-tokens'

interface SegmentedToggleProps<T extends string | number> {
  options: readonly T[]
  value: T
  onChange: (next: T) => void
  labelFor: (option: T) => string
  ariaLabel: string
  testId: string
}

export function SegmentedToggle<T extends string | number>({
  options,
  value,
  onChange,
  labelFor,
  ariaLabel,
  testId,
}: SegmentedToggleProps<T>): JSX.Element {
  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-md border border-edge p-0.5"
      role="group"
      aria-label={ariaLabel}
      data-testid={testId}
    >
      {options.map((option) => {
        const active = value === option
        return (
          <button
            key={option}
            type="button"
            className={active ? SEGMENT_TOGGLE_ACTIVE : SEGMENT_TOGGLE_INACTIVE}
            aria-pressed={active}
            onClick={() => onChange(option)}
            data-testid={`${testId}-${option}`}
          >
            {labelFor(option)}
          </button>
        )
      })}
    </div>
  )
}
