// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useMemo, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { KeyboardWidget } from '../keyboard/KeyboardWidget'
import type { KeyboardLayout } from '../../../shared/kle/types'
import {
  parseLayoutLabels,
  unpackLayoutOptions,
  packLayoutOptions,
} from '../../../shared/layout-options'

interface Props {
  layout: KeyboardLayout | null
  layoutLabels: (string | string[])[] | undefined
  layoutOptions: number
  keycodes: Map<string, string>
  onSetLayoutOptions: (options: number) => Promise<void>
}

export function LayoutEditor({
  layout,
  layoutLabels,
  layoutOptions: packedOptions,
  keycodes,
  onSetLayoutOptions,
}: Props) {
  const { t } = useTranslation()

  const options = useMemo(() => parseLayoutLabels(layoutLabels), [layoutLabels])
  const [values, setValues] = useState<Map<number, number>>(() =>
    unpackLayoutOptions(packedOptions, options),
  )

  // Sync values when packed options or labels change (e.g. VIL load, reconnect)
  useEffect(() => {
    setValues(unpackLayoutOptions(packedOptions, options))
  }, [packedOptions, options])

  const handleChange = useCallback(
    async (index: number, value: number) => {
      const newValues = new Map(values)
      newValues.set(index, value)
      setValues(newValues)
      const packed = packLayoutOptions(newValues, options)
      await onSetLayoutOptions(packed)
    },
    [values, options, onSetLayoutOptions],
  )

  if (!layout || options.length === 0) {
    return <div className="p-4 text-content-muted">{t('editor.layout.title')}</div>
  }

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">{t('editor.layout.options')}</h2>

      <div className="space-y-3">
        {options.map((opt) => (
          <div key={opt.index} className="flex items-center gap-3">
            <span className="min-w-[120px] text-sm text-content">
              {opt.labels[0]}
            </span>
            {opt.labels.length <= 2 ? (
              <input
                type="checkbox"
                checked={(values.get(opt.index) ?? 0) === 1}
                onChange={(e) =>
                  handleChange(opt.index, e.target.checked ? 1 : 0)
                }
                className="h-4 w-4 rounded border-edge"
              />
            ) : (
              <select
                value={values.get(opt.index) ?? 0}
                onChange={(e) =>
                  handleChange(opt.index, Number(e.target.value))
                }
                className="rounded border border-edge bg-surface px-2 py-1 text-sm"
              >
                {opt.labels.slice(1).map((label, i) => (
                  <option key={i} value={i}>
                    {label}
                  </option>
                ))}
              </select>
            )}
          </div>
        ))}
      </div>

      <h3 className="text-sm font-medium text-content-secondary">
        {t('editor.layout.preview')}
      </h3>
      <div className="overflow-auto">
        <div className="inline-block rounded-xl border border-edge-subtle bg-surface-alt p-5">
          <KeyboardWidget
            keys={layout.keys}
            keycodes={keycodes}
            layoutOptions={values}
            readOnly
            scale={0.7}
          />
        </div>
      </div>
    </div>
  )
}
