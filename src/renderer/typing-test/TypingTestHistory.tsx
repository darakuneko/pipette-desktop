// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Trophy, SquarePen } from 'lucide-react'
import { ICON_SM } from '../constants/ui-tokens'
import type { TypingTestResult } from '../../shared/types/pipette-settings'
import { buildCsv } from '../../shared/csv-export'
import { computeStats } from './history-stats'
import { WpmSparkline } from './WpmSparkline'
import { formatDate, ACTION_BTN, DELETE_BTN, CONFIRM_DELETE_BTN } from '../components/editors/store-modal-shared'
import { resultKpm, buildResultNameChips } from './result-builder'
import { ResultNameModal } from './ResultNameModal'
import { Tooltip } from '../components/ui/Tooltip'

type ModeFilter = 'all' | 'words' | 'time' | 'quote'
type SortColumn = 'date' | 'wpm' | 'kpm' | 'accuracy' | 'mode' | 'duration'
type SortDirection = 'asc' | 'desc'
/** Top-level split: Monkeytype (words/time/quote) vs imported Text (custom).
 *  Their baselines aren't comparable, so stats / chart / export are separate. */
type HistoryTab = 'monkeytype' | 'text'

interface Props {
  results: TypingTestResult[]
  /** Export the currently-filtered rows. `filterSlug` describes the active
   *  tab + selection (e.g. `normal-words`, `text-Alpha`) for the filename. */
  onExportCsv?: (csv: string, filterSlug: string) => void
  /** Label a result (keyed by ISO date) for run comparison. */
  onRename?: (date: string, name: string) => void
  /** Delete a single result (keyed by ISO date). */
  onDelete?: (date: string) => void
  /** Current keyboard name, offered as a quick-insert chip when renaming. */
  deviceName?: string
}

const MAX_TABLE_ROWS = 20

const FILTER_SELECT_CLASS = 'h-8 rounded-md border border-edge bg-surface-alt px-2 text-sm text-content-secondary focus:border-accent focus:outline-none'
const EXPORT_BTN_CLASS = 'rounded-md border border-edge px-2.5 py-1 text-xs text-content-secondary transition-colors hover:text-content'

const MAX_SPARKLINE_RESULTS = 50


function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Mode-column detail. Custom (imported-text) runs show the snapshotted text
 *  name (falling back to the stable textId for legacy rows saved before the
 *  name was captured); every other mode shows its `mode2` value. */
function modeDetail(r: TypingTestResult): string {
  if (r.mode === 'custom') return r.customTextName ?? (r.mode2 != null ? String(r.mode2) : '')
  return r.mode2 != null ? String(r.mode2) : ''
}

/** Stable filter key for an imported-text (custom) run; its textId is `mode2`. */
function customTextId(r: TypingTestResult): string {
  return String(r.mode2 ?? '')
}

/** Filename slug describing the active export selection (tab + filter), so each
 *  filtered export lands in a distinct, self-describing file. Normal-all and
 *  Text-all stay distinct via the tab prefix. */
function exportFilterSlug(
  isText: boolean,
  modeFilter: ModeFilter,
  textFilter: string,
  customTexts: { id: string, name: string }[],
): string {
  if (isText) {
    if (textFilter === 'all') return 'text'
    // Fall back to the textId for an empty / missing name so the slug never
    // ends in a bare `text-`.
    return `text-${customTexts.find((c) => c.id === textFilter)?.name || textFilter}`
  }
  return modeFilter === 'all' ? 'normal' : `normal-${modeFilter}`
}

const MODE_FILTERS: ModeFilter[] = ['all', 'words', 'time', 'quote']

const CSV_HEADERS = ['date', 'name', 'wpm', 'kpm', 'accuracy', 'wordCount', 'correctChars', 'incorrectChars', 'durationSeconds', 'rawWpm', 'mode', 'mode2', 'customTextName', 'language', 'punctuation', 'numbers', 'consistency', 'isPb'] as const

function buildResultsCsv(results: TypingTestResult[]): string {
  return buildCsv(
    CSV_HEADERS,
    results.map((r) => CSV_HEADERS.map((key) => (key === 'kpm' ? resultKpm(r) : r[key as keyof TypingTestResult]))),
  )
}

export function TypingTestHistory({ results, onExportCsv, onRename, onDelete, deviceName }: Props) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<HistoryTab>('monkeytype')
  const [modeFilter, setModeFilter] = useState<ModeFilter>('all')
  // Text-tab filter, keyed by the stable textId (mode2). 'all' = no filter.
  const [textFilter, setTextFilter] = useState<string>('all')
  const [sortColumn, setSortColumn] = useState<SortColumn>('date')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const [confirmDeleteDate, setConfirmDeleteDate] = useState<string | null>(null)
  const isText = tab === 'text'

  const handleSort = useCallback((column: SortColumn) => {
    setSortDirection((prev) => (sortColumn === column && prev === 'desc') ? 'asc' : 'desc')
    setSortColumn(column)
  }, [sortColumn])

  // Active tab's rows: custom for Text, everything else for Monkeytype.
  const tabResults = useMemo(
    () => results.filter((r) => isText ? r.mode === 'custom' : r.mode !== 'custom'),
    [results, isText],
  )

  // Distinct imported texts (custom rows), keyed by stable textId, displayed by
  // the snapshotted name. Drives the Text-tab filter dropdown.
  const customTexts = useMemo(() => {
    const seen = new Map<string, string>()
    for (const r of results) {
      if (r.mode !== 'custom') continue
      const id = customTextId(r)
      if (!seen.has(id)) seen.set(id, r.customTextName ?? id)
    }
    return Array.from(seen, ([id, name]) => ({ id, name }))
  }, [results])

  // Fall back to 'all' when the selected text no longer exists (e.g. all its
  // rows were deleted), so the dropdown stays controlled and the stats/chart
  // never collapse to an empty selection.
  const effectiveTextFilter = textFilter === 'all' || customTexts.some((c) => c.id === textFilter)
    ? textFilter
    : 'all'

  const filtered = useMemo(() => {
    if (isText) {
      if (effectiveTextFilter === 'all') return tabResults
      return tabResults.filter((r) => customTextId(r) === effectiveTextFilter)
    }
    if (modeFilter === 'all') return tabResults
    return tabResults.filter((r) => (r.mode ?? 'words') === modeFilter)
  }, [tabResults, isText, modeFilter, effectiveTextFilter])

  // Export is per-tab: only the rows currently shown.
  const handleExport = useCallback(() => {
    onExportCsv?.(buildResultsCsv(filtered), exportFilterSlug(isText, modeFilter, effectiveTextFilter, customTexts))
  }, [filtered, onExportCsv, isText, modeFilter, effectiveTextFilter, customTexts])

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
          // Sort by what the Mode column actually shows (text name for custom),
          // so custom rows order by name rather than an opaque textId.
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
    <div data-testid="typing-test-history" className="flex h-full max-w-4xl flex-col gap-3">
      {/* Top tabs: Monkeytype (words/time/quote) vs imported Text (custom). */}
      <div className="flex items-center gap-4 border-b border-edge">
        {(['monkeytype', 'text'] as HistoryTab[]).map((tb) => (
          <button
            key={tb}
            type="button"
            data-testid={`history-tab-${tb}`}
            aria-selected={tab === tb}
            className={tab === tb
              ? 'border-b-2 border-accent px-1 pb-1.5 text-sm font-semibold text-accent'
              : 'border-b-2 border-transparent px-1 pb-1.5 text-sm text-content-secondary hover:text-content'}
            onClick={() => setTab(tb)}
          >
            {t(tb === 'text' ? 'editor.typingTest.history.tabCustom' : 'editor.typingTest.history.tabNormal')}
          </button>
        ))}
      </div>

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
            onChange={(e) => setModeFilter(e.target.value as ModeFilter)}
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
        {isText && customTexts.length > 1 && (
          <select
            data-testid="history-filter-text"
            aria-label={t('editor.typingTest.history.filterText')}
            className={FILTER_SELECT_CLASS}
            value={effectiveTextFilter}
            onChange={(e) => setTextFilter(e.target.value)}
          >
            <option value="all">{t('editor.typingTest.history.allModes')}</option>
            {customTexts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name || t('editor.typingTest.history.unnamed')}
              </option>
            ))}
          </select>
        )}
        {onExportCsv && (
          <button
            type="button"
            data-testid="history-export-csv"
            className={`ml-auto ${EXPORT_BTN_CLASS}`}
            onClick={handleExport}
          >
            {t('editor.typingTest.history.exportCsv')}
          </button>
        )}
      </div>

      {/* Stats summary */}
      <div className="flex flex-wrap items-center gap-6 text-sm">
        <StatItem label={t('editor.typingTest.history.bestWpm')} value={stats.bestWpm} highlight />
        <StatItem label={t('editor.typingTest.history.avgWpm')} value={stats.avgWpm} />
        <StatItem label={t('editor.typingTest.history.last10Avg')} value={stats.last10Avg} />
        <StatItem label={t('editor.typingTest.history.totalTests')} value={stats.totalTests} />
        <StatItem label={t('editor.typingTest.history.avgAccuracy')} value={`${stats.avgAccuracy}%`} />
      </div>

      {/* Sparkline */}
      {sparklineResults.length >= 2 && (
        <div className="flex justify-center">
          <WpmSparkline results={sparklineResults} width={400} height={50} />
        </div>
      )}

      {/* Results table — fills remaining height */}
      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-edge">
        {sorted.length > 0 ? (
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-surface-alt text-content-muted">
              <tr>
                <th className="px-3 py-1.5">{t('editor.typingTest.history.name')}</th>
                <SortableHeader column="date" label={t('editor.typingTest.history.date')} sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                <SortableHeader column="wpm" label={t('editor.typingTest.wpm')} sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                <SortableHeader column="kpm" label={t('editor.typingTest.kpm')} sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                <SortableHeader column="accuracy" label={t('editor.typingTest.accuracy')} sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                <SortableHeader column="mode" label={isText ? t('editor.typingTest.history.tabText') : t('editor.typingTest.history.mode')} sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                <SortableHeader column="duration" label={t('editor.typingTest.time')} sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                <th className="px-3 py-1.5">{t('editor.typingTest.history.pb')}</th>
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
                      : `${t(`editor.typingTest.mode.${r.mode ?? 'words'}`)}${modeDetail(r) ? ` ${modeDetail(r)}` : ''}`}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-content-muted">
                    {formatDuration(r.durationSeconds)}
                  </td>
                  <td className="px-3 py-1.5">
                    {r.isPb && <Trophy role="img" className="inline-block size-3.5 text-warning" aria-label={t('editor.typingTest.history.pb')} />}
                  </td>
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

function sortIndicator(direction: SortDirection): string {
  return direction === 'asc' ? ' \u25B2' : ' \u25BC'
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
