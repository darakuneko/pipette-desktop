// SPDX-License-Identifier: GPL-2.0-or-later
// App-name filter for the Analyze panel. The dropdown is populated
// from `typingAnalyticsListAppsForRange` for the current uid + device
// scope + range, so the option list always reflects what's actually
// available — picking an app that no longer has data is impossible.
//
// `value === null` is the "no filter" choice and is rendered as the
// first option. Selections are passed back to the parent as
// `string | null`; the parent normalizes empty strings via
// `normalizeAppScope`.

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { scopeToSelectValue, type DeviceScope } from '../../../shared/types/analyze-filters'
import type { RangeMs } from './analyze-types'
import { FILTER_SELECT } from './analyze-filter-styles'

const NONE_VALUE = '__none__'

interface Props {
  uid: string
  range: RangeMs
  deviceScopes: readonly DeviceScope[]
  value: string | null
  onChange: (next: string | null) => void
  ariaLabel?: string
  testId?: string
}

interface AppOption {
  name: string
  keystrokes: number
}

export function AppSelect({
  uid,
  range,
  deviceScopes,
  value,
  onChange,
  ariaLabel,
  testId = 'analyze-filter-app',
}: Props) {
  const { t } = useTranslation()
  const [options, setOptions] = useState<AppOption[]>([])
  const scope = scopeToSelectValue(deviceScopes[0] ?? 'own')

  useEffect(() => {
    let cancelled = false
    window.vialAPI
      .typingAnalyticsListAppsForRange(uid, range.fromMs, range.toMs, scope)
      .then((rows) => {
        if (cancelled) return
        setOptions(rows.map((r) => ({ name: r.name, keystrokes: r.keystrokes })))
      })
      .catch(() => {
        if (!cancelled) setOptions([])
      })
    return () => {
      cancelled = true
    }
  }, [uid, range.fromMs, range.toMs, scope])

  // Drop a stale persisted name silently — the parent's
  // normalizeAppScope already coerces unknowns to null on next save,
  // but this guard catches the in-flight case where the option list
  // refreshes after the user changed device scope.
  useEffect(() => {
    if (value === null) return
    if (options.length === 0) return
    if (!options.some((o) => o.name === value)) onChange(null)
  }, [options, value, onChange])

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value === NONE_VALUE ? null : e.target.value
    if (next === value) return
    onChange(next)
  }

  // Order matches DeviceMultiSelect: per-item entries first, the
  // "all-X aggregate" sits at the bottom because picking it is a
  // switch-away from the per-item picks above.
  return (
    <select
      className={FILTER_SELECT}
      value={value ?? NONE_VALUE}
      onChange={handleChange}
      aria-label={ariaLabel}
      data-testid={testId}
    >
      {options.map((o) => (
        <option key={o.name} value={o.name} data-testid={`${testId}-option-${o.name}`}>
          {o.name}
        </option>
      ))}
      <option value={NONE_VALUE} data-testid={`${testId}-option-none`}>
        {t('analyze.filters.appOption.none')}
      </option>
    </select>
  )
}
