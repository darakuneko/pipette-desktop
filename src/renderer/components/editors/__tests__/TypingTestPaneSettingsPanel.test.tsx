// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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
    // Real (non-optional) fixture — WeakSpotSettingsModal reads
    // `weakSpotGate.status` unconditionally once mounted.
    weakSpotGate: { applicable: true, status: 'unavailable' },
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

describe('TypingTestPaneSettingsPanel — Weak Spot Training DATA button', () => {
  function renderPanel(typingTest: ReturnType<typeof useTypingTest>) {
    renderWithI18n(
      <TypingTestPaneSettingsPanel
        typingTest={typingTest}
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
  }

  it('renders below Compare (Data section), inert-styled when weakSpotTrainingMode is off', () => {
    renderPanel(fakeTypingTest())
    const button = screen.getByTestId('weak-spot-settings-toggle')
    expect(button).toBeInTheDocument()
    expect(button.className).not.toContain('text-accent')
  })

  it('is accent-styled when weakSpotTrainingMode is on', () => {
    const typingTest = {
      ...fakeTypingTest(),
      config: { mode: 'words' as const, wordCount: 30, punctuation: false, numbers: false, weakSpotTrainingMode: true },
    } as unknown as ReturnType<typeof useTypingTest>
    renderPanel(typingTest)
    expect(screen.getByTestId('weak-spot-settings-toggle').className).toContain('text-accent')
  })

  it('opens the WeakSpotSettingsModal on click', () => {
    renderPanel(fakeTypingTest())
    expect(screen.queryByTestId('weak-spot-settings-modal')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('weak-spot-settings-toggle'))
    expect(screen.getByTestId('weak-spot-settings-modal')).toBeInTheDocument()
  })

  it('renders below the DATA button', () => {
    renderPanel(fakeTypingTest())
    const button = screen.getByTestId('weak-spot-settings-toggle')
    // fakeTypingTest's gate status stays 'unavailable' here, so no status
    // line yet — just pins the button's own position relative to Save
    // Unnamed, the ordering the status line is inserted between.
    const saveUnnamed = screen.getByTestId('typing-test-toggle-save-unnamed')
    const position = button.compareDocumentPosition(saveUnnamed)
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('TypingTestPaneSettingsPanel — Weak Spot Training status line', () => {
  function renderPanel(typingTest: ReturnType<typeof useTypingTest>) {
    renderWithI18n(
      <TypingTestPaneSettingsPanel
        typingTest={typingTest}
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
  }

  it('renders nothing while the gate is unavailable (History still loading)', () => {
    renderPanel(fakeTypingTest())
    expect(screen.queryByTestId('weak-spot-status')).not.toBeInTheDocument()
  })

  it('renders nothing for a mode without weak-spot fields (not applicable)', () => {
    const typingTest = {
      ...fakeTypingTest(),
      config: { mode: 'quote' as const, quoteLength: 'medium' as const },
      weakSpotGate: { applicable: false, status: 'active' as const },
    } as unknown as ReturnType<typeof useTypingTest>
    renderPanel(typingTest)
    expect(screen.queryByTestId('weak-spot-status')).not.toBeInTheDocument()
  })

  it('shows the no-weak-spots wording below the button', () => {
    const typingTest = {
      ...fakeTypingTest(),
      weakSpotGate: { applicable: true, status: 'no-weak-spots' as const },
    } as unknown as ReturnType<typeof useTypingTest>
    renderPanel(typingTest)
    expect(screen.getByTestId('weak-spot-status').textContent).toBe('No weak spots detected — nice!')
  })

  it('shows the active status with detected token count and list, positioned below the button', () => {
    const typingTest = {
      ...fakeTypingTest(),
      weakSpotGate: { applicable: true, status: 'active' as const, topWeakTokens: ['k', 'r'], weakTokenCount: 2 },
    } as unknown as ReturnType<typeof useTypingTest>
    renderPanel(typingTest)
    const button = screen.getByTestId('weak-spot-settings-toggle')
    const status = screen.getByTestId('weak-spot-status')
    expect(status.textContent).toContain('2')
    expect(status.textContent).toContain('k, r')
    const position = button.compareDocumentPosition(status)
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('appends the i18n "+N" overflow suffix once weakTokenCount exceeds the shown tokens', () => {
    const typingTest = {
      ...fakeTypingTest(),
      weakSpotGate: { applicable: true, status: 'active' as const, topWeakTokens: ['k', 'r', 'sha'], weakTokenCount: 5 },
    } as unknown as ReturnType<typeof useTypingTest>
    renderPanel(typingTest)
    expect(screen.getByTestId('weak-spot-status').textContent).toContain('k, r, sha +2')
  })
})
