// SPDX-License-Identifier: GPL-2.0-or-later
//
// Small coverage indicator used in the language pack list. Three
// colour bands match the operation-guide "looks healthy / mostly OK
// / definitely missing things" buckets so the user can spot drift at
// a glance without reading the percentage.

import { useEffect, useState } from 'react'
import { getCachedCoverage, subscribeCoverage, refreshCoverageFromIpc } from '../../i18n/coverage-cache'
import type { CoverageResult } from '../../../shared/i18n/coverage'

interface CoverageBadgeProps {
  packId: string
  packVersion: string
}

function bandClass(ratio: number): string {
  if (ratio >= 1) return 'bg-green-500/20 text-green-700 dark:text-green-300'
  if (ratio >= 0.8) return 'bg-yellow-500/20 text-yellow-700 dark:text-yellow-300'
  return 'bg-red-500/20 text-red-700 dark:text-red-300'
}

export function CoverageBadge({ packId, packVersion }: CoverageBadgeProps): JSX.Element {
  const [coverage, setCoverage] = useState<CoverageResult | null>(() =>
    getCachedCoverage(packId, packVersion),
  )

  useEffect(() => {
    let cancelled = false
    // Subscribe first so a recompute that lands between cache lookup
    // and subscription is not lost. The handler refreshes from cache
    // only when there is something fresh to show.
    const unsub = subscribeCoverage(() => {
      const next = getCachedCoverage(packId, packVersion)
      if (next && !cancelled) setCoverage(next)
    })
    if (!getCachedCoverage(packId, packVersion)) {
      void refreshCoverageFromIpc(packId, packVersion).then((result) => {
        if (!cancelled && result) setCoverage(result)
      })
    }
    return () => {
      cancelled = true
      unsub()
    }
  }, [packId, packVersion])

  if (!coverage) {
    return (
      <span
        className="inline-flex items-center rounded bg-edge/40 px-2 py-0.5 text-xs text-content-muted"
        data-testid={`coverage-badge-${packId}-loading`}
      >
        …
      </span>
    )
  }

  const pct = Math.round(coverage.coverageRatio * 100)
  const tooltip = `${String(coverage.coveredKeys)} / ${String(coverage.totalKeys)} keys`
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${bandClass(coverage.coverageRatio)}`}
      title={tooltip}
      data-testid={`coverage-badge-${packId}`}
    >
      {String(pct)}%
    </span>
  )
}
