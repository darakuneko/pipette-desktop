// SPDX-License-Identifier: GPL-2.0-or-later
//
// Side-by-side metric table for the Layout Comparison Phase 1 view.
// Rows are the four Phase 1 metrics (finger load by finger, hand
// balance by side, row distribution by row category, home-row stay
// rate). Columns are one per `LayoutComparisonTargetResult` returned
// by the IPC — by convention the first entry is the user's current
// layout (source = first target) and the rest are candidates.

import { useTranslation } from 'react-i18next'
import { FINGER_LIST } from '../../../shared/kle/kle-ergonomics'
import { ROW_ORDER } from './analyze-ergonomics'
import { formatPercentLabel } from './analyze-format'
import type { LayoutComparisonTargetResult } from '../../../shared/types/typing-analytics'

interface Props {
  /** Header label for each column. Length must match `targets`. */
  columnLabels: string[]
  targets: LayoutComparisonTargetResult[]
}

export function LayoutComparisonMetricTable({ columnLabels, targets }: Props): JSX.Element {
  const { t } = useTranslation()
  const columnCount = targets.length
  return (
    <table
      className="w-full table-fixed border-collapse text-[12px]"
      data-testid="analyze-layout-comparison-metric-table"
    >
      <thead>
        <tr className="border-b border-edge text-left text-content-secondary">
          <th className="py-1 pr-3 font-medium">
            {t('analyze.layoutComparison.headers.metric')}
          </th>
          {columnLabels.map((label, idx) => (
            <th
              key={`${label}-${idx}`}
              className="py-1 pr-3 font-medium"
              data-testid={`analyze-layout-comparison-col-${idx}`}
            >
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        <SectionHeader colSpan={columnCount + 1} label={t('analyze.layoutComparison.metrics.fingerLoad')} />
        {FINGER_LIST.map((finger) => (
          <Row
            key={finger}
            label={t(`analyze.ergonomics.finger.${finger}`)}
            cells={targets.map((target) => formatPercentLabel(target.fingerLoad?.[finger]))}
          />
        ))}

        <SectionHeader colSpan={columnCount + 1} label={t('analyze.layoutComparison.metrics.handBalance')} />
        <Row
          label={t('analyze.ergonomics.hand.left')}
          cells={targets.map((target) => formatPercentLabel(target.handBalance?.left))}
        />
        <Row
          label={t('analyze.ergonomics.hand.right')}
          cells={targets.map((target) => formatPercentLabel(target.handBalance?.right))}
        />

        <SectionHeader colSpan={columnCount + 1} label={t('analyze.layoutComparison.metrics.rowDist')} />
        {ROW_ORDER.map((row) => (
          <Row
            key={row}
            label={t(`analyze.ergonomics.rowCategory.${row}`)}
            cells={targets.map((target) => formatPercentLabel(target.rowDist?.[row]))}
          />
        ))}

        <SectionHeader colSpan={columnCount + 1} label={t('analyze.layoutComparison.metrics.homeRow')} />
        <Row
          label={t('analyze.ergonomics.rowCategory.home')}
          cells={targets.map((target) => formatPercentLabel(target.homeRowStay))}
        />
      </tbody>
    </table>
  )
}

function SectionHeader({ colSpan, label }: { colSpan: number; label: string }): JSX.Element {
  return (
    <tr className="bg-surface-alt">
      <th
        scope="row"
        colSpan={colSpan}
        className="py-1 pr-3 text-left text-[11px] font-semibold uppercase tracking-wide text-content-secondary"
      >
        {label}
      </th>
    </tr>
  )
}

function Row({ label, cells }: { label: string; cells: string[] }): JSX.Element {
  return (
    <tr className="border-b border-edge/60">
      <th scope="row" className="py-1 pr-3 text-left font-normal text-content-secondary">
        {label}
      </th>
      {cells.map((cell, idx) => (
        <td key={idx} className="py-1 pr-3 tabular-nums">
          {cell}
        </td>
      ))}
    </tr>
  )
}

