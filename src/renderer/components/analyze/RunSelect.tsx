// SPDX-License-Identifier: GPL-2.0-or-later
// Second-level Analyze filter: once one or more TypingTest materials are
// chosen, this narrows them to specific runs. The run list's source of
// truth is the typing-analytics DB (distinct run_id in the current range +
// device scope + material scope) — so a run shows up here even when it has
// no saved typingTestResults entry (e.g. a "words" run never recorded to
// History). typingTestResults is consulted only for a run's saved name;
// nameless runs (and runs with no History entry) fall back to a date stamp.
//
// `value` is a `string[]` of run ids; empty = every run of the selected
// material(s).

import { useEffect, useMemo, useState } from 'react'
import { scopeToSelectValue, type DeviceScope } from '../../../shared/types/analyze-filters'
import type { TypingTestResult } from '../../../shared/types/pipette-settings'
import type { RangeMs } from './analyze-types'
import { MultiSelectPopover, type MultiSelectOption } from './MultiSelectPopover'

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

function formatDateLabel(input: string | number): string {
  // Nameless-run stamp: date only (no wpm), for both History runs without a
  // saved name (uses the saved ISO date) and History-less runs (uses the
  // analytics start minute).
  const d = new Date(input)
  return Number.isNaN(d.getTime()) ? String(input) : d.toLocaleString()
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
  const [runs, setRuns] = useState<{ runId: string; firstMs: number }[]>([])
  const [labels, setLabels] = useState<Map<string, TypingTestResult>>(new Map())
  const scope = scopeToSelectValue(deviceScopes[0] ?? 'own')
  // Stable primitive identity for the material set so the effect doesn't
  // refire on a fresh-but-equal array each render.
  const materialKey = materialScopes.join('|')

  // Run list (source of truth) — refetched on range / scope / material
  // change, debounced so range scrubbing doesn't fan out one IPC per
  // intermediate value (mirrors ScopeMultiSelect).
  useEffect(() => {
    let cancelled = false
    const id = window.setTimeout(() => {
      const materials = materialKey.length > 0 ? materialKey.split('|') : []
      window.vialAPI
        .typingAnalyticsListTypingTestRunsForRange(uid, range.fromMs, range.toMs, scope, materials)
        .then((rows) => { if (!cancelled) setRuns(rows) })
        .catch(() => { if (!cancelled) setRuns([]) })
    }, 150)
    return () => {
      cancelled = true
      window.clearTimeout(id)
    }
  }, [uid, range.fromMs, range.toMs, scope, materialKey])

  // Labels (name / wpm) keyed by run id — only depends on the keyboard, so
  // range scrubbing never re-reads settings.
  useEffect(() => {
    let cancelled = false
    window.vialAPI
      .pipetteSettingsGet(uid)
      .then((prefs) => {
        if (cancelled) return
        const byRunId = new Map<string, TypingTestResult>()
        for (const r of prefs?.typingTestResults ?? []) {
          if (r.runId) byRunId.set(r.runId, r)
        }
        setLabels(byRunId)
      })
      .catch(() => { if (!cancelled) setLabels(new Map()) })
    return () => { cancelled = true }
  }, [uid])

  const options = useMemo<MultiSelectOption[]>(
    () =>
      runs.map((run) => {
        const result = labels.get(run.runId)
        const label = result
          ? result.name || formatDateLabel(result.date)
          : formatDateLabel(run.firstMs)
        return { value: run.runId, label }
      }),
    [runs, labels],
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
