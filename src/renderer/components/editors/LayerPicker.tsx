// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'

interface Props {
  value: number
  onChange: (value: number) => void
  label: string
  horizontal?: boolean
}

const LAYER_COUNT = 16

export function LayerPicker({ value, onChange, label, horizontal }: Props) {
  const { t } = useTranslation()

  const handleToggle = (bit: number) => {
    onChange(value ^ (1 << bit))
  }

  const handleEnableAll = () => {
    onChange(0xffff)
  }

  const handleDisableAll = () => {
    onChange(0)
  }

  const buttons = (
    <div className="flex gap-2">
      <button
        type="button"
        onClick={handleEnableAll}
        className="rounded bg-surface-dim px-2 py-0.5 text-xs hover:bg-surface-raised"
      >
        {t('editor.keyOverride.enableAll')}
      </button>
      <button
        type="button"
        onClick={handleDisableAll}
        className="rounded bg-surface-dim px-2 py-0.5 text-xs hover:bg-surface-raised"
      >
        {t('editor.keyOverride.disableAll')}
      </button>
    </div>
  )

  const grid = (
    <div className="grid grid-cols-8 gap-x-3 gap-y-1">
      {Array.from({ length: LAYER_COUNT }, (_, bit) => (
        <label key={bit} className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={(value & (1 << bit)) !== 0}
            onChange={() => handleToggle(bit)}
            className="h-4 w-4"
          />
          {bit}
        </label>
      ))}
    </div>
  )

  if (horizontal) {
    return (
      <div className="flex items-start gap-3">
        <span className="min-w-[140px] pt-0.5 text-sm font-medium">{label}</span>
        <div className="space-y-1">
          {grid}
          {buttons}
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-1 flex items-center gap-3">
        <span className="text-sm font-medium">{label}</span>
        {buttons}
      </div>
      {grid}
    </div>
  )
}
