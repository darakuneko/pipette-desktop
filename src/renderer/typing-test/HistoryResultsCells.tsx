// SPDX-License-Identifier: GPL-2.0-or-later

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SquarePen } from 'lucide-react'
import { ICON_SM } from '../constants/ui-tokens'
import type { TypingTestResult } from '../../shared/types/pipette-settings'
import { buildResultNameChips } from './result-builder'
import { formatConditionLabel } from './condition-label'
import { ResultNameModal } from './ResultNameModal'
import { Tooltip } from '../components/ui/Tooltip'

export type SortColumn = 'date' | 'wpm' | 'kpm' | 'accuracy' | 'avgHold' | 'mode' | 'duration'
export type SortDirection = 'asc' | 'desc'

/** Mode-column detail. FileImport (imported-text) runs show the snapshotted text
 *  name (falling back to the stable textId for legacy rows saved before the
 *  name was captured); words/time/quote show their `mode2` value verbatim.
 *  Tatoeba is NOT handled here — its `mode2` is a composite
 *  `language|pattern|count` (see `deriveMode2`), so the Mode column renders
 *  it via `formatConditionLabel` instead of this raw value. */
export function modeDetail(r: TypingTestResult): string {
  if (r.mode === 'fileImport') return r.fileImportTextName ?? (r.mode2 != null ? String(r.mode2) : '')
  return r.mode2 != null ? String(r.mode2) : ''
}

interface StatItemProps {
  label: string
  value: number | string
  highlight?: boolean
}

export function StatItem({ label, value, highlight }: StatItemProps) {
  return (
    // Baseline-align so the mono value digits sit level with the sans label
    // (their font metrics differ, so items-center looks vertically off).
    <div className="flex items-baseline gap-1.5">
      <span className="text-content-muted">{label}:</span>
      <span className={`font-mono font-semibold ${highlight ? 'text-accent' : ''}`}>{value}</span>
    </div>
  )
}

function sortIndicator(direction: SortDirection): string {
  return direction === 'asc' ? ' ▲' : ' ▼'
}

interface SortableHeaderProps {
  column: SortColumn
  label: string
  /** Full-length label shown via hover tooltip when `label` itself is an
   *  abbreviation (e.g. avgHold's "AKH" header) — omitted for every other
   *  column, whose label is already the full text. */
  tooltip?: string
  /** Fallback width class used only while `width` is absent (jsdom /
   *  pre-measurement render). Omitted entirely for the flexible Mode
   *  column, which must stay width-less so table-fixed lets it share the
   *  leftover width with Name. */
  widthClassName?: string
  /** Measured runtime width (px) for this snug column from
   *  useHistoryColumnWidths — wins over `widthClassName` when present. */
  width?: number
  sortColumn: SortColumn
  sortDirection: SortDirection
  onSort: (column: SortColumn) => void
}

export function SortableHeader({
  column,
  label,
  tooltip,
  widthClassName,
  width,
  sortColumn,
  sortDirection,
  onSort,
}: SortableHeaderProps) {
  const isActive = column === sortColumn
  const ariaSort = isActive
    ? (sortDirection === 'asc' ? 'ascending' : 'descending')
    : 'none'

  const button = (
    <button
      type="button"
      // `block w-full truncate` — a plain <button> is inline-block by
      // default, which shrink-to-fits to its text content and ignores the
      // fixed-layout `<th>`'s own (narrower, percentage-based) width. Left
      // as inline-block, a long label like "Accuracy" visually overflows
      // into the neighboring column once the table gets narrow enough
      // (e.g. the modal near its 95vw viewport floor). Forcing block +
      // w-full ties the button to its th's real width, and truncate
      // ellipsizes gracefully instead of bleeding into the next column.
      className="block w-full truncate text-left cursor-pointer select-none bg-transparent text-inherit"
      onClick={() => onSort(column)}
    >
      {label}{isActive ? sortIndicator(sortDirection) : ''}
    </button>
  )

  return (
    <th
      className={`${width == null ? widthClassName ?? '' : ''} px-3 py-1.5`}
      style={width != null ? { width } : undefined}
      aria-sort={ariaSort}
    >
      {/* Tooltip must wrap the button itself (not an inner span) — its
       *  wrapper renders a div, and a div can't legally nest inside a
       *  button; wrapping the span also left aria-describedby on a
       *  non-focusable element, so neither assistive tech nor keyboard
       *  focus could reach the full-label description. Same pattern
       *  NameCell already uses below for its rename button. */}
      {tooltip ? <Tooltip content={tooltip}>{button}</Tooltip> : button}
    </th>
  )
}

interface NameCellProps {
  result: TypingTestResult
  onRename?: (date: string, name: string) => void
  deviceName?: string
}

/** Result label cell. A button (edit icon + current name / "Unnamed") that
 *  opens the naming modal with quick-insert chips. Read-only when no rename
 *  handler is provided. No max-w cap on the `<td>` here — the table is
 *  `table-fixed` (see COL_NAME above), so this column's width is already
 *  fixed by the header row; the inner `block truncate` span gets its
 *  definite width for free from that fixed cell, and only ellipsizes once
 *  the name actually exceeds its allocated share. */
export function NameCell({ result, onRename, deviceName }: NameCellProps) {
  const { t } = useTranslation()
  const [modalOpen, setModalOpen] = useState(false)
  const placeholder = t('editor.typingTest.history.unnamed')

  const display = result.name || placeholder

  if (!onRename) {
    return (
      <td className="px-3 py-1.5 text-content-muted">
        <Tooltip content={display} wrapperClassName="block max-w-full">
          <span className="block truncate">{display}</span>
        </Tooltip>
      </td>
    )
  }

  return (
    <td className="px-3 py-1.5">
      <Tooltip content={display} wrapperClassName="block max-w-full">
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className={`flex w-full items-center gap-1.5 text-left transition-colors hover:text-content ${result.name ? 'text-content-secondary' : 'text-content-muted'}`}
          data-testid={`history-name-${result.date}`}
        >
          <SquarePen size={ICON_SM} aria-hidden="true" className="shrink-0" />
          <span className="min-w-0 truncate">{display}</span>
        </button>
      </Tooltip>
      {modalOpen && (
        <ResultNameModal
          initialName={result.name ?? ''}
          chips={buildResultNameChips(result, t, deviceName)}
          onSave={(name) => onRename(result.date, name)}
          onClose={() => setModalOpen(false)}
        />
      )}
    </td>
  )
}

interface ModeCellProps {
  r: TypingTestResult
  isText: boolean
}

/** Mode/Text column cell. Its text is variable-width (a Tatoeba row's
 *  composite label can run to "Tatoeba 10 Lines (japanese_hiragana)") — same
 *  truncate + hover-tooltip treatment as the Name column, so a long value
 *  ellipsizes instead of stretching or wrapping the table. Same no-max-w
 *  reasoning as NameCell above: COL_MODE on the header fixes this column's
 *  width, so the `<td>` needs no cap of its own. */
export function ModeCell({ r, isText }: ModeCellProps) {
  const { t } = useTranslation()
  const text = isText
    ? (modeDetail(r) || t('editor.typingTest.history.unnamed'))
    // Tatoeba's mode2 is a composite (language|pattern|count, see
    // deriveMode2) — formatConditionLabel already knows how to
    // render it (e.g. "Tatoeba 5 Lines (english)").
    : (r.mode === 'tatoeba'
      ? formatConditionLabel(r, t)
      : `${t(`editor.typingTest.mode.${r.mode ?? 'words'}`)}${modeDetail(r) ? ` ${modeDetail(r)}` : ''}`)

  return (
    <td className="px-3 py-1.5 text-content-muted">
      <Tooltip content={text} wrapperClassName="block max-w-full">
        <span className="block truncate">{text}</span>
      </Tooltip>
    </td>
  )
}
