// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../../i18n'
import { ComparisonToggle } from '../ComparisonToggle'
import type { ComparisonBaselineKind } from '../../../../shared/types/pipette-settings'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

function getToggleButton() {
  return screen.getByTestId('typing-test-comparison-toggle')
}

describe('ComparisonToggle — active-state accent color', () => {
  it('renders the neutral (non-accent) style when the baseline is off', () => {
    renderWithI18n(<ComparisonToggle pool={[]} baseline={{ kind: 'off' }} />)
    const button = getToggleButton()
    expect(button.className).toContain('border-edge')
    expect(button.className).toContain('text-content-secondary')
    expect(button.className).not.toContain('border-accent')
    expect(button.className).not.toContain('text-accent')
  })

  it.each<ComparisonBaselineKind>(['previous', 'best', 'average', 'pinned'])(
    'renders the accent style when the baseline is active (%s)',
    (kind) => {
      renderWithI18n(<ComparisonToggle pool={[]} baseline={{ kind }} />)
      const button = getToggleButton()
      expect(button.className).toContain('border-accent')
      expect(button.className).toContain('text-accent')
      expect(button.className).not.toContain('border-edge')
    },
  )
})
