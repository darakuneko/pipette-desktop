// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later
// `AnalyzeFilterSummaryChip` closed-state summary: renders the four
// truncated segments and opens the staged filter modal on click.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AnalyzeFilterSummaryChip } from '../AnalyzeFilterSummaryChip'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}))

describe('AnalyzeFilterSummaryChip', () => {
  it('renders each label segment with truncation and opens the modal on click', () => {
    const onClick = vi.fn()
    render(
      <AnalyzeFilterSummaryChip
        keyboardLabel="A very long keyboard product name that would otherwise stretch the row"
        deviceLabel="linux - 6.8 (ownhash0)"
        sourceLabel="words (english)"
        periodLabel="2026/04/01 00:00 - 2026/04/03 00:00"
        onClick={onClick}
      />,
    )
    const chip = screen.getByTestId('analyze-filter-chip')
    expect(chip.className).toContain('min-w-0')
    expect(screen.getByTestId('analyze-filter-chip-keyboard').className).toContain('truncate')
    expect(screen.getByTestId('analyze-filter-chip-device')).toHaveTextContent('linux - 6.8 (ownhash0)')
    expect(screen.getByTestId('analyze-filter-chip-source')).toHaveTextContent('words (english)')
    expect(screen.getByTestId('analyze-filter-chip-period')).toHaveTextContent('2026/04/01 00:00 - 2026/04/03 00:00')

    fireEvent.click(chip)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('honors a custom testId prefix for split-view pane B', () => {
    render(
      <AnalyzeFilterSummaryChip
        keyboardLabel="KB A"
        deviceLabel="This device"
        sourceLabel="All apps"
        periodLabel="range"
        onClick={() => {}}
        testId="analyze-filter-chip-b"
      />,
    )
    expect(screen.getByTestId('analyze-filter-chip-b')).toBeInTheDocument()
    expect(screen.getByTestId('analyze-filter-chip-b-keyboard')).toHaveTextContent('KB A')
  })
})
