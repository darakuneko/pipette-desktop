// SPDX-License-Identifier: GPL-2.0-or-later
// Shared presentational shells for the Analyze Bigrams quadrants — the
// generic quadrant card, its limit/threshold header controls, the
// empty-state placeholder, and the 2-gram/3-gram toggle. Split out of
// BigramsChart.tsx so the quadrant-specific implementations
// (BigramsRankingTables.tsx, BigramsFingerQuadrant.tsx,
// BigramsClassesQuadrant.tsx) can share these without duplicating them.

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FILTER_SELECT, LIST_LIMIT_OPTIONS } from './analyze-filter-styles'
import { SegmentedToggle } from './SegmentedToggle'

interface QuadrantProps {
  title: string
  controls?: React.ReactNode
  /** Optional single-line notice rendered under the title/controls row
   * (e.g. the top-N cap warning). Absent by default. */
  notice?: React.ReactNode
  children: React.ReactNode
}

function Quadrant({ title, controls, notice, children }: QuadrantProps): JSX.Element {
  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-2 rounded border border-edge p-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-xs font-medium text-content">{title}</div>
        {controls}
      </div>
      {notice}
      <div className="min-h-0 flex-1 overflow-auto pr-1">{children}</div>
    </div>
  )
}

function EmptyQuadrant({ text, testId }: { text: string; testId?: string }): JSX.Element {
  return (
    <div className="py-4 text-center text-xs text-content-muted" data-testid={testId}>
      {text}
    </div>
  )
}

interface LimitSelectProps {
  value: number
  onChange: (next: number) => void
  testId: string
}

function LimitSelect({ value, onChange, testId }: LimitSelectProps): JSX.Element {
  const options = LIST_LIMIT_OPTIONS.includes(value)
    ? LIST_LIMIT_OPTIONS
    : [...LIST_LIMIT_OPTIONS, value].sort((a, b) => a - b)
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      data-testid={testId}
      className={FILTER_SELECT}
    >
      {options.map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </select>
  )
}

interface PairIntervalThresholdInputProps {
  value: number
  onChange: (next: number) => void
  testId: string
}

/** Compact `[label] [N] [suffix]` control rendered in both fingerIki
 * and slow quadrant headers. The local draft state lets the user blank
 * the field mid-edit without leaking '' upstream — the parent is only
 * notified on blur / Enter, and an empty draft commits as `0`. */
function PairIntervalThresholdInput({
  value,
  onChange,
  testId,
}: PairIntervalThresholdInputProps): JSX.Element {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<string>(String(value))

  // Sync the draft when the sibling quadrant's input commits a change.
  useEffect(() => {
    setDraft(String(value))
  }, [value])

  const commit = (raw: string): void => {
    const trimmed = raw.trim()
    const parsed = trimmed === '' ? 0 : Math.max(0, Math.floor(Number(trimmed)))
    const next = Number.isFinite(parsed) ? parsed : 0
    setDraft(String(next))
    if (next !== value) onChange(next)
  }

  return (
    <span className="inline-flex items-center gap-1 text-xs text-content-muted">
      <span>{t('analyze.bigrams.pairIntervalThreshold.label')}</span>
      <input
        type="number"
        inputMode="numeric"
        min={0}
        step={1}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur()
          }
        }}
        aria-label={t('analyze.bigrams.pairIntervalThreshold.ariaLabel')}
        data-testid={testId}
        className="w-14 rounded border border-edge bg-surface px-1 py-0.5 text-right tabular-nums text-content focus:border-accent focus:outline-none"
      />
      <span>{t('analyze.bigrams.pairIntervalThreshold.suffix')}</span>
    </span>
  )
}

const GRAM_OPTIONS: readonly (2 | 3)[] = [2, 3]

const GRAM_LABEL_KEY: Record<2 | 3, string> = {
  2: 'analyze.bigrams.gramToggle.bigram',
  3: 'analyze.bigrams.gramToggle.trigram',
}

interface GramToggleProps {
  value: 2 | 3
  onChange: (next: 2 | 3) => void
}

/** Segmented 2-gram / 3-gram switch — built from the same
 * `SegmentedToggle` primitive as `FilterDimensionToggle` so the Bigrams
 * tab's own toggle reads as the same control family as the rest of the
 * Analyze filter row. */
function GramToggle({ value, onChange }: GramToggleProps): JSX.Element {
  const { t } = useTranslation()
  return (
    <SegmentedToggle
      options={GRAM_OPTIONS}
      value={value}
      onChange={onChange}
      labelFor={(option) => t(GRAM_LABEL_KEY[option])}
      ariaLabel={t('analyze.bigrams.gramToggle.ariaLabel')}
      testId="analyze-bigrams-gram-toggle"
    />
  )
}

export type {
  QuadrantProps,
  LimitSelectProps,
  PairIntervalThresholdInputProps,
  GramToggleProps,
}
export {
  Quadrant,
  EmptyQuadrant,
  LimitSelect,
  PairIntervalThresholdInput,
  GramToggle,
  GRAM_OPTIONS,
  GRAM_LABEL_KEY,
}
