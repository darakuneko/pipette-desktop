// SPDX-License-Identifier: GPL-2.0-or-later
// Single-select Device filter for the Analyze panel. The widget edits a
// `readonly DeviceScope[]` array (own / all / one remote hash) to keep
// the persisted filter shape stable, but the user can only ever pick
// one scope at a time — Analyze charts each show a single device's
// data, so multi-pick has been retired.
//
// Per-device labels render as `{platform} - {release} ({hash})` (or
// just `{platform} ({hash})` when release is absent) so the user can
// tell their own machine apart from remote devices that synced into
// this keyboard's data. The local entry uses the matching `own`
// scope value so the parent's filter persistence keeps working
// without leaking the local machineHash through the selector.
//
// Behaviour rules (mirrors `normalizeDeviceScopes` in the shared
// validator so UI / setter / persisted shape stay in lock-step):
//   - Clicking a row replaces the current selection outright.
//   - Re-clicking the already-selected row is a no-op (deselection
//     would let the parent normalize back to `['own']`, which feels
//     unprovoked from a single-select dropdown).

import { useTranslation } from 'react-i18next'
import {
  scopeToSelectValue,
  type DeviceScope,
} from '../../../shared/types/analyze-filters'
import type { TypingAnalyticsDeviceInfo } from '../../../shared/types/typing-analytics'
import { FILTER_SELECT } from './analyze-filter-styles'

interface Props {
  value: readonly DeviceScope[]
  /** Local machine info — null while the device-info IPC is in flight
   * or after a transient failure. The own option is hidden until this
   * resolves so the user never sees a "This device" entry that points
   * at a stale hash. */
  ownDevice: TypingAnalyticsDeviceInfo | null
  remoteDevices: readonly TypingAnalyticsDeviceInfo[]
  onChange: (next: DeviceScope[]) => void
  ariaLabel?: string
  testId?: string
}

const HASH_PREFIX = 'hash:'
const HASH_DISPLAY_LEN = 8

export function formatDeviceLabel(info: TypingAnalyticsDeviceInfo): string {
  const hash = info.machineHash.slice(0, HASH_DISPLAY_LEN)
  const platform = info.osPlatform || '?'
  const release = info.osRelease
  return release ? `${platform} - ${release} (${hash})` : `${platform} (${hash})`
}

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
  ownDevice,
  remoteDevices,
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

  const ownLabel = ownDevice ? formatDeviceLabel(ownDevice) : t('analyze.filters.deviceOption.own')

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
        {ownLabel}
      </option>
      {remoteDevices.map((info) => {
        const optionValue = `${HASH_PREFIX}${info.machineHash}`
        return (
          <option
            key={info.machineHash}
            value={optionValue}
            title={info.machineHash}
            data-testid={`${testId}-option-${optionValue}`}
          >
            {formatDeviceLabel(info)}
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
