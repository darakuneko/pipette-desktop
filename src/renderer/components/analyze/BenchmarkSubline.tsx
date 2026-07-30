// SPDX-License-Identifier: GPL-2.0-or-later
// Shared "Population avg {{value}} · {{position}}" subline — one home for
// the separator glyph and key composition, used by the Speed cell and
// KSPC cell (TypingProfileCard) and DurationSection's mean stat card, so
// the three can't drift into slightly different renderings of the same
// idea.

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { BenchmarkPosition } from './analyze-benchmark'

interface Props {
  /** i18n key for the population-average phrase. The caller bakes its
   * own unit into the key per this namespace's existing convention (see
   * analyze.benchmark.populationAverage for WPM, .populationAverageKspc
   * for the unit-free KSPC ratio, analyze.duration.stat.populationAverage
   * for ms). */
  populationAverageKey: string
  /** Already-formatted population mean (e.g. "51.6", "116.3", "1.17"). */
  value: string
  /** Never `null` in practice by the time this component is reached — the
   * "nothing to report" decision belongs to the caller (`position &&
   * <BenchmarkSubline .../>`), not to this component. A JSX element is
   * always truthy, so a null check performed *inside* here can never be
   * observed by a caller testing this component's own return value (e.g.
   * StatCard's `{context || ' '}` height fallback) — see the call sites in
   * TypingProfileCard and DurationSection for the actual guard. */
  position: BenchmarkPosition
  /** The Speed cell renders this subline below its own WPM-context line
   * via a leading line break; DurationSection and the KSPC cell render it
   * as their sole context line and don't want the extra break. */
  leadingBreak?: boolean
}

export function BenchmarkSubline({ populationAverageKey, value, position, leadingBreak }: Props): ReactNode {
  const { t } = useTranslation()
  return (
    <>
      {leadingBreak && <br />}
      {t(populationAverageKey, { value })}
      {' · '}
      {t(`analyze.benchmark.position.${position.label}`)}
    </>
  )
}
