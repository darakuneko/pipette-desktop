// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../../i18n'
import { TypingTestPaneSettingsPanel } from '../TypingTestPaneSettingsPanel'
import { DEFAULT_CONFIG, DEFAULT_LANGUAGE } from '../../../typing-test/types'
import type { useTypingTest } from '../../../typing-test/useTypingTest'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

/** Minimal fake of useTypingTest's return value — only the fields this
 *  panel (and the TypingTestSettingsBar it renders) actually reads are
 *  populated; everything else is irrelevant to the "Lines" select this
 *  file tests, so it's cast through `unknown` rather than hand-filling
 *  every function useTypingTest returns. `layers` is left at 1 (the
 *  default in the props below) so the Base Layer select — the only other
 *  consumer of `typingTest.baseLayer`/`setBaseLayer` — never renders. */
function fakeTypingTest(): ReturnType<typeof useTypingTest> {
  return {
    config: DEFAULT_CONFIG,
    language: DEFAULT_LANGUAGE,
    isLanguageLoading: false,
    state: { currentQuote: null, romajiCapable: false },
    baseLayer: 0,
    setBaseLayer: vi.fn(),
  } as unknown as ReturnType<typeof useTypingTest>
}

describe('TypingTestPaneSettingsPanel — Lines select', () => {
  it('offers 1 as the first (smallest) option, one visible reading-window line', () => {
    renderWithI18n(
      <TypingTestPaneSettingsPanel
        typingTest={fakeTypingTest()}
        showLanguageModal={false}
        onShowLanguageModal={vi.fn()}
        onConfigChange={vi.fn()}
        onLanguageChange={vi.fn()}
        layers={1}
        saveUnnamed
        settingsPanelOpen
        sameConditionResults={[]}
        comparisonBaselineValue={{ kind: 'off' }}
        handleComparisonChange={vi.fn()}
      />,
    )
    const select = screen.getByTestId('display-lines-select') as HTMLSelectElement
    const values = Array.from(select.options).map((o) => o.value)
    expect(values[0]).toBe('1')
    // Selecting it must not get silently clamped back to a higher value —
    // the option itself exists and is independently selectable.
    expect(values).toContain('1')
  })
})
