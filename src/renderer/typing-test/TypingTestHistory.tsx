// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useMemo, useCallback, useId, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { TypingTestResult } from '../../shared/types/pipette-settings'
import { buildCsv } from '../../shared/csv-export'
import { resultKpm, resultKspc } from './result-builder'
import { formatKspc } from '../../shared/kspc'
import { HistorySections } from './HistorySections'
import { HistoryResultsPanel } from './HistoryResultsPanel'
import type { ModeFilter, SortColumn, SortDirection } from './HistoryResultsPanel'

/** Top-level split: Monkeytype (words/time/quote) vs imported Text (fileImport).
 *  Their baselines aren't comparable, so stats / chart / export are separate. */
type HistoryTab = 'monkeytype' | 'text'

/** Secondary split, below the source tabs: Results (filter/sparkline/stats/
 *  table) vs Analysis (accuracy trend / mistake ranking / error mix). Local
 *  state, defaults to 'results', and persists across source-tab switches —
 *  it's a separate axis from `tab` above. */
type HistoryView = 'results' | 'analysis'

/** Tab order for the secondary view tablist — drives both the rendered
 *  button order and the APG roving-tabindex arrow-key navigation below. */
const VIEW_TABS: HistoryView[] = ['results', 'analysis']

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
  /** Keyboard uid + which runIds have a saved keystroke log (owned by
   *  `HistoryToggle`) — the timeline column is omitted when `uid` is unset. */
  uid?: string
  availableRunIds?: ReadonlySet<string>
}

/** Stable filter key for an imported-text (fileImport) run; its textId is `mode2`. */
function fileImportTextId(r: TypingTestResult): string {
  return String(r.mode2 ?? '')
}

/** Filename slug describing the active export selection (tab + filter), so each
 *  filtered export lands in a distinct, self-describing file. Monkeytype-all and
 *  Text-all stay distinct via the tab prefix. */
function exportFilterSlug(
  isText: boolean,
  modeFilter: ModeFilter,
  textFilter: string,
  fileImportTexts: { id: string, name: string }[],
): string {
  if (isText) {
    if (textFilter === 'all') return 'text'
    // Fall back to the textId for an empty / missing name so the slug never
    // ends in a bare `text-`.
    return `text-${fileImportTexts.find((c) => c.id === textFilter)?.name || textFilter}`
  }
  return modeFilter === 'all' ? 'monkeytype' : `monkeytype-${modeFilter}`
}

// errorSubstitutions/errorOmissions/errorInsertions/errorTargetChars are
// exported as their RAW counts (not a derived per-row rate like `kspc`
// above) — unlike a single ratio, a per-row percentage would use each
// row's own errorTargetChars as its denominator, which can't be
// correctly re-aggregated across multiple exported rows (a naive average
// of percentages misweights short and long runs); raw counts + the
// shared denominator let a spreadsheet compute the same char-weighted
// Σ/Σ rate this app itself uses. Empty (not 0) for a result missing the
// group, same treatment as `kspc`.
const CSV_HEADERS = ['date', 'name', 'wpm', 'kpm', 'accuracy', 'kspc', 'wordCount', 'correctChars', 'incorrectChars', 'durationSeconds', 'rawWpm', 'mode', 'mode2', 'fileImportTextName', 'language', 'punctuation', 'numbers', 'consistency', 'isPb', 'errorSubstitutions', 'errorOmissions', 'errorInsertions', 'errorTargetChars'] as const

function buildResultsCsv(results: TypingTestResult[]): string {
  return buildCsv(
    CSV_HEADERS,
    results.map((r) => CSV_HEADERS.map((key) => {
      if (key === 'kpm') return resultKpm(r)
      // Derived, same as kpm — empty (not 0) for a legacy result that never
      // recorded the raw kspcKeystrokes/kspcChars pair.
      if (key === 'kspc') {
        const kspc = resultKspc(r)
        return kspc === null ? '' : formatKspc(kspc)
      }
      return r[key as keyof TypingTestResult]
    })),
  )
}

const VIEW_TAB_ACTIVE = 'border-b-2 border-accent px-1 pb-1 text-xs font-medium text-accent'
const VIEW_TAB_INACTIVE = 'border-b-2 border-transparent px-1 pb-1 text-xs text-content-muted hover:text-content'

export function TypingTestHistory({ results, onExportCsv, onRename, onDelete, deviceName, uid, availableRunIds }: Props) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<HistoryTab>('monkeytype')
  const [view, setView] = useState<HistoryView>('results')
  const [modeFilter, setModeFilter] = useState<ModeFilter>('all')
  // Text-tab filter, keyed by the stable textId (mode2). 'all' = no filter.
  const [textFilter, setTextFilter] = useState<string>('all')
  const isText = tab === 'text'

  // Sort state lives here (not in HistoryResultsPanel) because that panel
  // unmounts while the Analysis view is active (conditional render below) —
  // panel-local state would silently reset the sort on every
  // Results→Analysis→Results round trip. Delete-confirm and the rename
  // modal stay panel-local; both are transient interactions where a reset
  // on tab switch is expected/safe, unlike a deliberate sort choice.
  const [sortColumn, setSortColumn] = useState<SortColumn>('date')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const handleSort = useCallback((column: SortColumn) => {
    setSortDirection((prev) => (sortColumn === column && prev === 'desc') ? 'asc' : 'desc')
    setSortColumn(column)
  }, [sortColumn])

  // Unique per-instance ids for the view tabs/panels (React 19 useId), so
  // aria-controls/aria-labelledby never collide if two History modals ever
  // mount at once — unlike the pre-existing source tabs above, which use
  // static ids/no `role` and are left untouched (out of scope here).
  const viewTabsIdBase = useId()
  const viewTabId = useCallback((v: HistoryView) => `${viewTabsIdBase}-tab-${v}`, [viewTabsIdBase])
  const viewPanelId = useCallback((v: HistoryView) => `${viewTabsIdBase}-panel-${v}`, [viewTabsIdBase])

  // APG tabs pattern (automatic activation): arrow keys move focus AND
  // selection between the two view tabs; Home/End jump to the first/last.
  // Roving tabIndex (0 on the active tab, -1 otherwise) keeps the tablist a
  // single Tab stop, per https://www.w3.org/WAI/ARIA/apg/patterns/tabs/.
  const viewTabRefs = useRef<Partial<Record<HistoryView, HTMLButtonElement>>>({})
  const focusAndSelectView = useCallback((v: HistoryView) => {
    setView(v)
    viewTabRefs.current[v]?.focus()
  }, [])
  const handleViewTabKeyDown = useCallback((e: KeyboardEvent<HTMLButtonElement>, current: HistoryView) => {
    const idx = VIEW_TABS.indexOf(current)
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault()
        focusAndSelectView(VIEW_TABS[(idx + 1) % VIEW_TABS.length])
        break
      case 'ArrowLeft':
        e.preventDefault()
        focusAndSelectView(VIEW_TABS[(idx - 1 + VIEW_TABS.length) % VIEW_TABS.length])
        break
      case 'Home':
        e.preventDefault()
        focusAndSelectView(VIEW_TABS[0])
        break
      case 'End':
        e.preventDefault()
        focusAndSelectView(VIEW_TABS[VIEW_TABS.length - 1])
        break
    }
  }, [focusAndSelectView])

  // Active tab's rows: fileImport for Text, everything else for Monkeytype.
  const tabResults = useMemo(
    () => results.filter((r) => isText ? r.mode === 'fileImport' : r.mode !== 'fileImport'),
    [results, isText],
  )

  // Distinct imported texts (fileImport rows), keyed by stable textId, displayed by
  // the snapshotted name. Drives the Text-tab filter dropdown.
  const fileImportTexts = useMemo(() => {
    const seen = new Map<string, string>()
    for (const r of results) {
      if (r.mode !== 'fileImport') continue
      const id = fileImportTextId(r)
      if (!seen.has(id)) seen.set(id, r.fileImportTextName ?? id)
    }
    return Array.from(seen, ([id, name]) => ({ id, name }))
  }, [results])

  // Fall back to 'all' when the selected text no longer exists (e.g. all its
  // rows were deleted), so the dropdown stays controlled and the stats/chart
  // never collapse to an empty selection.
  const effectiveTextFilter = textFilter === 'all' || fileImportTexts.some((c) => c.id === textFilter)
    ? textFilter
    : 'all'

  const filtered = useMemo(() => {
    if (isText) {
      if (effectiveTextFilter === 'all') return tabResults
      return tabResults.filter((r) => fileImportTextId(r) === effectiveTextFilter)
    }
    if (modeFilter === 'all') return tabResults
    return tabResults.filter((r) => (r.mode ?? 'words') === modeFilter)
  }, [tabResults, isText, modeFilter, effectiveTextFilter])

  // Export is per-tab: only the rows currently shown.
  const handleExport = useCallback(() => {
    onExportCsv?.(buildResultsCsv(filtered), exportFilterSlug(isText, modeFilter, effectiveTextFilter, fileImportTexts))
  }, [filtered, onExportCsv, isText, modeFilter, effectiveTextFilter, fileImportTexts])

  // min-h-0 flex-1 (not h-full) on the root below: this is a flex child of
  // HistoryToggle's `flex h-modal-80vh flex-col` modal box, sitting below
  // the title row. h-full resolves to 100% of the modal's own content-box
  // height, ignoring the title row's share of that flex column, which
  // pushed this div (and everything below it) a constant ~20px past the
  // modal's bottom edge regardless of content or window size. flex-1
  // (flex-basis:0 + grow) makes it consume exactly the space left over
  // after the title row instead.
  return (
    <div data-testid="typing-test-history" className="flex min-h-0 flex-1 max-w-4xl flex-col gap-3">
      {/* Top tabs: Monkeytype (words/time/quote) vs imported Text (fileImport). */}
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
            {t(tb === 'text' ? 'editor.typingTest.history.tabFileImport' : 'editor.typingTest.history.tabMonkeytype')}
          </button>
        ))}
      </div>

      {/* Secondary tabs: Results (filter/sparkline/stats/table) vs Analysis
          (accuracy trend / mistake ranking / error mix). Visually subordinate
          to the source tabs above (smaller text, lighter weight) while
          keeping the same border-b-2 accent indicator pattern
          (.claude/DESIGN.md "Tabs"). Local state, persists across source-tab
          switches. */}
      <div
        role="tablist"
        aria-label={t('editor.typingTest.history.viewTabsAriaLabel')}
        className="flex items-center gap-3 border-b border-edge/60"
      >
        {VIEW_TABS.map((v) => (
          <button
            key={v}
            ref={(el) => { viewTabRefs.current[v] = el ?? undefined }}
            type="button"
            role="tab"
            id={viewTabId(v)}
            aria-selected={view === v}
            aria-controls={viewPanelId(v)}
            tabIndex={view === v ? 0 : -1}
            data-testid={`history-view-tab-${v}`}
            className={view === v ? VIEW_TAB_ACTIVE : VIEW_TAB_INACTIVE}
            onClick={() => setView(v)}
            onKeyDown={(e) => handleViewTabKeyDown(e, v)}
          >
            {t(v === 'results' ? 'editor.typingTest.history.tabResults' : 'editor.typingTest.history.tabAnalysis')}
          </button>
        ))}
      </div>

      {/* No extra wrapper div here: each panel component applies its own
          role="tabpanel"/id/aria-labelledby directly to its existing root
          div (which is already `flex ... min-h-0 ...`, part of this root's
          flex-col chain). An intermediate plain block div would break that
          chain — its default `display: block` can't propagate the
          min-h-0/shrink sizing needed for HistorySections' overflow-y-auto
          to actually engage, which silently reintroduces the #377 modal
          overflow bug (confirmed via screenshot regression on this branch). */}
      {view === 'results' ? (
        <HistoryResultsPanel
          id={viewPanelId('results')}
          ariaLabelledBy={viewTabId('results')}
          isText={isText}
          modeFilter={modeFilter}
          onModeFilterChange={setModeFilter}
          effectiveTextFilter={effectiveTextFilter}
          onTextFilterChange={setTextFilter}
          fileImportTexts={fileImportTexts}
          filtered={filtered}
          sortColumn={sortColumn}
          sortDirection={sortDirection}
          onSort={handleSort}
          onExport={onExportCsv ? handleExport : undefined}
          onRename={onRename}
          onDelete={onDelete}
          deviceName={deviceName}
          uid={uid}
          availableRunIds={availableRunIds}
        />
      ) : (
        <HistorySections
          id={viewPanelId('analysis')}
          ariaLabelledBy={viewTabId('analysis')}
          tabResults={tabResults}
        />
      )}
    </div>
  )
}
