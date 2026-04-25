// SPDX-License-Identifier: GPL-2.0-or-later
// Single-select Device filter for the Analyze panel. The widget edits a
// `readonly DeviceScope[]` array (own / all / one remote hash) to keep
// the persisted filter shape stable, but the user can only ever pick
// one scope at a time — Analyze charts each show a single device's
// data, so multi-pick has been retired.
//
// UI matches the other Analyze filter selects (snapshot timeline,
// granularity, etc.): a native `<select>` with `FILTER_LABEL` /
// `FILTER_SELECT` styling. The hash options carry the full machine
// hash via `data-machine-hash` so we don't have to round-trip the
// truncated label back into a scope object.

import { useTranslation } from 'react-i18next'
import { scopeToSelectValue, type DeviceScope } from '../../../shared/types/analyze-filters'
import { FILTER_SELECT } from './analyze-filter-styles'

interface Props {
  value: readonly DeviceScope[]
  remoteHashes: readonly string[]
  onChange: (next: DeviceScope[]) => void
  ariaLabel?: string
  testId?: string
}

const HASH_PREFIX = 'hash:'

function parseScope(selectValue: string): DeviceScope | null {
  if (selectValue === 'own' || selectValue === 'all') return selectValue
  if (selectValue.startsWith(HASH_PREFIX)) {
    const machineHash = selectValue.slice(HASH_PREFIX.length)
    if (machineHash) return { kind: 'hash', machineHash }
  }
  return null
}

export function DeviceMultiSelect({
  value,
  remoteHashes,
  onChange,
  ariaLabel,
  testId = 'analyze-filter-device',
}: Props) {
  const { t } = useTranslation()
  const current = value[0] ?? 'own'
  const selectedKey = scopeToSelectValue(current)

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = parseScope(e.target.value)
    if (next === null) return
    if (scopeToSelectValue(next) === selectedKey) return
    onChange([next])
  }

  // Order: own → remote hashes → all. The exclusive `'all'` aggregate
  // sits at the bottom because it acts as a "switch away from the
  // per-device picks" — keeping the per-device options grouped
  // together up top reads better than burying the hashes between them.
  return (
    <select
      className={FILTER_SELECT}
      value={selectedKey}
      onChange={handleChange}
      aria-label={ariaLabel}
      data-testid={testId}
    >
      <option
        value="own"
        data-testid={`${testId}-option-own`}
      >
        {t('analyze.filters.deviceOption.own')}
      </option>
      {remoteHashes.map((hash) => {
        const optionValue = `${HASH_PREFIX}${hash}`
        return (
          <option
            key={hash}
            value={optionValue}
            title={hash}
            data-testid={`${testId}-option-${optionValue}`}
          >
            {t('analyze.filters.deviceOption.hashShort', { hash: hash.slice(0, 8) })}
          </option>
        )
      })}
      <option
        value="all"
        data-testid={`${testId}-option-all`}
      >
        {t('analyze.filters.deviceOption.all')}
      </option>
    </select>
  )
}

