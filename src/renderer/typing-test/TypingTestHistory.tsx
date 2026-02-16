// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Trophy } from 'lucide-react'
import type { TypingTestResult } from '../../shared/types/pipette-settings'
import { computeStats } from './history-stats'
import { WpmSparkline } from './WpmSparkline'

type ModeFilter = 'all' | 'words' | 'time' | 'quote'
type SortColumn = 'date' | 'wpm' | 'accuracy' | 'mode' | 'duration'
type SortDirection = 'asc' | 'desc'

interface Props {
  results: TypingTestResult[]
  onExportCsv?: (csv: string) => void
}

const MAX_TABLE_ROWS = 20

function modeFilterButtonClass(active: boolean): string {
  const base = 'rounded-md border px-2.5 py-1 text-xs transition-colors'
  if (active) return `${base} border-accent bg-accent/10 text-accent`
  return `${base} border-edge text-content-secondary hover:text-content`
}

const MAX_SPARKLINE_RESULTS = 50

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

const MODE_FILTERS: ModeFilter[] = ['all', 'words', 'time', 'quote']

const CSV_HEADERS = ['date', 'wpm', 'accuracy', 'wordCount', 'correctChars', 'incorrectChars', 'durationSeconds', 'rawWpm', 'mode', 'mode2', 'language', 'punctuation', 'numbers', 'consistency', 'isPb'] as const

function escapeCsvField(value: unknown): string {
  let str = value == null ? '' : String(value)
  // Neutralize spreadsheet formula injection (strip leading whitespace first)
  str = str.replace(/^[\t\r\n ]+/, '')
  if (str.length > 0 && '=+-@'.includes(str[0])) {
    str = `'${str}`
  }
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

function buildCsv(results: TypingTestResult[]): string {
  const header = CSV_HEADERS.join(',')
  const rows = results.map((r) =>
    CSV_HEADERS.map((key) => escapeCsvField(r[key])).join(','),
  )
  return [header, ...rows].join('\n')
}

export function TypingTestHistory({ results, onExportCsv }: Props) {
  const { t } = useTranslation()
  const [modeFilter, setModeFilter] = useState<ModeFilter>('all')
  const [sortColumn, setSortColumn] = useState<SortColumn>('date')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')

  const handleSort = useCallback((column: SortColumn) => {
    setSortDirection((prev) => (sortColumn === column && prev === 'desc') ? 'asc' : 'desc')
    setSortColumn(column)
  }, [sortColumn])

  const handleExport = useCallback(() => {
    onExportCsv?.(buildCsv(results))
  }, [results, onExportCsv])

  const filtered = useMemo(() => {
    if (modeFilter === 'all') return results
    return results.filter((r) => (r.mode ?? 'words') === modeFilter)
  }, [results, modeFilter])

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
        case 'accuracy':
          cmp = a.accuracy - b.accuracy
          break
        case 'mode': {
          const modeA = `${a.mode ?? ''}${a.mode2 ?? ''}`
          const modeB = `${b.mode ?? ''}${b.mode2 ?? ''}`
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
      {/* Header: mode filter + export */}
      <div className="flex items-center gap-2">
        <div className="flex gap-1.5">
          {MODE_FILTERS.map((mode) => (
            <button
              key={mode}
              type="button"
              data-testid={`history-filter-${mode}`}
              className={modeFilterButtonClass(modeFilter === mode)}
              aria-pressed={modeFilter === mode}
              onClick={() => setModeFilter(mode)}
            >
              {mode === 'all'
                ? t('editor.typingTest.history.allModes')
                : t(`editor.typingTest.mode.${mode}`)}
            </button>
          ))}
        </div>
        {onExportCsv && (
          <button
            type="button"
            data-testid="history-export-csv"
            className={`ml-auto ${modeFilterButtonClass(false)}`}
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
                <SortableHeader column="date" label={t('editor.typingTest.history.date')} sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                <SortableHeader column="wpm" label={t('editor.typingTest.wpm')} sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                <SortableHeader column="accuracy" label={t('editor.typingTest.accuracy')} sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                <SortableHeader column="mode" label={t('editor.typingTest.history.mode')} sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                <SortableHeader column="duration" label={t('editor.typingTest.time')} sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                <th className="px-3 py-1.5">{t('editor.typingTest.history.pb')}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => (
                <tr
                  key={i}
                  className="border-t border-edge/50 transition-colors hover:bg-surface-alt/50"
                >
                  <td className="px-3 py-1.5 text-content-muted">{formatDate(r.date)}</td>
                  <td className="px-3 py-1.5 font-mono font-semibold text-accent">{r.wpm}</td>
                  <td className="px-3 py-1.5 font-mono">{r.accuracy}%</td>
                  <td className="px-3 py-1.5 text-content-muted">
                    {t(`editor.typingTest.mode.${r.mode ?? 'words'}`)}{r.mode2 != null ? ` ${r.mode2}` : ''}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-content-muted">
                    {formatDuration(r.durationSeconds)}
                  </td>
                  <td className="px-3 py-1.5">
                    {r.isPb && <Trophy role="img" className="inline-block size-3.5 text-warning" aria-label={t('editor.typingTest.history.pb')} />}
                  </td>
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
    <div className="flex items-center gap-1.5">
      <span className="text-content-muted">{label}:</span>
      <span className={`font-mono font-semibold ${highlight ? 'text-accent' : ''}`}>{value}</span>
    </div>
  )
}
