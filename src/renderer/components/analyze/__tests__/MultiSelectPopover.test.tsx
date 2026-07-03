// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later
// Trigger-truncation regression: a long single-selection label (e.g. a
// TypingTest material name) used to render at full width with no cap,
// which widened the whole filter grid (max-content columns). The trigger
// button must clamp + truncate and expose the full label via `title`.

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MultiSelectPopover } from '../MultiSelectPopover'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
    i18n: { language: 'en' },
  }),
}))

const LONG_LABEL = 'A very long imported typing-test material name that would otherwise stretch the filter row'

describe('MultiSelectPopover trigger', () => {
  it('truncates a long single-selection label and exposes it via title', () => {
    render(
      <MultiSelectPopover
        options={[{ value: 'long', label: LONG_LABEL }]}
        value={['long']}
        onChange={() => {}}
        i18nPrefix="analyze.filters.typingTestOption"
        testId="analyze-filter-typing-test"
      />,
    )
    const trigger = screen.getByTestId('analyze-filter-typing-test')
    expect(trigger).toHaveTextContent(LONG_LABEL)
    expect(trigger.className).toContain('truncate')
    expect(trigger.className).toContain('max-w-filter-trigger')
    expect(trigger).toHaveAttribute('title', LONG_LABEL)
  })

  it('shows the none-selected label as the title when nothing is picked', () => {
    render(
      <MultiSelectPopover
        options={[{ value: 'a', label: 'A' }]}
        value={[]}
        onChange={() => {}}
        i18nPrefix="analyze.filters.appOption"
        testId="analyze-filter-app"
      />,
    )
    const trigger = screen.getByTestId('analyze-filter-app')
    expect(trigger).toHaveAttribute('title', 'analyze.filters.appOption.none')
  })
})

describe('MultiSelectPopover panel', () => {
  it('caps the panel width and wraps long option labels instead of widening', async () => {
    // Regression: a long label used to widen the fit-content panel past the
    // viewport's right edge (fixed-position portal), clipping the options.
    render(
      <MultiSelectPopover
        options={[{ value: 'long', label: LONG_LABEL }]}
        value={[]}
        onChange={() => {}}
        i18nPrefix="analyze.filters.typingTestOption"
        testId="analyze-filter-typing-test"
      />,
    )
    screen.getByTestId('analyze-filter-typing-test').click()
    const option = await screen.findByTestId('analyze-filter-typing-test-option-long')
    const labelSpan = option.querySelector('span')
    expect(labelSpan?.className).toContain('break-words')
    expect(labelSpan?.className).not.toContain('truncate')
    const panel = option.closest('[role="listbox"]')
    expect(panel?.className).toContain('max-w-dropdown')
  })
})
