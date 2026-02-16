// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { WpmSparkline } from '../WpmSparkline'
import type { TypingTestResult } from '../../../shared/types/pipette-settings'

function makeResult(wpm: number): TypingTestResult {
  return {
    date: new Date().toISOString(),
    wpm,
    accuracy: 95,
    wordCount: 30,
    correctChars: 100,
    incorrectChars: 5,
    durationSeconds: 30,
  }
}

describe('WpmSparkline', () => {
  it('renders nothing with fewer than 2 results', () => {
    const { container } = render(<WpmSparkline results={[makeResult(60)]} />)
    expect(container.querySelector('svg')).toBeNull()
  })

  it('renders SVG with polyline for 2+ results', () => {
    render(<WpmSparkline results={[makeResult(60), makeResult(80), makeResult(70)]} />)
    const svg = screen.getByTestId('wpm-sparkline')
    expect(svg).toBeTruthy()
    expect(svg.querySelector('polyline')).toBeTruthy()
  })

  it('uses custom width and height', () => {
    render(
      <WpmSparkline
        results={[makeResult(50), makeResult(90)]}
        width={200}
        height={40}
      />,
    )
    const svg = screen.getByTestId('wpm-sparkline')
    expect(svg.getAttribute('width')).toBe('200')
    expect(svg.getAttribute('height')).toBe('40')
  })
})
