// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useMemo, useCallback, useId, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { TypingTestResult } from '../../shared/types/pipette-settings'
import type { TypingTestTextMeta } from '../../shared/types/typing-test-text-store'
import { buildCsv } from '../../shared/csv-export'
import { resultKpm, resultKspc, resultAvgHoldMs } from './result-builder'
import { formatKspc } from '../../shared/kspc'
import { useTypingTestTexts } from '../hooks/useTypingTestTexts'
import { HistorySections } from './HistorySections'
import { HistoryResultsPanel } from './HistoryResultsPanel'
import type { ModeFilter, SortColumn, SortDirection, HistoryTab } from './HistoryResultsPanel'
import { deriveDistinctConditions } from './AccuracyTrendSection'
import { PERIOD_FILTERS, DEFAULT_PERIOD_FILTER, filterResultsByPeriod } from './history-period-filter'
import type { PeriodFilter } from './history-period-filter'

// Tab order for the source tablist — MonkeyType (words/time/quote), Tatoeba
// (mode 'tatoeba'), Aozora (fileImport rows whose text meta was imported via
// the Aozora Bunko catalog), File Import (every other fileImport row, plus
// pre-rename legacy 'custom' rows). Each tab's baseline isn't comparable to
// the others', so stats / chart / export stay scoped per tab.
const HISTORY_TABS: HistoryTab[] = ['monkeytype', 'tatoeba', 'aozora', 'text']

const HISTORY_TAB_LABEL_KEYS: Record<HistoryTab, string> = {
  monkeytype: 'editor.typingTest.history.tabMonkeytype',
  tatoeba: 'editor.typingTest.history.tabTatoeba',
  aozora: 'editor.typingTest.history.tabAozora',
  text: 'editor.typingTest.history.tabFileImport',
}

const PERIOD_FILTER_LABEL_KEYS: Record<PeriodFilter, string> = {
  '1w': 'editor.typingTest.history.period1Week',
  '1m': 'editor.typingTest.history.period1Month',
  '3m': 'editor.typingTest.history.period3Months',
  '1y': 'editor.typingTest.history.period1Year',
  all: 'editor.typingTest.history.periodAll',
}

/** Set on a `TypingTestTextMeta.source.provider` when the text was imported
 *  from the Aozora Bunko catalog (see AozoraCatalogTab/aozora-import.ts) —
 *  duplicated here as a local literal rather than a shared export, matching
 *  the existing per-file convention (AozoraCatalogTab.tsx also inlines it). */
const AOZORA_PROVIDER = 'aozora'

/** Classify a result into its source tab. `mode2` carries the imported
 *  text's stable textId for fileImport rows — the same link the text
 *  dropdown already uses (`fileImportTextId` below) — so looking it up in
 *  `textMetaById` tells Aozora and File Import rows apart. A fileImport row
 *  whose text no longer exists in the store (deleted) falls back to File
 *  Import. Legacy rows saved before the fileImport rename used mode
 *  'custom' — cast through `string` since that value predates (and isn't
 *  part of) the current `TypingTestResult['mode']` union — and must land in
 *  File Import too, not MonkeyType. */
function classifyResultTab(r: TypingTestResult, textMetaById: Map<string, TypingTestTextMeta>): HistoryTab {
  if (r.mode === 'tatoeba') return 'tatoeba'
  if (r.mode === 'fileImport') {
    const meta = textMetaById.get(fileImportTextId(r))
    return meta?.source?.provider === AOZORA_PROVIDER ? 'aozora' : 'text'
  }
  if ((r.mode as string | undefined) === 'custom') return 'text'
  return 'monkeytype'
}

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
 *  filtered export lands in a distinct, self-describing file. Every tab's
 *  "all" slug stays distinct via its own prefix. */
function exportFilterSlug(
  tab: HistoryTab,
  modeFilter: ModeFilter,
  textFilter: string,
  fileImportTexts: { id: string, name: string }[],
): string {
  if (tab === 'aozora' || tab === 'text') {
    if (textFilter === 'all') return tab
    // Fall back to the textId for an empty / missing name so the slug never
    // ends in a bare `aozora-`/`text-`.
    return `${tab}-${fileImportTexts.find((c) => c.id === textFilter)?.name || textFilter}`
  }
  if (tab === 'tatoeba') return 'tatoeba'
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
const CSV_HEADERS = ['date', 'name', 'wpm', 'kpm', 'accuracy', 'kspc', 'avgHoldMs', 'wordCount', 'correctChars', 'incorrectChars', 'durationSeconds', 'rawWpm', 'mode', 'mode2', 'fileImportTextName', 'language', 'punctuation', 'numbers', 'consistency', 'isPb', 'errorSubstitutions', 'errorOmissions', 'errorInsertions', 'errorTargetChars'] as const

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
      // Derived mean, rounded to the nearest ms — empty (not 0) for a
      // legacy result with no raw holdSumMs/holdSamples pair, same
      // both-or-neither treatment as kspc above.
      if (key === 'avgHoldMs') {
        const avgHold = resultAvgHoldMs(r)
        return avgHold === null ? '' : Math.round(avgHold)
      }
      return r[key as keyof TypingTestResult]
    })),
  )
}

const VIEW_TAB_ACTIVE = 'border-b-2 border-accent px-1 pb-1 text-xs font-medium text-accent'
const VIEW_TAB_INACTIVE = 'border-b-2 border-transparent px-1 pb-1 text-xs text-content-muted hover:text-content'

// Compact variant of FILTER_SELECT_CLASS for the two selects living directly
// in the header row's border-b — shorter (h-7 vs h-8) and text-xs (vs
// text-sm) so they read as a lighter-weight header control than the
// Results-panel sub-filters, which keep FILTER_SELECT_CLASS/h-8 as-is.
const HEADER_SELECT_CLASS =
  'h-7 rounded-md border border-edge bg-surface-alt px-2 text-xs text-content-secondary ' +
  'focus:border-accent focus:outline-none'

export function TypingTestHistory({ results, onExportCsv, onRename, onDelete, deviceName, uid, availableRunIds }: Props) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<HistoryTab>('monkeytype')
  const [view, setView] = useState<HistoryView>('results')
  const [modeFilter, setModeFilter] = useState<ModeFilter>('all')
  // Aozora/File Import tab filter, keyed by the stable textId (mode2).
  // 'all' = no filter. Shared by both tabs (each falls back to 'all' below
  // when the picked id isn't in that tab's own text list), matching the
  // existing single-state pattern rather than adding a second filter state.
  const [textFilter, setTextFilter] = useState<string>('all')

  // Accuracy Trend condition selector — lifted up from AccuracyTrendSection
  // (header redesign: the `<select>` itself now renders in this header's
  // right-end group, next to the source select, rather than inline above
  // the chart). Raw pick, resolved below (effectiveConditionKey) against
  // whatever conditions the active tab currently has — same
  // pick-with-fallback shape as `textFilter`/`effectiveTextFilter` above.
  const [conditionFilter, setConditionFilter] = useState<string>('')

  // Period filter — rightmost select in the header's right-end group.
  // Scopes EVERYTHING below the header row (WPM Trend chart, stats summary,
  // Results table, CSV export, and the entire Analysis tab) to a rolling
  // window, not just the Results table — see periodResults below, which
  // every other derived value in this file is built from instead of the raw
  // `results` prop. Defaults to '1m' (1 month) on every mount; since
  // HistoryToggle only mounts this component while the modal is open (see
  // its `{showHistory && (...)}` guard), that also means "1 month" is the
  // starting point on every fresh History open, not a one-time default —
  // matching the source select above, which is likewise local, non-
  // persisted state.
  const [periodFilter, setPeriodFilter] = useState<PeriodFilter>(DEFAULT_PERIOD_FILTER)

  // Anchor timestamp for the period filter, computed once when this
  // component mounts (i.e. once per History open, per the mount note
  // above) rather than re-read on every render or ticked via an interval —
  // the window's far edge doesn't need to advance while the modal stays
  // open, and a stable anchor keeps the visible set from shifting under the
  // user mid-session as they switch between periods.
  const [now] = useState(() => Date.now())

  const periodResults = useMemo(
    () => filterResultsByPeriod(results, periodFilter, now),
    [results, periodFilter, now],
  )

  // Imported-text metas, used to tell an Aozora-catalog fileImport row apart
  // from a plain File Import one (see classifyResultTab above).
  const { metas: textMetas } = useTypingTestTexts()
  const textMetaById = useMemo(() => new Map(textMetas.map((m) => [m.id, m])), [textMetas])

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

  // Active tab's rows, per classifyResultTab above. Built from
  // periodResults (not the raw `results` prop) so the period filter applies
  // before source-tab classification.
  const tabResults = useMemo(
    () => periodResults.filter((r) => classifyResultTab(r, textMetaById) === tab),
    [periodResults, tab, textMetaById],
  )

  // Distinct imported texts (fileImport rows), keyed by stable textId,
  // displayed by the snapshotted name — scoped to the active tab (Aozora
  // gets only source.provider 'aozora' texts, File Import gets the rest).
  // Drives that tab's filter dropdown; empty (and thus hidden) for
  // MonkeyType/Tatoeba. Scoped to periodResults so a text with no results
  // inside the current period drops out of the dropdown too.
  const fileImportTexts = useMemo(() => {
    if (tab !== 'aozora' && tab !== 'text') return []
    const seen = new Map<string, string>()
    for (const r of periodResults) {
      if (r.mode !== 'fileImport') continue
      const id = fileImportTextId(r)
      const isAozoraText = textMetaById.get(id)?.source?.provider === AOZORA_PROVIDER
      if (isAozoraText !== (tab === 'aozora')) continue
      if (!seen.has(id)) seen.set(id, r.fileImportTextName ?? id)
    }
    return Array.from(seen, ([id, name]) => ({ id, name }))
  }, [periodResults, tab, textMetaById])

  // Fall back to 'all' when the selected text no longer exists in this tab
  // (e.g. all its rows were deleted, or the tab was just switched to one
  // where that id doesn't belong), so the dropdown stays controlled and the
  // stats/chart never collapse to an empty selection.
  const effectiveTextFilter = textFilter === 'all' || fileImportTexts.some((c) => c.id === textFilter)
    ? textFilter
    : 'all'

  const filtered = useMemo(() => {
    if (tab === 'aozora' || tab === 'text') {
      if (effectiveTextFilter === 'all') return tabResults
      return tabResults.filter((r) => fileImportTextId(r) === effectiveTextFilter)
    }
    if (tab === 'monkeytype') {
      if (modeFilter === 'all') return tabResults
      return tabResults.filter((r) => (r.mode ?? 'words') === modeFilter)
    }
    // Tatoeba has no sub-filter — the Analysis condition selector already
    // covers per-condition grouping.
    return tabResults
  }, [tabResults, tab, modeFilter, effectiveTextFilter])

  // Export is per-tab: only the rows currently shown.
  const handleExport = useCallback(() => {
    onExportCsv?.(buildResultsCsv(filtered), exportFilterSlug(tab, modeFilter, effectiveTextFilter, fileImportTexts))
  }, [filtered, onExportCsv, tab, modeFilter, effectiveTextFilter, fileImportTexts])

  // Accuracy Trend condition grouping, scoped to the active source tab's
  // full result set (tabResults, not the mode/text-filtered `filtered`) —
  // same shared helper AccuracyTrendSection itself calls to resolve the
  // picked key into its chart's series, so the two never drift out of
  // sync. Only computed/rendered when Analysis is showing (below), but the
  // derivation itself is cheap enough to leave unconditional here.
  const distinctConditions = useMemo(() => deriveDistinctConditions(tabResults, t), [tabResults, t])

  // Fall back to the latest run's condition (distinctConditions[0], ordered
  // most-recent-first) when nothing's been picked yet, or the picked
  // condition no longer has any results — e.g. its rows were deleted, or
  // the source tab was just switched to one where that key doesn't belong.
  // Mirrors the effectiveTextFilter pattern above: recomputed on every
  // render from current state, so a source-tab switch alone (no dedicated
  // reset effect needed) re-resolves the fallback the next time this is read.
  const effectiveConditionKey = (conditionFilter && distinctConditions.some((c) => c.key === conditionFilter))
    ? conditionFilter
    : (distinctConditions[0]?.key ?? '')

  // min-h-0 flex-1 (not h-full) on the root below: this is a flex child of
  // HistoryToggle's `flex h-modal-80vh flex-col` modal box, sitting below
  // the title row. h-full resolves to 100% of the modal's own content-box
  // height, ignoring the title row's share of that flex column, which
  // pushed this div (and everything below it) a constant ~20px past the
  // modal's bottom edge regardless of content or window size. flex-1
  // (flex-basis:0 + grow) makes it consume exactly the space left over
  // after the title row instead.
  return (
    <div data-testid="typing-test-history" className="flex min-h-0 flex-1 max-w-5xl flex-col gap-3">
      {/* Single header row: Results/Analysis tabs on the left, selects at
          the right end (ml-auto group). The source tabs (MonkeyType /
          Tatoeba / Aozora / File Import) that used to be their own row
          above this one are gone — source selection is now the first
          select in the right-end group, reusing the same tab i18n labels
          as its option labels. When Analysis is active, the Accuracy Trend
          condition select (lifted out of AccuracyTrendSection, see
          deriveDistinctConditions above) joins it as the second select —
          order matters here (source first, condition second) per the
          approved redesign sketch. The condition select carries no visible
          label (aria-label only); the "ACCURACY TREND" heading stays above
          the chart in AccuracyTrendSection itself. The period select is
          always last, in both Results and Analysis (see its own comment
          below) — it's the one selector in this group that scopes every
          view, not just Analysis. */}
      <div className="flex items-center gap-3 border-b border-edge/60">
        <div
          role="tablist"
          aria-label={t('editor.typingTest.history.viewTabsAriaLabel')}
          className="flex items-center gap-3"
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
        {/* mb-1 lifts this group's frame off the row's border-b: with
            items-center on the row, this group (now taller than the tab
            buttons once its own margin is counted) drives the row's cross
            size, so the margin lands as visible space between the selects'
            bottom edge and the border-b line instead of the selects
            touching it flush. */}
        <div className="ml-auto mb-1 flex items-center gap-2">
          <select
            data-testid="history-filter-source"
            aria-label={t('editor.typingTest.history.sourceFilterLabel')}
            className={HEADER_SELECT_CLASS}
            value={tab}
            onChange={(e) => setTab(e.target.value as HistoryTab)}
          >
            {HISTORY_TABS.map((tb) => (
              <option key={tb} value={tb}>{t(HISTORY_TAB_LABEL_KEYS[tb])}</option>
            ))}
          </select>
          {view === 'analysis' && distinctConditions.length > 0 && (
            <select
              data-testid="history-condition-filter"
              aria-label={t('editor.typingTest.history.conditionFilterLabel')}
              className={HEADER_SELECT_CLASS}
              value={effectiveConditionKey}
              onChange={(e) => setConditionFilter(e.target.value)}
            >
              {distinctConditions.map((c) => (
                <option key={c.key} value={c.key}>{c.label}</option>
              ))}
            </select>
          )}
          {/* Period filter — always the rightmost select, in both Results
              and Analysis (unlike the condition select above, which only
              applies to Analysis). Scopes periodResults, which every value
              below this row is ultimately derived from — see the
              periodResults doc comment above. */}
          <select
            data-testid="history-filter-period"
            aria-label={t('editor.typingTest.history.periodFilterLabel')}
            className={HEADER_SELECT_CLASS}
            value={periodFilter}
            onChange={(e) => setPeriodFilter(e.target.value as PeriodFilter)}
          >
            {PERIOD_FILTERS.map((p) => (
              <option key={p} value={p}>{t(PERIOD_FILTER_LABEL_KEYS[p])}</option>
            ))}
          </select>
        </div>
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
          tab={tab}
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
          selectedCondition={effectiveConditionKey}
          uid={uid}
          availableRunIds={availableRunIds}
        />
      )}
    </div>
  )
}
