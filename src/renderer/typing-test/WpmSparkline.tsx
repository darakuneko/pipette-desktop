// SPDX-License-Identifier: GPL-2.0-or-later

import type { TypingTestResult } from '../../shared/types/pipette-settings'

interface Props {
  results: TypingTestResult[]
  width?: number
  height?: number
}

export function WpmSparkline({ results, width = 300, height = 60 }: Props) {
  if (results.length < 2) return null

  const wpms = results.map((r) => r.wpm)
  const min = Math.min(...wpms)
  const max = Math.max(...wpms)
  const range = max - min || 1

  const padding = 2
  const innerWidth = width - padding * 2
  const innerHeight = height - padding * 2

  const points = wpms
    .map((wpm, i) => {
      const x = padding + (i / (wpms.length - 1)) * innerWidth
      const y = padding + innerHeight - ((wpm - min) / range) * innerHeight
      return `${x},${y}`
    })
    .join(' ')

  return (
    <svg
      data-testid="wpm-sparkline"
      width={width}
      height={height}
      className="text-accent"
      aria-hidden="true"
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
