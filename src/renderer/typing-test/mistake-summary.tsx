// SPDX-License-Identifier: GPL-2.0-or-later
// Shared "missed characters" presentations + error-class (Substitution/
// Omission/Insertion) line — extracted out of `TypingTestStatsRow` (the
// completion screen's finished-state summary) so `KeystrokeTimelinePanel`
// can show a consistent presentation for a `TypingTestResult` without a
// second, drifting implementation of the same sort/slice/testid logic.
// See .claude/plans/Plan-completion-timeline-view.md PR-A spec point 2.
//
// Two presentations of the same sorted mistake list:
//  - `MissedCharsList` — the original inline chip line, still used by
//    TypingTestStatsRow's no-log fallback row (never has per-key detail
//    to show, so a bare chip line is all that context needs). Still
//    CAPPED (`MAX_MISTAKE_ENTRIES`) — a flex-wrap chip line has no scroll
//    mechanism of its own, unlike the rows below, so truncation is still
//    the right visibility strategy here.
//  - `MissedTable` — a per-key BAR-GRAPH row list (Word / "→ typed chars"
//    / stacked red-gray bar / Cnt), used by KeystrokeTimelinePanel
//    (single run) AND MistakeRankingSection (History's Analysis tab,
//    aggregated across every run in the active tab — see
//    use-mistake-ranking-details.ts). Parameterized (`titleKey`/`testId`)
//    rather than duplicated between the two callers, which differ only in
//    heading text and (History's own pre-existing contract) root testid.
//    UNCAPPED: every entry is reachable via the list's own internal
//    vertical scroll (bounded max-height) instead of being truncated —
//    see `allSortedMistakeEntries` and `MISSED_TABLE_MAX_HEIGHT`.
//    Replaces an earlier column-table presentation (headers + a separate
//    Moved-on column; see git history) with the approved bar-graph
//    mockup: the bar's own red/gray split communicates the
//    corrected-vs-moved-on-uncorrected breakdown at a glance, with exact
//    figures in a hover tooltip instead of their own column.

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Tooltip } from '../components/ui/Tooltip'
import { EMPTY_STAT_VALUE } from '../components/analyze/analyze-constants'
import type { MissedCharDetail } from './missed-details'

// Caps how many distinct mistake keys `MissedCharsList` shows, so a run
// with many small errors doesn't turn its chip line into an unbounded
// wall of text — `MissedTable` does NOT use this cap (see
// `allSortedMistakeEntries`): it scrolls instead of truncating.
export const MAX_MISTAKE_ENTRIES = 12

function compareMistakeEntries([keyA, countA]: [string, number], [keyB, countB]: [string, number]): number {
  return countB - countA || keyA.localeCompare(keyB)
}

/** Sorted by count DESC then key ASC (ties break deterministically
 *  instead of on object insertion order), capped to `max` entries. Used
 *  by `MissedCharsList` only — see `allSortedMistakeEntries` for the
 *  uncapped table equivalent. */
export function sortedMistakeEntries(mistakes: Record<string, number>, max: number = MAX_MISTAKE_ENTRIES): [string, number][] {
  return Object.entries(mistakes).sort(compareMistakeEntries).slice(0, max)
}

/** Same sort as `sortedMistakeEntries`, without the cap — every entry is
 *  reachable via `MissedTable`'s own internal scroll instead of being
 *  truncated. */
function allSortedMistakeEntries(mistakes: Record<string, number>): [string, number][] {
  return Object.entries(mistakes).sort(compareMistakeEntries)
}

interface MissedCharsListProps {
  mistakes: Record<string, number>
}

/** Renders nothing when `mistakes` has no entries — omitted entirely
 *  rather than a '-' placeholder, matching this run's "the metric
 *  doesn't apply" convention (a run with zero mistakes is common, not an
 *  in-progress state). */
export function MissedCharsList({ mistakes }: MissedCharsListProps) {
  const { t } = useTranslation()
  const entries = useMemo(() => sortedMistakeEntries(mistakes), [mistakes])
  if (entries.length === 0) return null
  return (
    <div data-testid="typing-test-mistakes" className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-content-muted">
      <span>{t('editor.typingTest.results.mistakesLabel')}:</span>
      {entries.map(([key, count]) => (
        <span key={key} data-testid={`typing-test-mistake-${key}`} className="font-mono">
          {key}:{count}
        </span>
      ))}
    </div>
  )
}

/** Fixed column widths (not `max-content`) so every row — each its own
 *  independent grid instance — lands on identical column boundaries
 *  without needing a single shared grid parent, same pattern as
 *  `ERROR_MIX_GRID` in ErrorMixSection.tsx. No header row anymore (the
 *  approved bar-graph mockup has none — see `MissedTable`'s own doc
 *  comment), so these widths only ever have to agree with each other, not
 *  with a caption row above them. Word/Cnt are fixed-width (short,
 *  bounded content); the typed-chars cell gets a bounded-but-flexible
 *  width (long enough for a handful of comma-joined chars before
 *  truncating); the bar takes the remaining space (`1fr`) since it's the
 *  row's main visual element. */
const MISSED_ROW_GRID = { gridTemplateColumns: '4.5rem 5rem 1fr 3rem' }

/** "m: 1, n: 2" — sorted DESC by count, ties on `Object.entries`'
 *  stable insertion order (this is a per-row detail breakdown, not the
 *  much larger user-facing key list `sortedMistakeEntries` orders, so an
 *  explicit tie-break isn't worth the extra complexity here). Used for
 *  the hover tooltip's own "Typed instead" line (WITH counts) — see
 *  `formatTypedCharsOnly` for the row's own inline cell (chars only, no
 *  counts — the mockup keeps counts out of the row and moves them into
 *  the tooltip). Returns `EMPTY_STAT_VALUE` when there's no detail at all
 *  for this key (legacy log, correlation-unavailable bailout) or the
 *  detail carries no typedCounts. */
function formatTypedInstead(detail: MissedCharDetail | undefined): string {
  if (!detail) return EMPTY_STAT_VALUE
  const entries = Object.entries(detail.typedCounts).sort(([, a], [, b]) => b - a)
  if (entries.length === 0) return EMPTY_STAT_VALUE
  return entries.map(([typedChar, n]) => `${typedChar}: ${n}`).join(', ')
}

/** "b, e" — same sort as `formatTypedInstead`, chars only (no counts),
 *  for the row's own inline "→ ..." cell. Returns `null` (not
 *  `EMPTY_STAT_VALUE`) when there's nothing to show, so the caller can
 *  render the em-dash WITHOUT a leading arrow (`"→ —"` would read as if
 *  something specific were known and just happened to be a dash). */
function formatTypedCharsOnly(detail: MissedCharDetail | undefined): string | null {
  if (!detail) return null
  const entries = Object.entries(detail.typedCounts).sort(([, a], [, b]) => b - a)
  if (entries.length === 0) return null
  return entries.map(([typedChar]) => typedChar).join(', ')
}

/** Red (moved-on-uncorrected) / gray (corrected-with-Backspace) split of
 *  a row's own bar FILL, as percentages of the fill's own width (i.e. of
 *  `count`, not of the track) — the fill's own total width (relative to
 *  the track) is computed separately in `MissedTable` from `count` vs the
 *  list's own max, matching the old `MistakeRankingSection` bar's
 *  width-percent approach.
 *
 *  UNKNOWN-SPLIT ROWS (FLAGGED CHOICE): a row with no `detail` at all
 *  (legacy log predating this feature, or every contributing run's log
 *  hit the `charCorrelationUnavailable` bailout) has no way to know its
 *  own corrected/moved-on split — rendered as 100% gray (i.e. IDENTICAL
 *  to a row that genuinely had zero moved-on-uncorrected mistakes),
 *  rather than inventing a third visual state (e.g. a hatched/striped
 *  "unknown" fill) for what should be a rare case once recording consent
 *  is on. The bar alone can't tell these two apart — but the row's own
 *  hover tooltip does (`missedBarNoDetail`, a distinct sentence instead
 *  of the normal breakdown), so the information isn't lost, just not
 *  encoded in color. `movedOnCount` is defensively clamped to `count` in
 *  case the two ever disagree (they're computed via genuinely different
 *  code paths — `TypingTestResult.mistakes`'s real-time reducer tally vs
 *  `buildMissedDetails`'s best-effort per-keystroke log reconstruction —
 *  and aren't contractually guaranteed to match exactly). */
function barFillSplit(count: number, detail: MissedCharDetail | undefined): { movedOnPct: number; correctedPct: number } {
  if (!detail || count <= 0) return { movedOnPct: 0, correctedPct: 100 }
  const movedOn = Math.min(Math.max(detail.movedOnCount, 0), count)
  const movedOnPct = (movedOn / count) * 100
  return { movedOnPct, correctedPct: 100 - movedOnPct }
}

/** Hover tooltip content for a row's bar — exact figures the bar's own
 *  red/gray split only communicates visually. Reuses `formatTypedInstead`
 *  (WITH counts) for its own "Typed instead" line, unlike the row's
 *  inline cell. A legacy/no-detail row gets a single distinct sentence
 *  instead of the normal 3-line breakdown — see `barFillSplit`'s own doc
 *  comment for why the bar itself can't tell these two cases apart. */
function barTooltipContent(count: number, detail: MissedCharDetail | undefined, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (!detail) return t('editor.typingTest.results.missedBarNoDetail')
  const lines: string[] = []
  const typed = formatTypedInstead(detail)
  if (typed !== EMPTY_STAT_VALUE) {
    lines.push(t('editor.typingTest.results.missedBarTypedLine', { chars: typed }))
  }
  const movedOn = Math.min(Math.max(detail.movedOnCount, 0), count)
  lines.push(t('editor.typingTest.results.missedBarCorrectedLine', { count: count - movedOn }))
  lines.push(t('editor.typingTest.results.missedBarMovedOnLine', { count: movedOn }))
  return lines.join('\n')
}

interface MissedTableProps {
  mistakes: Record<string, number>
  /** Per-key detail — for a single run, derived from that run's own raw
   *  keystroke log (see `buildMissedDetails`, missed-details.ts); for the
   *  cross-run History ranking, the MERGED map from every available run's
   *  log (see `useAggregatedMissedDetails`, use-mistake-ranking-details.ts).
   *  A key with no entry (or no `details` map at all) renders its bar as
   *  fully "corrected" gray (unknown split — see `barFillSplit`) and its
   *  typed-chars cell as `EMPTY_STAT_VALUE`. */
  details?: Map<string, MissedCharDetail>
  /** Section-heading i18n key. Defaults to the single-run "Missed"
   *  heading (`mistakesLabel`); `MistakeRankingSection` passes its own
   *  "Most missed" key (`history.mistakeRankingTitle`) to reuse this
   *  exact row list for the cross-run ranking. */
  titleKey?: string
  /** Root element testid. Defaults to `'typing-test-missed-table'`;
   *  `MistakeRankingSection` overrides it to keep its own pre-existing
   *  `'typing-test-mistake-ranking'` contract (TypingTestHistory.tsx's
   *  Results/Analysis tab switch depends on it structurally). */
  testId?: string
  /** Scrollport's own max-height Tailwind class. Defaults to
   *  `MISSED_TABLE_MAX_HEIGHT` (`max-h-56`, ~8-10 rows) — History's
   *  "Most missed" Analysis-tab usage, which has no sibling competing for
   *  the same bounded space. `KeystrokeTimelinePanel` passes a smaller
   *  cap (`max-h-40`) for its own bounded-modal instance, so this table's
   *  worst-case footprint stays comfortably under the sibling timeline
   *  box's own `min-h-64` height floor — see that call site's own
   *  height-priority comment for the full mechanism. */
  maxHeightClass?: string
  /** Whether the scrollport itself carries its own `rounded-md border
   *  border-edge` frame. Defaults to `true` — History's "Most missed"
   *  section has no outer box of its own (see `MistakeRankingSection`'s
   *  doc comment: it sits among unboxed section-heading siblings), so
   *  the scrollport's border is its ONLY framing. `KeystrokeTimelinePanel`
   *  passes `false`: its own Missed section wrapper already frames the
   *  whole thing (see that call site), so the scrollport's own border
   *  was a redundant inner border double-stacked against the outer one. */
  bordered?: boolean
}

/** Bounds the row list's own scroll container to roughly 8-10 rows'
 *  height before it starts scrolling internally — a fixed rem value
 *  (14rem, Tailwind's `max-h-56`, on the 4px grid) rather than a
 *  `vh`-relative figure, matching `KeystrokeTimelinePanel`'s own
 *  scrollport sizing philosophy of not depending on ambient viewport
 *  size. FLAGGED PICK: N rows at ~1.375rem each (`text-xs` + `gap-1`)
 *  fits comfortably within 14rem for 8-10 rows before scrolling engages —
 *  picked as a reasonable middle of the spec's own "~8-10 rows" range,
 *  not derived from a measured DOM constant. Unaffected by the header
 *  row's removal — it was never load-bearing for this figure, just one
 *  more row's worth of height inside the same budget. */
const MISSED_TABLE_MAX_HEIGHT = 'max-h-56'

/** Per-key mistake bar-graph row list: Word / "→ typed instead chars" /
 *  stacked bar / Cnt — approved mockup replacing the earlier column-table
 *  presentation (headers + a separate Moved-on column; see git history).
 *  Renders nothing when `mistakes` has no entries, same convention as
 *  `MissedCharsList`.
 *
 *  BAR: total fill width is `count` normalized to the list's own max
 *  `count` (`(count / maxCount) * 100%` of the track) — the same
 *  width-percent approach the earlier bar-based `MistakeRankingSection`
 *  used before it became a table. WITHIN that fill, `barFillSplit` stacks
 *  two color segments: `bg-danger` (red) for `movedOnCount` (uncorrected)
 *  and `bg-content-muted` (gray) for the remainder (corrected with
 *  Backspace) — see that function's own doc comment for the
 *  unknown-split (no `detail`) case. FLAGGED COLOR CHOICE: the track
 *  itself stays `bg-surface-dim` (this codebase's established "subdued
 *  tint" track color, same as the old ranking bar and
 *  `ConnectingOverlay`'s progress track); the corrected segment uses
 *  `bg-content-muted` specifically so it reads as a distinct, visible
 *  gray FILL against that dimmer track background — there's no existing
 *  "neutral bar fill" token/precedent in this codebase to match exactly,
 *  so this reuses a token whose DESIGN.md role ("muted/disabled") is at
 *  least semantically adjacent, rather than introducing a new one.
 *
 *  UNCAPPED + internally scrollable (not truncated): every entry from
 *  `allSortedMistakeEntries` renders as its own row inside the bounded-
 *  height (`MISSED_TABLE_MAX_HEIGHT`) scroll container
 *  (`missed-table-scrollport`, `overflow-y-auto`, `p-2` on the scrollport
 *  itself — matching `.keystroke-timeline-scrollport`'s own precedent in
 *  KeystrokeTimelinePanel.tsx). `scrollbar-gutter: stable` (the
 *  `.missed-table-scrollport` class, style.css) reserves the vertical
 *  scrollbar's gutter unconditionally, same fix as
 *  `.keystroke-timeline-scrollport`, so the right-aligned Cnt column's
 *  edge never shifts the moment a real scrollbar appears. No sticky
 *  header anymore — the mockup has none, and the scroll container itself
 *  is otherwise unchanged from the earlier table version. */
export function MissedTable({
  mistakes, details,
  titleKey = 'editor.typingTest.results.mistakesLabel',
  testId = 'typing-test-missed-table',
  maxHeightClass = MISSED_TABLE_MAX_HEIGHT,
  bordered = true,
}: MissedTableProps) {
  const { t } = useTranslation()
  const entries = useMemo(() => allSortedMistakeEntries(mistakes), [mistakes])
  if (entries.length === 0) return null
  const maxCount = entries[0][1]
  const scrollportClass = [
    'missed-table-scrollport',
    'min-h-0',
    maxHeightClass,
    'overflow-y-auto',
    bordered ? 'rounded-md border border-edge' : null,
    'bg-surface p-2',
  ].filter(Boolean).join(' ')
  return (
    // `min-h-0` (harmless when this root isn't nested inside a
    // height-constrained flex ancestor, e.g. MistakeRankingSection's plain
    // block placement in History) is what lets `KeystrokeTimelinePanel`'s
    // own bounded-modal instance shrink this whole table below its natural
    // content size instead of overflowing — see that call site's own
    // height-priority comment (`typing-test-missed-box`'s `min-h-0`, not
    // `shrink-0`) for the full mechanism this propagates.
    <div className="flex min-h-0 flex-col gap-2" data-testid={testId}>
      <h3 className="text-xs font-semibold uppercase tracking-widest text-content-muted">
        {t(titleKey)}
      </h3>
      <div
        className={scrollportClass}
        data-testid="missed-table-scrollport"
      >
        <div className="flex flex-col gap-1">
          {entries.map(([key, count]) => {
            const detail = details?.get(key)
            const typedChars = formatTypedCharsOnly(detail)
            const fillPct = maxCount > 0 ? (count / maxCount) * 100 : 0
            const { movedOnPct, correctedPct } = barFillSplit(count, detail)
            return (
              <div
                key={key}
                className="grid items-center gap-x-2 text-xs"
                style={MISSED_ROW_GRID}
                data-testid={`missed-table-row-${key}`}
              >
                <span className="truncate font-mono text-content" data-testid={`missed-table-row-${key}-word`}>{key}</span>
                <span className="truncate text-content-muted" data-testid={`missed-table-row-${key}-typed`}>
                  {typedChars ? `→ ${typedChars}` : EMPTY_STAT_VALUE}
                </span>
                <Tooltip content={barTooltipContent(count, detail, t)} wrapperClassName="w-full">
                  <div
                    className="h-1.5 w-full overflow-hidden rounded bg-surface-dim"
                    data-testid={`missed-table-row-${key}-bar`}
                  >
                    <div className="flex h-full" style={{ width: `${fillPct}%` }}>
                      <div className="h-full bg-danger" style={{ width: `${movedOnPct}%` }} data-testid={`missed-table-row-${key}-bar-movedon`} />
                      <div className="h-full bg-content-muted" style={{ width: `${correctedPct}%` }} data-testid={`missed-table-row-${key}-bar-corrected`} />
                    </div>
                  </div>
                </Tooltip>
                <span className="text-right tabular-nums text-content" data-testid={`missed-table-row-${key}-count`}>{count}</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export interface ErrorClassCounts {
  substitutions: number
  omissions: number
  insertions: number
}

interface ErrorClassLineProps {
  errorClasses: ErrorClassCounts
}

/** Raw Substitution/Omission/Insertion counts (see
 *  `TypingTestResult.errorSubstitutions` et al.) — the caller withholds
 *  this entirely (never renders a '-' row) when the run has no error-class
 *  group at all (romaji run, no finalized words, legacy result). */
export function ErrorClassLine({ errorClasses }: ErrorClassLineProps) {
  const { t } = useTranslation()
  return (
    <div data-testid="typing-test-error-classes" className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-content-muted">
      <span data-testid="typing-test-error-substitutions">
        {t('editor.typingTest.results.errorSubstitutions', { count: errorClasses.substitutions })}
      </span>
      <span data-testid="typing-test-error-omissions">
        {t('editor.typingTest.results.errorOmissions', { count: errorClasses.omissions })}
      </span>
      <span data-testid="typing-test-error-insertions">
        {t('editor.typingTest.results.errorInsertions', { count: errorClasses.insertions })}
      </span>
    </div>
  )
}
