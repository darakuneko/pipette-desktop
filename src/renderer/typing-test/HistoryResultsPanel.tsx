// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Trophy, SquarePen } from 'lucide-react'
import { ICON_SM } from '../constants/ui-tokens'
import type { TypingTestResult } from '../../shared/types/pipette-settings'
import { computeStats } from './history-stats'
import { formatDate, ACTION_BTN, DELETE_BTN, CONFIRM_DELETE_BTN, FILTER_SELECT_CLASS } from '../components/editors/store-modal-shared'
import { resultKpm, buildResultNameChips } from './result-builder'
import { formatConditionLabel } from './condition-label'
import { ResultNameModal } from './ResultNameModal'
import { Tooltip } from '../components/ui/Tooltip'
import { formatDuration } from '../components/analyze/analyze-format'
import { HistoryTimelineCell } from './HistoryTimelineCell'
import { EMPTY_RUN_ID_SET } from '../hooks/useRunLogAvailability'
import { WpmSparkline } from './WpmSparkline'

type ModeFilter = 'all' | 'words' | 'time' | 'quote'
type SortColumn = 'date' | 'wpm' | 'kpm' | 'accuracy' | 'mode' | 'duration'
type SortDirection = 'asc' | 'desc'
export type { SortColumn, SortDirection }

const MAX_TABLE_ROWS = 20
const MAX_SPARKLINE_RESULTS = 50
const MODE_FILTERS: ModeFilter[] = ['all', 'words', 'time', 'quote']

const EXPORT_BTN_CLASS = 'inline-flex h-8 items-center rounded-md border border-edge px-2.5 text-xs text-content-secondary transition-colors hover:text-content'

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
  /** Mode filter (Monkeytype tab) vs text filter (Text tab) — the parent owns
   *  the state and the filtered result set; this panel only renders the UI. */
  isText: boolean
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
 *  switch) stays under the 500-line component cap
 *  (`.claude/rules/file-splitting.md`). */
export function HistoryResultsPanel({
  isText,
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

  const stats = useMemo(() => computeStats(filtered), [filtered])
  const sparklineResults = useMemo(
    () => filtered.slice(0, MAX_SPARKLINE_RESULTS).reverse(),
    [filtered],
  )

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
      {/* Sub-filter (mode dropdown for Monkeytype, text dropdown for Text) +
          per-tab export. Both selects feed `filtered`, so the stats row and the
          sparkline reflect the current selection too. */}
      <div className="flex items-center gap-2">
        {!isText && (
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
        {isText && fileImportTexts.length > 0 && (
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

      {/* Sparkline — chart-above-stats, matching every other Analyze section's order */}
      {sparklineResults.length >= 2 && (
        <div className="flex justify-center" data-testid="history-sparkline">
          <WpmSparkline results={sparklineResults} width={400} height={50} />
        </div>
      )}

      {/* Stats summary */}
      <div className="flex flex-wrap items-center gap-6 text-sm" data-testid="history-stats">
        <StatItem label={t('editor.typingTest.history.bestWpm')} value={stats.bestWpm} highlight />
        <StatItem label={t('editor.typingTest.history.avgWpm')} value={stats.avgWpm} />
        <StatItem label={t('editor.typingTest.history.last10Avg')} value={stats.last10Avg} />
        <StatItem label={t('editor.typingTest.history.totalTests')} value={stats.totalTests} />
        <StatItem label={t('editor.typingTest.history.avgAccuracy')} value={`${stats.avgAccuracy}%`} />
      </div>

      {/* Results table — fills remaining height, never collapses below min-h-48 */}
      <div className="min-h-48 flex-1 overflow-y-auto rounded-lg border border-edge">
        {sorted.length > 0 ? (
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-surface-alt text-content-muted">
              <tr>
                <th className="px-3 py-1.5">{t('editor.typingTest.history.name')}</th>
                <SortableHeader column="date" label={t('editor.typingTest.history.date')} sortColumn={sortColumn} sortDirection={sortDirection} onSort={onSort} />
                <SortableHeader column="wpm" label={t('editor.typingTest.wpm')} sortColumn={sortColumn} sortDirection={sortDirection} onSort={onSort} />
                <SortableHeader column="kpm" label={t('editor.typingTest.kpm')} sortColumn={sortColumn} sortDirection={sortDirection} onSort={onSort} />
                <SortableHeader column="accuracy" label={t('editor.typingTest.accuracy')} sortColumn={sortColumn} sortDirection={sortDirection} onSort={onSort} />
                <SortableHeader column="mode" label={isText ? t('editor.typingTest.history.tabText') : t('editor.typingTest.history.mode')} sortColumn={sortColumn} sortDirection={sortDirection} onSort={onSort} />
                <SortableHeader column="duration" label={t('editor.typingTest.time')} sortColumn={sortColumn} sortDirection={sortDirection} onSort={onSort} />
                <th className="px-3 py-1.5">{t('editor.typingTest.history.pb')}</th>
                {uid && <th className="px-3 py-1.5" aria-label={t('editor.typingTest.history.timeline.modalTitle')} />}
                {onDelete && <th className="px-3 py-1.5" aria-label={t('editor.typingTest.history.delete')} />}
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
                  <td className="whitespace-nowrap px-3 py-1.5 text-content-muted">
                    {isText
                      ? (modeDetail(r) || t('editor.typingTest.history.unnamed'))
                      // Tatoeba's mode2 is a composite (language|pattern|count, see
                      // deriveMode2) — formatConditionLabel already knows how to
                      // render it (e.g. "Tatoeba 5 Lines (english)").
                      : (r.mode === 'tatoeba'
                        ? formatConditionLabel(r, t)
                        : `${t(`editor.typingTest.mode.${r.mode ?? 'words'}`)}${modeDetail(r) ? ` ${modeDetail(r)}` : ''}`)}
                  </td>
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
                        <div className="flex items-center gap-0.5">
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
  sortColumn: SortColumn
  sortDirection: SortDirection
  onSort: (column: SortColumn) => void
}

function SortableHeader({
  column,
  label,
  sortColumn,
  sortDirection,
  onSort,
}: SortableHeaderProps) {
  const isActive = column === sortColumn
  const ariaSort = isActive
    ? (sortDirection === 'asc' ? 'ascending' : 'descending')
    : 'none'

  return (
    <th className="px-3 py-1.5" aria-sort={ariaSort}>
      <button
        type="button"
        className="cursor-pointer select-none bg-transparent text-inherit"
        onClick={() => onSort(column)}
      >
        {label}{isActive ? sortIndicator(sortDirection) : ''}
      </button>
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
 *  handler is provided. */
function NameCell({ result, onRename, deviceName }: NameCellProps) {
  const { t } = useTranslation()
  const [modalOpen, setModalOpen] = useState(false)
  const placeholder = t('editor.typingTest.history.unnamed')

  const display = result.name || placeholder

  if (!onRename) {
    return (
      <td className="max-w-[14rem] px-3 py-1.5 text-content-muted">
        <Tooltip content={display} wrapperClassName="block max-w-full">
          <span className="block truncate">{display}</span>
        </Tooltip>
      </td>
    )
  }

  return (
    <td className="max-w-[14rem] px-3 py-1.5">
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

export type { ModeFilter }
