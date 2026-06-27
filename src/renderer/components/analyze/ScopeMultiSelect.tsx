// SPDX-License-Identifier: GPL-2.0-or-later
// Range-fetched multi-select filter for the Analyze panel, backing both
// the App-name and TypingTest filters. The option list is fetched for the
// current uid + device scope + range via the injected `fetchOptions`, so
// it always reflects what actually has data — picking a value that no
// longer exists is impossible. The popover UI itself lives in the shared
// MultiSelectPopover; this component only owns the range-driven fetch.

import { useEffect, useState } from 'react'
import { scopeToSelectValue, type DeviceScope } from '../../../shared/types/analyze-filters'
import type { RangeMs } from './analyze-types'
import { MultiSelectPopover, type MultiSelectOption } from './MultiSelectPopover'

interface ScopeOption {
  name: string
  keystrokes: number
}

interface Props {
  uid: string
  range: RangeMs
  deviceScopes: readonly DeviceScope[]
  value: string[]
  onChange: (next: string[]) => void
  ariaLabel?: string
  testId: string
  // Fetches the available option names for the uid + range + device scope.
  fetchOptions: (uid: string, fromMs: number, toMs: number, scope: string) => Promise<ScopeOption[]>
  // i18n key prefix for the no-filter / multi-select labels, e.g.
  // `analyze.filters.appOption` → `.none` / `.multi`.
  i18nPrefix: string
}

export function ScopeMultiSelect({
  uid,
  range,
  deviceScopes,
  value,
  onChange,
  ariaLabel,
  testId,
  fetchOptions,
  i18nPrefix,
}: Props) {
  // App / TypingTest options display the value verbatim, so value === label.
  const [options, setOptions] = useState<MultiSelectOption[]>([])
  const scope = scopeToSelectValue(deviceScopes[0] ?? 'own')

  useEffect(() => {
    // 150 ms debounce so range scrubbing (date-picker drag) doesn't fan
    // out one IPC per intermediate value before the user lands on the
    // final range.
    let cancelled = false
    const id = window.setTimeout(() => {
      fetchOptions(uid, range.fromMs, range.toMs, scope)
        .then((rows) => {
          if (cancelled) return
          setOptions(rows.map((r) => ({ value: r.name, label: r.name })))
        })
        .catch(() => {
          if (!cancelled) setOptions([])
        })
    }, 150)
    return () => {
      cancelled = true
      window.clearTimeout(id)
    }
  }, [uid, range.fromMs, range.toMs, scope, fetchOptions])

  return (
    <MultiSelectPopover
      options={options}
      value={value}
      onChange={onChange}
      i18nPrefix={i18nPrefix}
      ariaLabel={ariaLabel}
      testId={testId}
    />
  )
}
