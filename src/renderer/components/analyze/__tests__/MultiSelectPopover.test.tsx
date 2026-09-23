// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later
// The trigger button caps its width and truncates a long single-selection
// label (e.g. a TypingTest material name) — the filter grid's max-content
// columns would otherwise widen to fit an uncapped label — and exposes the
// full text via the shared Tooltip component
// (src/renderer/components/ui/Tooltip.tsx); native `title` attributes on
// DOM elements are forbidden project-wide.

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
  it('truncates a long single-selection label and exposes it via the shared Tooltip', () => {
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
    expect(trigger).not.toHaveAttribute('title')
    const bubble = screen.getByRole('tooltip')
    expect(bubble.textContent).toBe(LONG_LABEL)
    expect(trigger.getAttribute('aria-describedby')).toBe(bubble.id)
  })

  it('shows the none-selected label via the shared Tooltip when nothing is picked', () => {
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
    expect(trigger).not.toHaveAttribute('title')
    expect(screen.getByRole('tooltip').textContent).toBe('analyze.filters.appOption.none')
  })
})

describe('MultiSelectPopover panel', () => {
  it('caps the panel width and wraps long option labels instead of widening', async () => {
    // The panel caps its width (max-w-dropdown) and wraps long option
    // labels (break-words, not truncate) — an uncapped fit-content panel
    // would otherwise grow with its longest option label.
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
