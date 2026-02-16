// SPDX-License-Identifier: GPL-2.0-or-later

interface Props {
  value: number
  onChange: (value: number) => void
  label: string
  horizontal?: boolean
}

const MODIFIER_LABELS = [
  'LCtrl',
  'LShift',
  'LAlt',
  'LGui',
  'RCtrl',
  'RShift',
  'RAlt',
  'RGui',
] as const

export function ModifierPicker({ value, onChange, label, horizontal }: Props) {
  const handleToggle = (bit: number) => {
    onChange(value ^ (1 << bit))
  }

  const grid = (
    <div className="grid grid-cols-4 gap-x-4 gap-y-1">
      {MODIFIER_LABELS.map((name, bit) => (
        <label key={name} className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={(value & (1 << bit)) !== 0}
            onChange={() => handleToggle(bit)}
            className="h-4 w-4"
          />
          {name}
        </label>
      ))}
    </div>
  )

  if (horizontal) {
    return (
      <div className="flex items-start gap-3">
        <label className="min-w-[140px] pt-0.5 text-sm font-medium">{label}</label>
        {grid}
      </div>
    )
  }

  return (
    <div>
      <div className="mb-1 text-sm font-medium">{label}</div>
      {grid}
    </div>
  )
}
