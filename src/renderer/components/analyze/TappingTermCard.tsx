// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze > Interval > TAPPING_TERM advisor — Pipette-only diagnosis
// checking a keyboard's configured TAPPING_TERM against the user's own
// measured keypress durations on its tap-hold keys. See the pure
// logic in analyze-tapping-term.ts, which owns every statistical
// decision made here — this component only fetches, filters to
// tap-hold cells, and renders.
//
// One of the three panes AnalyzePane's "Section" filter-row select
// picks between (see `DistributionSection` in
// shared/types/analyze-filters.ts), distribution mode only (same
// gate). Deliberately has NO apply button and no keymap-write path of
// any kind — see the module header on analyze-tapping-term.ts: a
// histogram can suggest a candidate value, never guarantee one is
// safe, so wiring this to an auto-apply action would overstate what
// the data supports.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { TypingDurationCell, TypingKeymapSnapshot, TypingMatrixCellRow } from '../../../shared/types/typing-analytics'
import { analyzeTappingTerm, type PercentileRangeMs, type TappingTermAdvice } from './analyze-tapping-term'
import { selectTapHoldDurationCells, selectTapHoldMatrixCells, tapHoldPositionKeys } from './analyze-tapping-term-cells'
import { sumDurationTotals, type DurationTotals } from './analyze-duration'
import type { ConnectedTappingTerm, DeviceScope, RangeMs } from './analyze-types'
import { fetchDurationCellsForRange, listMatrixCellsForScope } from './analyze-fetch'
import { fmtMs } from './analyze-format'
import type { AnalyzeSummaryItem } from './analyze-summary-table'
import { AnalyzeStatGrid } from './stat-card'
import { EMPTY_STAT_VALUE } from './analyze-constants'

interface Props {
  uid: string
  range: RangeMs
  appScopes: string[]
  typingTestScopes: string[]
  runIdScopes: string[]
  /** `null`/loading snapshot both mean "don't render anything yet" —
   * see the module header and AnalyzePane's mount site. */
  snapshot: TypingKeymapSnapshot | null
  snapshotLoading: boolean
  /** `null` when the pane's selected keyboard isn't the one physically
   * connected right now — renders the "connect this keyboard" guidance
   * state instead of a diagnosis. */
  connectedTappingTerm: ConnectedTappingTerm | null
}

const EMPTY_TAP_HOLD_KEYS: ReadonlySet<string> = new Set()

function formatMsRange(range: PercentileRangeMs): string {
  return `${Math.round(range.lo)}–${Math.round(range.hi)} ms`
}

/** Populated-diagnosis body — stat grid, verdict line, and the
 * reported/unreported footer. Only ever called once both
 * `connectedTappingTerm` and `advice` are known non-null, so it takes
 * them un-nullable rather than the caller sprinkling `advice!`
 * assertions through the JSX. */
function renderDiagnosis(
  t: TFunction,
  connectedTappingTerm: ConnectedTappingTerm,
  advice: TappingTermAdvice,
  totals: DurationTotals,
  tapCount: number,
  holdCount: number,
): JSX.Element {
  const statItems: AnalyzeSummaryItem[] = [
    {
      labelKey: connectedTappingTerm.reported ? 'analyze.tappingTerm.stat.current' : 'analyze.tappingTerm.stat.assumed',
      value: fmtMs(connectedTappingTerm.termMs),
    },
    {
      labelKey: 'analyze.tappingTerm.stat.tapP95',
      value: advice.tapP95Range ? formatMsRange(advice.tapP95Range) : EMPTY_STAT_VALUE,
      descriptionKey: 'analyze.tappingTerm.stat.tapP95Desc',
    },
    {
      labelKey: 'analyze.tappingTerm.stat.samples',
      value: totals.samples.toLocaleString(),
    },
    {
      labelKey: 'analyze.tappingTerm.stat.recordedCounts',
      value: `${tapCount.toLocaleString()} / ${holdCount.toLocaleString()}`,
      descriptionKey: 'analyze.tappingTerm.recordedCountsDescription',
    },
  ]
  // `unknown` splits into three i18n keys (see analyze-tapping-term.ts's
  // `TappingTermUnknownReason`) so the copy names the actual cause
  // instead of one generic "not enough data" that would misstate two
  // of the three.
  const verdictKey = advice.verdict === 'unknown'
    ? `analyze.tappingTerm.verdict.unknown.${advice.unknownReason}`
    : `analyze.tappingTerm.verdict.${advice.verdict}`

  return (
    <>
      <AnalyzeStatGrid
        items={statItems}
        ariaLabelKey="analyze.tappingTerm.ariaLabel"
        testId="analyze-tapping-term-summary"
      />
      <p className="text-2xs text-content-muted" data-testid="analyze-tapping-term-verdict">
        {t(verdictKey, advice.verdict === 'canLower' ? { value: advice.suggestedMs } : undefined)}
      </p>
      {connectedTappingTerm.reported ? (
        <p className="text-2xs text-content-muted" data-testid="analyze-tapping-term-reported-hint">
          {t('analyze.tappingTerm.reportedHint', {
            tab: t('keycodes.tapDance'),
            button: t('editor.keymap.tapHoldLabel'),
          })}
        </p>
      ) : (
        <p className="text-2xs text-content-muted" data-testid="analyze-tapping-term-unreported-notice">
          {t('analyze.tappingTerm.unreportedNotice', { default: connectedTappingTerm.termMs })}
        </p>
      )}
    </>
  )
}

export function TappingTermCard({
  uid,
  range,
  appScopes,
  typingTestScopes,
  runIdScopes,
  snapshot,
  snapshotLoading,
  connectedTappingTerm,
}: Props) {
  const { t } = useTranslation()
  const [durationCells, setDurationCells] = useState<TypingDurationCell[]>([])
  const [matrixCells, setMatrixCells] = useState<TypingMatrixCellRow[]>([])
  const [loading, setLoading] = useState(true)

  // Always 'own', never derived from the pane's Device filter: this
  // card mounts only alongside DurationSection in Interval's
  // distribution mode, which is one of the surfaces
  // `distributionForcesOwnDevice` in shared/types/analyze-filters.ts
  // documents as forced to 'own' lockstep (see that predicate's doc
  // comment) — this card just has no `viewMode` of its own to pass
  // into it, so it hardcodes the same answer directly.
  const deviceScope: DeviceScope = 'own'

  const tapHoldKeys = useMemo(
    () => (snapshot ? tapHoldPositionKeys(snapshot) : EMPTY_TAP_HOLD_KEYS),
    [snapshot],
  )
  const hasTapHoldKeys = tapHoldKeys.size > 0
  const isConnected = connectedTappingTerm !== null

  // Tracks the args-key of the last COMPLETED fetch (mirrors
  // `useModeFetch`'s `fetchKeyRef` semantics). `loading` state alone
  // only flips true once the effect below actually runs — the render
  // right after a props change (range, scope, ...) but before that
  // effect has fired would otherwise show the PREVIOUS fetch's
  // diagnosis with `loading` still false. Comparing this ref against
  // the current key at render time catches that render too, not just
  // the ones after the effect has had a chance to run.
  const fetchKeyRef = useRef<string | null>(null)
  const fetchKey = JSON.stringify([uid, deviceScope, range.fromMs, range.toMs, appScopes, typingTestScopes, runIdScopes, hasTapHoldKeys, isConnected])

  useEffect(() => {
    if (!uid || !hasTapHoldKeys || !isConnected) {
      setDurationCells([])
      setMatrixCells([])
      setLoading(false)
      fetchKeyRef.current = fetchKey
      return
    }
    let cancelled = false
    setLoading(true)
    Promise.all([
      fetchDurationCellsForRange(uid, deviceScope, range.fromMs, range.toMs, appScopes, typingTestScopes, runIdScopes)
        .catch(() => [] as TypingDurationCell[]),
      listMatrixCellsForScope(uid, deviceScope, range.fromMs, range.toMs, appScopes, typingTestScopes, runIdScopes)
        .catch(() => [] as TypingMatrixCellRow[]),
    ])
      .then(([durationRows, matrixRows]) => {
        if (cancelled) return
        setDurationCells(durationRows)
        setMatrixCells(matrixRows)
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
        fetchKeyRef.current = fetchKey
      })
    return () => { cancelled = true }
    // `isConnected` (not `connectedTappingTerm` itself): the fetched
    // rows don't depend on the term's value, only on whether a term
    // exists to diagnose against — a settings write or reconnect that
    // only changes `termMs`/`reported` must not refetch identical rows.
    // `connectedTappingTerm` (the object) stays out of this array on
    // purpose; the diagnosis memo below is what actually needs its value.
  }, [uid, deviceScope, range, appScopes, typingTestScopes, runIdScopes, hasTapHoldKeys, isConnected, fetchKey])

  const totals = useMemo(
    () => sumDurationTotals(selectTapHoldDurationCells(tapHoldKeys, durationCells)),
    [tapHoldKeys, durationCells],
  )
  const { tapCount, holdCount } = useMemo(() => {
    const cells = selectTapHoldMatrixCells(tapHoldKeys, matrixCells)
    return cells.reduce(
      (acc, cell) => ({ tapCount: acc.tapCount + cell.tap, holdCount: acc.holdCount + cell.hold }),
      { tapCount: 0, holdCount: 0 },
    )
  }, [tapHoldKeys, matrixCells])

  // Bundles `connectedTappingTerm` with its derived `advice` into ONE
  // nullable value instead of two separately-nullable ones that only
  // happen to agree: `advice` is only ever computed here, from an
  // already-non-null `connectedTappingTerm`, so there is no state
  // where this is null while `connectedTappingTerm` isn't (or vice
  // versa) for the render below to have to account for.
  const diagnosis = useMemo(() => {
    if (!connectedTappingTerm) return null
    return { connectedTappingTerm, advice: analyzeTappingTerm(totals.hist, connectedTappingTerm.termMs) }
  }, [totals, connectedTappingTerm])

  const showLoading = loading || fetchKeyRef.current !== fetchKey

  if (snapshotLoading || !hasTapHoldKeys) return null

  return (
    // No visible <h3> here — this card only ever renders under
    // AnalyzePane's "Section" filter-row select, which already labels
    // it (shared `sectionTitle` key), so a second in-body heading would
    // just repeat it. `aria-label` on the section itself keeps the
    // name available to assistive tech (as a named landmark) even
    // without a visible heading to navigate by.
    <section
      className="flex flex-col gap-2 border-t border-edge pt-3"
      data-testid="analyze-tapping-term-section"
      aria-label={t('analyze.tappingTerm.sectionTitle')}
    >
      {!diagnosis ? (
        <p className="py-4 text-center text-sm text-content-muted" data-testid="analyze-tapping-term-guidance">
          {t('analyze.tappingTerm.guidance')}
        </p>
      ) : showLoading ? (
        <div className="py-4 text-center text-sm text-content-muted" data-testid="analyze-tapping-term-loading">
          {t('common.loading')}
        </div>
      ) : (
        renderDiagnosis(t, diagnosis.connectedTappingTerm, diagnosis.advice, totals, tapCount, holdCount)
      )}
    </section>
  )
}
