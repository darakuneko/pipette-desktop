// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later
// The "nothing to report" decision moved to each call site (`position &&
// <BenchmarkSubline .../>`) — this component itself always renders once
// reached, since a JSX element is always truthy and a null check performed
// inside it can never be observed by a caller checking its own return value
// (see StatCard's `{context || ' '}` height fallback). Covers only the
// rendering contract itself; the call-site guards are covered by
// TypingProfileCard.test.tsx / DurationSection's own tests.

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BenchmarkSubline } from '../BenchmarkSubline'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
  }),
}))

describe('BenchmarkSubline', () => {
  it('renders the population-average phrase and position label given a non-null position', () => {
    render(
      <BenchmarkSubline
        populationAverageKey="analyze.benchmark.populationAverage"
        value="51.6"
        position={{ z: 0.2, label: 'average' }}
      />,
    )
    expect(screen.getByText(/analyze\.benchmark\.populationAverage/)).toBeInTheDocument()
    expect(screen.getByText(/analyze\.benchmark\.position\.average/)).toBeInTheDocument()
  })

  it('omits the leading line break unless leadingBreak is set', () => {
    const { container } = render(
      <BenchmarkSubline
        populationAverageKey="analyze.benchmark.populationAverageKspc"
        value="1.17"
        position={{ z: -2, label: 'farBelow' }}
      />,
    )
    expect(container.querySelector('br')).toBeNull()
  })

  it('renders a leading line break when leadingBreak is set', () => {
    const { container } = render(
      <BenchmarkSubline
        populationAverageKey="analyze.benchmark.populationAverage"
        value="51.6"
        position={{ z: 1.8, label: 'farAbove' }}
        leadingBreak
      />,
    )
    expect(container.querySelector('br')).not.toBeNull()
  })
})
