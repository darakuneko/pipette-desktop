// SPDX-License-Identifier: GPL-2.0-or-later
// Second-level Analyze filter: once one or more TypingTest materials are
// chosen, this narrows them to specific History runs. Options come from
// the keyboard's saved typingTestResults (not a range IPC), filtered to
// the selected materials and to results that carry a runId (older results
// predate run tagging and can't be sliced). The popover UI lives in the
// shared MultiSelectPopover; this component only owns the run fetch.
//
// `value` is a `string[]` of run ids; empty = every run of the selected
// material(s).

import { useEffect, useState } from 'react'
import { typingTestResultMaterialLabel } from '../../typing-test/result-builder'
import { MultiSelectPopover, type MultiSelectOption } from './MultiSelectPopover'

interface Props {
  uid: string
  /** Selected TypingTest material labels (rawTypingTestScopes). Runs are
   *  limited to results whose material is one of these. */
  materialScopes: string[]
  value: string[]
  onChange: (next: string[]) => void
  ariaLabel?: string
  testId?: string
}

function formatRunLabel(date: string, wpm: number): string {
  // Compact, locale-aware run stamp for unnamed results.
  const d = new Date(date)
  const stamp = Number.isNaN(d.getTime()) ? date : d.toLocaleString()
  return `${stamp} · ${wpm} wpm`
}

export function RunSelect({
  uid,
  materialScopes,
  value,
  onChange,
  ariaLabel,
  testId = 'analyze-filter-run',
}: Props) {
  const [options, setOptions] = useState<MultiSelectOption[]>([])
  // Stable primitive identity for the material set so the effect doesn't
  // refire on a fresh-but-equal array each render; the set is rebuilt from
  // it inside the effect so the raw array stays out of the deps.
  const materialKey = materialScopes.join('|')

  useEffect(() => {
    let cancelled = false
    const materials = new Set(materialKey.length > 0 ? materialKey.split('|') : [])
    window.vialAPI
      .pipetteSettingsGet(uid)
      .then((prefs) => {
        if (cancelled) return
        const seen = new Set<string>()
        const next: MultiSelectOption[] = []
        for (const r of prefs?.typingTestResults ?? []) {
          if (!r.runId || seen.has(r.runId)) continue
          if (!materials.has(typingTestResultMaterialLabel(r))) continue
          seen.add(r.runId)
          next.push({ value: r.runId, label: r.name || formatRunLabel(r.date, r.wpm) })
        }
        setOptions(next)
      })
      .catch(() => { if (!cancelled) setOptions([]) })
    return () => { cancelled = true }
  }, [uid, materialKey])

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
