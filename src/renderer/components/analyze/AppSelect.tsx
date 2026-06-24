// SPDX-License-Identifier: GPL-2.0-or-later
// Multi-select App-name filter for the Analyze panel — a thin binding of
// the shared `ScopeMultiSelect` to `typingAnalyticsListAppsForRange`, so
// the option list always reflects which apps actually have data in the
// current uid + device scope + range.

import { ScopeMultiSelect } from './ScopeMultiSelect'
import type { DeviceScope } from '../../../shared/types/analyze-filters'
import type { RangeMs } from './analyze-types'

interface Props {
  uid: string
  range: RangeMs
  deviceScopes: readonly DeviceScope[]
  value: string[]
  onChange: (next: string[]) => void
  ariaLabel?: string
  testId?: string
}

// Module-level so the reference is stable across renders (ScopeMultiSelect
// lists it in the fetch effect's dep array).
const fetchApps = (uid: string, fromMs: number, toMs: number, scope: string) =>
  window.vialAPI.typingAnalyticsListAppsForRange(uid, fromMs, toMs, scope)

export function AppSelect({ testId = 'analyze-filter-app', ...rest }: Props) {
  return (
    <ScopeMultiSelect
      {...rest}
      testId={testId}
      fetchOptions={fetchApps}
      i18nPrefix="analyze.filters.appOption"
    />
  )
}
