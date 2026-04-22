// SPDX-License-Identifier: GPL-2.0-or-later
// Shared text-summary row rendered below each Analyze chart body.
// Layout-only component — every page decides its own item list and
// ARIA label via the i18n keys passed in.

import { useTranslation } from 'react-i18next'

export interface AnalyzeSummaryItem {
  labelKey: string
  value: string
  /** Optional small-text suffix shown next to the value (e.g. "WPM",
   * "keys"). Ignored by {@link AnalyzeSummaryTable}; consumed by the
   * card-grid renderer. */
  unit?: string
  /** Optional second line below the value (e.g. "323 keys" underneath
   * a "Tue" dow label). Ignored by {@link AnalyzeSummaryTable}. */
  context?: string
  /** Optional i18n key for a hover tooltip describing the stat.
   * Ignored by {@link AnalyzeSummaryTable}; consumed by the
   * card-grid renderer. */
  descriptionKey?: string
}

interface Props {
  items: ReadonlyArray<AnalyzeSummaryItem>
  ariaLabelKey: string
  /** `data-testid` on the container. Defaults to a generic value so
   * callers that don't customise it can still target the row in tests. */
  testId?: string
}

export function AnalyzeSummaryTable({ items, ariaLabelKey, testId = 'analyze-summary' }: Props) {
  const { t } = useTranslation()
  return (
    <div
      className="grid shrink-0 grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-x-4 gap-y-1 border-t border-edge pt-2 text-[12px]"
      data-testid={testId}
      aria-label={t(ariaLabelKey)}
    >
      {items.map((r) => (
        <div key={r.labelKey} className="flex items-baseline justify-between gap-2">
          <span className="text-content-muted">{t(r.labelKey)}</span>
          <span className="font-medium text-content">{r.value}</span>
        </div>
      ))}
    </div>
  )
}
