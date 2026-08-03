// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
//
// NOTE (deviation from the old WpmSparkline.test.tsx): the component was
// rewritten from a bare SVG polyline to a recharts LineChart (matching
// AccuracyTrendChart's own pattern) so its Results-view chart gets the same
// hover-tooltip parity as the Accuracy Trend chart. The `width`/`height`
// props are gone — the chart is now full-width/responsive, like the
// Accuracy Trend chart, instead of a fixed centered 400x50 box — so the old
// assertions on those props and on the raw `<svg><polyline>` DOM no longer
// apply and are replaced below.

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { WpmTrendChart } from '../WpmTrendChart'
import type { TypingTestResult } from '../../../shared/types/pipette-settings'

function makeResult(overrides: Partial<TypingTestResult> = {}): TypingTestResult {
  return {
    date: '2026-06-20T00:00:00.000Z',
    wpm: 60,
    accuracy: 95,
    wordCount: 30,
    correctChars: 300,
    incorrectChars: 5,
    durationSeconds: 30,
    ...overrides,
  }
}

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

describe('WpmTrendChart', () => {
  it('renders nothing with fewer than 2 results', () => {
    const { container } = renderWithI18n(<WpmTrendChart results={[makeResult()]} />)
    expect(container.querySelector('[data-testid="wpm-trend-chart"]')).toBeNull()
  })

  it('renders nothing with zero results', () => {
    const { container } = renderWithI18n(<WpmTrendChart results={[]} />)
    expect(container.querySelector('[data-testid="wpm-trend-chart"]')).toBeNull()
  })

  it('renders the chart container for 2+ results', () => {
    const results = [
      makeResult({ date: '2026-06-18T00:00:00.000Z', wpm: 60 }),
      makeResult({ date: '2026-06-19T00:00:00.000Z', wpm: 80 }),
    ]
    renderWithI18n(<WpmTrendChart results={results} />)
    expect(screen.getByTestId('wpm-trend-chart')).toBeTruthy()
  })

  it('renders regardless of the input ordering (sorts internally by date)', () => {
    const results = [
      makeResult({ date: '2026-06-20T00:00:00.000Z', wpm: 70 }),
      makeResult({ date: '2026-06-18T00:00:00.000Z', wpm: 60 }),
      makeResult({ date: '2026-06-19T00:00:00.000Z', wpm: 65 }),
    ]
    renderWithI18n(<WpmTrendChart results={results} />)
    expect(screen.getByTestId('wpm-trend-chart')).toBeTruthy()
  })

  it('suppresses the focus-ring outline on the chart wrapper (recharts accessibilityLayer regression guard)', () => {
    const results = [
      makeResult({ date: '2026-06-18T00:00:00.000Z', wpm: 60 }),
      makeResult({ date: '2026-06-19T00:00:00.000Z', wpm: 80 }),
    ]
    renderWithI18n(<WpmTrendChart results={results} />)
    const wrapper = screen.getByTestId('wpm-trend-chart')
    expect(wrapper.className).toContain('[&_*]:focus:outline-none')
    expect(wrapper.className).toContain('[&_*]:focus-visible:outline-none')
  })
})
