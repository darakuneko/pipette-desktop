// SPDX-License-Identifier: GPL-2.0-or-later

import type { TypingTestResult } from '../../shared/types/pipette-settings'
import { AccuracyTrendSection } from './AccuracyTrendSection'
import { MistakeRankingSection } from './MistakeRankingSection'
import { ErrorMixSection } from './ErrorMixSection'

interface Props {
  /** Active tab's unfiltered results (mode filter doesn't apply — each
   *  section below scopes/filters independently, matching their own
   *  prop docs in AccuracyTrendSection/MistakeRankingSection/ErrorMixSection). */
  tabResults: TypingTestResult[]
  /** Forwarded to AccuracyTrendSection — the condition `<select>` itself now
   *  lives in TypingTestHistory's header (right-end group, next to the
   *  source select), so this is the parent-resolved key that section uses
   *  to pick its chart's series. */
  selectedCondition: string
  /** ARIA tabpanel wiring for the History modal's Results/Analysis secondary
   *  tabs (TypingTestHistory). Applied directly to this component's own root
   *  div — NOT an extra wrapper div in the caller — because a plain block
   *  div in between would break the flex sizing chain: `min-h-0`/`shrink`
   *  only take effect on a flex item, and the wrapper's default `display:
   *  block` meant this div's own `min-h-0 shrink overflow-y-auto` had no
   *  bounded height to measure against, so it grew to fit its content and
   *  overflowed past the modal's bottom edge (the exact bug #377 fixed,
   *  reappearing through this new layer). */
  id: string
  ariaLabelledBy: string
}

/** The History modal's "Analysis" view: accuracy trend, mistake ranking,
 *  error mix. Wraps in its own `min-h-0 shrink overflow-y-auto` container so
 *  a tall stack (e.g. many mistake-ranking rows) scrolls independently
 *  instead of pushing past the modal's bottom edge (flex children don't
 *  shrink below their content height otherwise). */
export function HistorySections({ tabResults, selectedCondition, id, ariaLabelledBy }: Props) {
  return (
    <div
      role="tabpanel"
      id={id}
      aria-labelledby={ariaLabelledBy}
      className="flex min-h-0 shrink flex-col gap-3 overflow-y-auto"
      data-testid="history-sections"
    >
      <AccuracyTrendSection results={tabResults} selectedCondition={selectedCondition} />
      <MistakeRankingSection results={tabResults} />
      <ErrorMixSection results={tabResults} />
    </div>
  )
}
