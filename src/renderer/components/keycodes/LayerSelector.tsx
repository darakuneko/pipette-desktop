// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'

interface Props {
  layers: number
  selectedLayer: number
  onChange: (layer: number) => void
}

export function LayerSelector({ layers, selectedLayer, onChange }: Props) {
  const { t } = useTranslation()

  return (
    <div data-testid="layer-selector">
      <div className="mb-1 text-xs font-medium text-content-secondary">
        {t('editor.keymap.keyPopover.layerLabel')}
      </div>
      <div className="flex flex-wrap gap-1">
        {Array.from({ length: layers }, (_, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onChange(i)}
            className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
              selectedLayer === i
                ? 'bg-blue-600 text-white'
                : 'bg-gray-200 text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
            }`}
            data-testid={`layer-btn-${i}`}
          >
            {i}
          </button>
        ))}
      </div>
    </div>
  )
}
