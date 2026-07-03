// SPDX-License-Identifier: GPL-2.0-or-later
// Second-level Analyze filter: once one or more TypingTest materials are
// chosen, this narrows them to specific runs. The run list's source of
// truth is the typing-analytics DB (distinct run_id in the current range +
// device scope + material scope) — so a run shows up here even when it has
// no saved typingTestResults entry (e.g. a "words" run never recorded to
// History). All fetching and labeling (History name → date fallbacks)
// lives in `useRunLabels`, shared with the filter summary chip so both
// surfaces show the same label for the same run.
//
// `value` is a `string[]` of run ids; empty = every run of the selected
// material(s).

import { useMemo } from 'react'
import type { DeviceScope } from '../../../shared/types/analyze-filters'
import type { RangeMs } from './analyze-types'
import { MultiSelectPopover, type MultiSelectOption } from './MultiSelectPopover'
import { useRunLabels } from '../../hooks/useRunLabels'

interface Props {
  uid: string
  range: RangeMs
  deviceScopes: readonly DeviceScope[]
  /** Selected TypingTest material labels (rawTypingTestScopes). Runs are
   *  limited to these material(s); empty = every material. */
  materialScopes: string[]
  value: string[]
  onChange: (next: string[]) => void
  ariaLabel?: string
  testId?: string
}

export function RunSelect({
  uid,
  range,
  deviceScopes,
  materialScopes,
  value,
  onChange,
  ariaLabel,
  testId = 'analyze-filter-run',
}: Props) {
  const { runs, labelFor } = useRunLabels(uid, { range, deviceScopes, materialScopes })

  const options = useMemo<MultiSelectOption[]>(
    () => runs.map((run) => ({ value: run.runId, label: labelFor(run.runId) })),
    [runs, labelFor],
  )

  return (
    <MultiSelectPopover
      options={options}
      value={value}
      onChange={onChange}
      i18nPrefix="analyze.filters.runOption"
      ariaLabel={ariaLabel}
      testId={testId}
    />
  )
}
