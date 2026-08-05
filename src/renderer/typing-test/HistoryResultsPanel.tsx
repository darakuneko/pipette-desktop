// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Trophy, SquarePen } from 'lucide-react'
import { ICON_SM } from '../constants/ui-tokens'
import type { TypingTestResult } from '../../shared/types/pipette-settings'
import { computeStats } from './history-stats'
import { formatDate, ACTION_BTN, DELETE_BTN, CONFIRM_DELETE_BTN, FILTER_SELECT_CLASS } from '../components/editors/store-modal-shared'
import { resultKpm, resultAvgHoldMs, buildResultNameChips } from './result-builder'
import { formatConditionLabel } from './condition-label'
import { ResultNameModal } from './ResultNameModal'
import { Tooltip } from '../components/ui/Tooltip'
import { formatDuration, fmtMs } from '../components/analyze/analyze-format'
import { HistoryTimelineCell } from './HistoryTimelineCell'
import { EMPTY_RUN_ID_SET } from '../hooks/useRunLogAvailability'
import { WpmTrendChart } from './WpmTrendChart'
import { aggregateWpmByDay } from './wpm-daily-trend'

type ModeFilter = 'all' | 'words' | 'time' | 'quote'
type SortColumn = 'date' | 'wpm' | 'kpm' | 'accuracy' | 'avgHold' | 'mode' | 'duration'
type SortDirection = 'asc' | 'desc'
/** Source-tab split: MonkeyType (words/time/quote) keeps the mode dropdown;
 *  Tatoeba has no sub-filter (the Analysis condition selector already
 *  covers per-condition grouping); Aozora and File Import both scope the
 *  text dropdown to their own subset of imported texts (source.provider
 *  'aozora' vs everything else — see TypingTestHistory's classification).
 *  'text' (not 'fileImport') is kept as the File Import tab's key to avoid
 *  churn across existing testids/CSV slugs. */
type HistoryTab = 'monkeytype' | 'tatoeba' | 'aozora' | 'text'
export type { SortColumn, SortDirection, HistoryTab }

const MAX_TABLE_ROWS = 20
const MODE_FILTERS: ModeFilter[] = ['all', 'words', 'time', 'quote']

const EXPORT_BTN_CLASS = 'inline-flex h-8 items-center rounded-md border border-edge px-2.5 text-xs text-content-secondary transition-colors hover:text-content'

// Column width allocation for the fixed-layout Results table (`table-fixed`
// below) — every header cell carries one of these so the table always spans
// the full available width (no leftover space, no horizontal scroll)
// instead of auto-sizing to content. With table-fixed, ONLY the header
// row's widths matter (subsequent rows never affect column sizing per the
// CSS table-layout algorithm), so these constants are applied to the
// `<th>` elements only — body `<td>`s inherit their column's width for
// free. Name/Mode get the flexible majority share (their text is
// variable-width and ellipsis-truncates via Tooltip when it doesn't fit,
// see NameCell/ModeCell); every other column is sized to its known-narrow
// content (numeric values, short buttons/icons). Sums to 100%.
const COL_NAME = 'w-[16%]'
const COL_DATE = 'w-[13%]'
const COL_WPM = 'w-[6%]'
const COL_KPM = 'w-[6%]'
// "Accuracy" (8 chars) is the longest plain-word header in the row — at
// 7% its own sortable button (block + truncate, so it strictly respects
// the column's fixed width — see SortableHeader) ellipsized even at the
// full MODAL_2XL width. Bumped to 9%, borrowed from Name/Mode's generous
// share, rather than ship a header that truncates at the un-narrowed
// width the wider modal was meant to buy back.
const COL_ACCURACY = 'w-[9%]'
const COL_AKH = 'w-[6%]'
const COL_MODE = 'w-[14%]'
const COL_DURATION = 'w-[6%]'
const COL_PB = 'w-[5%]'
const COL_TIMELINE = 'w-[7%]'
// The confirm-delete state (see below) packs two buttons — labels come
// from i18n (common.confirmDelete/cancel) and run considerably longer in
// some packs than English's "Delete?"/"Cancel" — bumped from the plain
// Delete button's minimum, borrowed from Name/Mode's generous share.
const COL_DELETE = 'w-[12%]'

/** Mode-column detail. FileImport (imported-text) runs show the snapshotted text
 *  name (falling back to the stable textId for legacy rows saved before the
 *  name was captured); words/time/quote show their `mode2` value verbatim.
 *  Tatoeba is NOT handled here — its `mode2` is a composite
 *  `language|pattern|count` (see `deriveMode2`), so the Mode column renders
 *  it via `formatConditionLabel` instead of this raw value. */
function modeDetail(r: TypingTestResult): string {
  if (r.mode === 'fileImport') return r.fileImportTextName ?? (r.mode2 != null ? String(r.mode2) : '')
  return r.mode2 != null ? String(r.mode2) : ''
}

interface Props {
  /** Active source tab. Drives which sub-filter (mode dropdown / text
   *  dropdown / none) renders and the Mode-vs-Text column label below — the
   *  parent owns the state and the filtered result set; this panel only
   *  renders the UI. */
  tab: HistoryTab
  modeFilter: ModeFilter
  onModeFilterChange: (mode: ModeFilter) => void
  /** Text-tab filter value, already resolved against `fileImportTexts` by the
   *  parent (falls back to 'all' when the selected text no longer exists). */
  effectiveTextFilter: string
  onTextFilterChange: (value: string) => void
  fileImportTexts: { id: string, name: string }[]
  /** Rows already scoped to the active source tab + mode/text filter. */
  filtered: TypingTestResult[]
  /** Sort state is owned by the parent (TypingTestHistory), not this panel —
   *  this component unmounts while the Analysis view is active (conditional
   *  render), so panel-local sort state would silently reset on every
   *  Results→Analysis→Results round trip. Delete-confirm and the rename
   *  modal stay panel-local below: both are transient interactions where a
   *  reset on tab switch is expected/safe, unlike a deliberate sort choice. */
  sortColumn: SortColumn
  sortDirection: SortDirection
  onSort: (column: SortColumn) => void
  /** Bound export handler — `undefined` hides the button entirely (mirrors
   *  the parent's optional `onExportCsv` prop). */
  onExport?: () => void
  onRename?: (date: string, name: string) => void
  onDelete?: (date: string) => void
  deviceName?: string
  uid?: string
  availableRunIds?: ReadonlySet<string>
  /** ARIA tabpanel wiring for the History modal's Results/Analysis secondary
   *  tabs (TypingTestHistory) — applied directly to this component's own
   *  root div rather than an extra wrapper div in the caller. See
   *  HistorySections' matching prop doc for why an intermediate plain block
   *  div is unsafe here (breaks the flex min-h-0/shrink/overflow chain). */
  id: string
  ariaLabelledBy: string
}

/** Results view of the History modal: sub-filter row (mode/text dropdown +
 *  Export CSV), sparkline, stats summary, results table. Split out of
 *  `TypingTestHistory` so that file (which also owns the Analysis view
 *  switch) stays under the project's 500-line UI-component size cap. */
export function HistoryResultsPanel({
  tab,
  modeFilter,
  onModeFilterChange,
  effectiveTextFilter,
  onTextFilterChange,
  fileImportTexts,
  filtered,
  sortColumn,
  sortDirection,
  onSort,
  onExport,
  onRename,
  onDelete,
  deviceName,
  uid,
  availableRunIds,
  id,
  ariaLabelledBy,
}: Props) {
  const { t } = useTranslation()
  const [confirmDeleteDate, setConfirmDeleteDate] = useState<string | null>(null)

  // Text-style rendering (imported-text name in the Mode/Text column instead
  // of the mode label) applies to both Aozora and File Import — they're the
  // same fileImport row shape, just scoped to a different text subset.
  const isText = tab === 'aozora' || tab === 'text'
  const showModeFilter = tab === 'monkeytype'
  const showTextFilter = isText
  // Tatoeba has no sub-filter dropdown at all — without this guard the
  // filter row would render as an empty div (no dropdown, no button now
  // that Export CSV lives on the stats row instead).
  const showFilterRow = showModeFilter || (showTextFilter && fileImportTexts.length > 0)

  const stats = useMemo(() => computeStats(filtered), [filtered])
  // Computed once here (not inside WpmTrendChart) so the same per-day
  // grouping drives both the "WPM Trend" heading's visibility gate and the
  // chart's own data — a single pass over `filtered` instead of running
  // the identical aggregation twice per render.
  const dailyTrend = useMemo(() => aggregateWpmByDay(filtered), [filtered])

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      let cmp = 0
      switch (sortColumn) {
        case 'date':
          cmp = new Date(a.date).getTime() - new Date(b.date).getTime()
          break
        case 'wpm':
          cmp = a.wpm - b.wpm
          break
        case 'kpm':
          cmp = resultKpm(a) - resultKpm(b)
          break
        case 'accuracy':
          cmp = a.accuracy - b.accuracy
          break
        case 'avgHold': {
          // A legacy row with no raw holdSumMs/holdSamples pair sorts as
          // the lowest possible value (-1, below any real non-negative
          // ms mean) rather than being excluded from sort order entirely.
          const a1 = resultAvgHoldMs(a) ?? -1
          const b1 = resultAvgHoldMs(b) ?? -1
          cmp = a1 - b1
          break
        }
        case 'mode': {
          // Sort by what the Mode column actually shows (text name for fileImport),
          // so fileImport rows order by name rather than an opaque textId.
          const modeA = `${a.mode ?? ''}${modeDetail(a)}`
          const modeB = `${b.mode ?? ''}${modeDetail(b)}`
          cmp = modeA.localeCompare(modeB)
          break
        }
        case 'duration':
          cmp = a.durationSeconds - b.durationSeconds
          break
      }
      return sortDirection === 'asc' ? cmp : -cmp
    }).slice(0, MAX_TABLE_ROWS)
  }, [filtered, sortColumn, sortDirection])

  return (
    <div
      role="tabpanel"
      id={id}
      aria-labelledby={ariaLabelledBy}
      className="flex min-h-0 flex-1 flex-col gap-3"
    >
      {/* Sub-filter — mode dropdown for Monkeytype, text dropdown for Text.
          Both selects feed `filtered`, so the stats row and the sparkline
          reflect the current selection too. Tatoeba has neither dropdown, so
          the row is omitted entirely rather than rendering empty
          (see `showFilterRow`). */}
      {showFilterRow && (
        <div className="flex items-center gap-2">
          {showModeFilter && (
            <select
              data-testid="history-filter-mode"
              aria-label={t('editor.typingTest.history.filterMode')}
              className={FILTER_SELECT_CLASS}
              value={modeFilter}
              onChange={(e) => onModeFilterChange(e.target.value as ModeFilter)}
            >
              {MODE_FILTERS.map((mode) => (
                <option key={mode} value={mode}>
                  {mode === 'all'
                    ? t('editor.typingTest.history.allModes')
                    : t(`editor.typingTest.mode.${mode}`)}
                </option>
              ))}
            </select>
          )}
          {showTextFilter && fileImportTexts.length > 0 && (
            <select
              data-testid="history-filter-text"
              aria-label={t('editor.typingTest.history.filterText')}
              className={FILTER_SELECT_CLASS}
              value={effectiveTextFilter}
              onChange={(e) => onTextFilterChange(e.target.value)}
            >
              <option value="all">{t('editor.typingTest.history.allModes')}</option>
              {fileImportTexts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name || t('editor.typingTest.history.unnamed')}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {/* WPM trend — chart-above-stats, matching every other Analyze section's
          order (and the Accuracy Trend section's own heading + chart shape).
          `dailyTrend` is derived from the same `filtered` set the table/stats
          row below uses (not a separately-capped slice), grouped into one
          best/worst/avg point per local calendar day — a busy multi-test day
          collapses to a single point instead of stacking a vertical cluster
          of raw results. */}
      {dailyTrend.length >= 2 && (
        <div className="flex flex-col gap-2" data-testid="history-sparkline">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-content-muted">
            {t('editor.typingTest.history.wpmTrendTitle')}
          </h3>
          <WpmTrendChart data={dailyTrend} />
        </div>
      )}

      {/* Stats summary — Export CSV rides along at the right end (ml-auto) so
          it stays on the same line as the stats instead of the now-optional
          sub-filter row above. */}
      <div className="flex flex-wrap items-center gap-6 text-sm" data-testid="history-stats">
        <StatItem label={t('editor.typingTest.history.bestWpm')} value={stats.bestWpm} highlight />
        <StatItem label={t('editor.typingTest.history.avgWpm')} value={stats.avgWpm} />
        <StatItem label={t('editor.typingTest.history.last10Avg')} value={stats.last10Avg} />
        <StatItem label={t('editor.typingTest.history.totalTests')} value={stats.totalTests} />
        <StatItem label={t('editor.typingTest.history.avgAccuracy')} value={`${stats.avgAccuracy}%`} />
        {onExport && (
          <button
            type="button"
            data-testid="history-export-csv"
            className={`ml-auto ${EXPORT_BTN_CLASS}`}
            onClick={onExport}
          >
            {t('editor.typingTest.history.exportCsv')}
          </button>
        )}
      </div>

      {/* Results table — fills remaining height, never collapses below min-h-48 */}
      <div className="min-h-48 flex-1 overflow-y-auto rounded-lg border border-edge">
        {sorted.length > 0 ? (
          <table className="w-full table-fixed text-left text-xs">
            <thead className="sticky top-0 bg-surface-alt text-content-muted">
              <tr>
                <th className={`${COL_NAME} px-3 py-1.5`}>{t('editor.typingTest.history.name')}</th>
                <SortableHeader widthClassName={COL_DATE} column="date" label={t('editor.typingTest.history.date')} sortColumn={sortColumn} sortDirection={sortDirection} onSort={onSort} />
                <SortableHeader widthClassName={COL_WPM} column="wpm" label={t('editor.typingTest.wpm')} sortColumn={sortColumn} sortDirection={sortDirection} onSort={onSort} />
                <SortableHeader widthClassName={COL_KPM} column="kpm" label={t('editor.typingTest.kpm')} sortColumn={sortColumn} sortDirection={sortDirection} onSort={onSort} />
                <SortableHeader widthClassName={COL_ACCURACY} column="accuracy" label={t('editor.typingTest.accuracy')} sortColumn={sortColumn} sortDirection={sortDirection} onSort={onSort} />
                <SortableHeader
                  widthClassName={COL_AKH}
                  column="avgHold"
                  label={t('editor.typingTest.history.avgHoldAbbr')}
                  tooltip={t('editor.typingTest.history.avgHold')}
                  sortColumn={sortColumn}
                  sortDirection={sortDirection}
                  onSort={onSort}
                />
                <SortableHeader widthClassName={COL_MODE} column="mode" label={isText ? t('editor.typingTest.history.tabText') : t('editor.typingTest.history.mode')} sortColumn={sortColumn} sortDirection={sortDirection} onSort={onSort} />
                <SortableHeader widthClassName={COL_DURATION} column="duration" label={t('editor.typingTest.time')} sortColumn={sortColumn} sortDirection={sortDirection} onSort={onSort} />
                <th className={`${COL_PB} px-3 py-1.5`}>{t('editor.typingTest.history.pb')}</th>
                {uid && <th className={`${COL_TIMELINE} px-3 py-1.5`} aria-label={t('editor.typingTest.history.timeline.modalTitle')} />}
                {onDelete && <th className={`${COL_DELETE} px-3 py-1.5`} aria-label={t('editor.typingTest.history.delete')} />}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr
                  key={r.date}
                  className="border-t border-edge/50 transition-colors hover:bg-surface-alt/50"
                >
                  <NameCell result={r} onRename={onRename} deviceName={deviceName} />
                  <td className="whitespace-nowrap px-3 py-1.5 text-content-muted">{formatDate(r.date)}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono font-semibold text-accent">{r.wpm}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono font-semibold text-accent">{resultKpm(r)}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono">{r.accuracy}%</td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-content-muted">{fmtMs(resultAvgHoldMs(r))}</td>
                  <ModeCell r={r} isText={isText} />
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-content-muted">
                    {formatDuration(r.durationSeconds)}
                  </td>
                  <td className="px-3 py-1.5">
                    {r.isPb && <Trophy role="img" className="inline-block size-3.5 text-warning" aria-label={t('editor.typingTest.history.pb')} />}
                  </td>
                  {uid && <HistoryTimelineCell result={r} uid={uid} availableRunIds={availableRunIds ?? EMPTY_RUN_ID_SET} />}
                  {onDelete && (
                    <td className="px-3 py-1.5">
                      {confirmDeleteDate === r.date ? (
                        // flex-wrap: the confirm/cancel labels come from
                        // i18n (common.confirmDelete/cancel) and some
                        // packs run considerably longer than English's
                        // "Delete?"/"Cancel" — with the column's width now
                        // hard-capped by table-fixed (COL_DELETE), letting
                        // Cancel wrap to its own line degrades gracefully
                        // instead of overflowing past the table's edge.
                        <div className="flex flex-wrap items-center gap-0.5">
                          <button
                            type="button"
                            className={CONFIRM_DELETE_BTN}
                            onClick={() => { onDelete(r.date); setConfirmDeleteDate(null) }}
                            data-testid={`history-delete-confirm-${r.date}`}
                          >
                            {t('common.confirmDelete')}
                          </button>
                          <button
                            type="button"
                            className={ACTION_BTN}
                            onClick={() => setConfirmDeleteDate(null)}
                            data-testid={`history-delete-cancel-${r.date}`}
                          >
                            {t('common.cancel')}
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className={DELETE_BTN}
                          onClick={() => setConfirmDeleteDate(r.date)}
                          data-testid={`history-delete-${r.date}`}
                        >
                          {t('common.delete')}
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="p-6 text-center text-sm text-content-muted">
            {t('editor.typingTest.history.noResults')}
          </p>
        )}
      </div>
    </div>
  )
}

interface StatItemProps {
  label: string
  value: number | string
  highlight?: boolean
}

function StatItem({ label, value, highlight }: StatItemProps) {
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
  /** This column's share of the fixed-layout table's width (one of the
   *  `COL_*` constants above) — required so every column call site stays
   *  accounted for in the 100% allocation; there's no sane default width
   *  for an arbitrary column. */
  widthClassName: string
  sortColumn: SortColumn
  sortDirection: SortDirection
  onSort: (column: SortColumn) => void
}

function SortableHeader({
  column,
  label,
  tooltip,
  widthClassName,
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
    <th className={`${widthClassName} px-3 py-1.5`} aria-sort={ariaSort}>
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
function NameCell({ result, onRename, deviceName }: NameCellProps) {
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
function ModeCell({ r, isText }: ModeCellProps) {
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

export type { ModeFilter }
