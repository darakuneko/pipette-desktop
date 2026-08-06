// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { WeakSpotSettingsModal } from '../WeakSpotSettingsModal'
import type { TypingTestConfig } from '../types'
import { MAX_TYPING_TEST_RESULTS } from '../types'
import type { WeakSpotGateInfo } from '../weak-spot-profile'

const WORDS_CONFIG: TypingTestConfig = { mode: 'words', wordCount: 30, punctuation: false, numbers: false }
const UNAVAILABLE_GATE: WeakSpotGateInfo = { applicable: true, status: 'unavailable' }
const ACTIVE_GATE: WeakSpotGateInfo = { applicable: true, status: 'active', topWeakTokens: ['k', 'r'], weakTokenCount: 2 }

function renderModal(props: Partial<Parameters<typeof WeakSpotSettingsModal>[0]> = {}) {
  const defaults = {
    config: WORDS_CONFIG,
    onConfigChange: vi.fn(),
    weakSpotGate: UNAVAILABLE_GATE,
    onClose: vi.fn(),
  }
  const merged = { ...defaults, ...props }
  render(
    <I18nextProvider i18n={i18n}>
      <WeakSpotSettingsModal {...merged} />
    </I18nextProvider>,
  )
  return merged
}

describe('WeakSpotSettingsModal — enable toggle', () => {
  it('disables turning ON while the gate is not active', () => {
    renderModal({ weakSpotGate: { applicable: true, status: 'no-weak-spots' } })
    expect(screen.getByTestId('weak-spot-enable-toggle')).toBeDisabled()
  })

  it('enables turning ON once the gate is active', () => {
    renderModal({ weakSpotGate: ACTIVE_GATE })
    expect(screen.getByTestId('weak-spot-enable-toggle')).not.toBeDisabled()
  })

  it('clicking the toggle while active turns weakSpotTrainingMode on', () => {
    const onConfigChange = vi.fn()
    renderModal({ weakSpotGate: ACTIVE_GATE, onConfigChange })
    fireEvent.click(screen.getByTestId('weak-spot-enable-toggle'))
    expect(onConfigChange).toHaveBeenCalledTimes(1)
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    if (arg.mode === 'words') expect(arg.weakSpotTrainingMode).toBe(true)
  })

  it('OFF is always reachable even while the gate is inactive (codex-flagged trap)', () => {
    // A config already ON (from an earlier active scope) must stay
    // turn-off-able even after a parameter change drops the gate back
    // out of 'active' — never strand the toggle stuck ON.
    const config: TypingTestConfig = { ...WORDS_CONFIG, weakSpotTrainingMode: true }
    const onConfigChange = vi.fn()
    renderModal({ config, weakSpotGate: { applicable: true, status: 'no-weak-spots' }, onConfigChange })
    const toggle = screen.getByTestId('weak-spot-enable-toggle')
    expect(toggle).not.toBeDisabled()
    fireEvent.click(toggle)
    expect(onConfigChange).toHaveBeenCalledTimes(1)
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    if (arg.mode === 'words') expect(arg.weakSpotTrainingMode).toBe(false)
  })

  it('is always disabled for a mode without weakSpotTrainingMode at all (e.g. quote)', () => {
    const quoteConfig: TypingTestConfig = { mode: 'quote', quoteLength: 'medium' }
    renderModal({ config: quoteConfig, weakSpotGate: ACTIVE_GATE })
    expect(screen.getByTestId('weak-spot-enable-toggle')).toBeDisabled()
    expect(screen.getByTestId('weak-spot-not-applicable-note')).toBeInTheDocument()
  })

  it('hides every tunable parameter control (and the reset button) for a non-applicable mode', () => {
    const quoteConfig: TypingTestConfig = { mode: 'quote', quoteLength: 'medium' }
    renderModal({ config: quoteConfig })
    expect(screen.queryByTestId('weak-spot-miss-threshold-2')).not.toBeInTheDocument()
    expect(screen.queryByTestId('weak-spot-miss-window-50')).not.toBeInTheDocument()
    expect(screen.queryByTestId('weak-spot-bias-ratio-60')).not.toBeInTheDocument()
    expect(screen.queryByTestId('weak-spot-settings-reset')).not.toBeInTheDocument()
  })
})

describe('WeakSpotSettingsModal — description interpolation', () => {
  it('interpolates the DEFAULT values into the description text when no weakSpot detail is set', () => {
    renderModal()
    expect(screen.getByText(/missed it 2\+ times/)).toBeInTheDocument()
    expect(screen.getByText(/15\+ timed samples/)).toBeInTheDocument()
    expect(screen.getByText(/1\.5× slower/)).toBeInTheDocument()
    expect(screen.getByText(/2× your pace/)).toBeInTheDocument()
    expect(screen.getByText(/20%\+/)).toBeInTheDocument()
  })

  it('interpolates the CURRENTLY configured (non-default) values, never stale literals', () => {
    const config: TypingTestConfig = {
      ...WORDS_CONFIG,
      weakSpot: { missThreshold: 5, minTimingSamples: 30, slownessRatio: 2.1, stallMultiple: 3.5, stallRate: 0.35 },
    }
    renderModal({ config })
    expect(screen.getByText(/missed it 5\+ times/)).toBeInTheDocument()
    expect(screen.getByText(/30\+ timed samples/)).toBeInTheDocument()
    expect(screen.getByText(/2\.1× slower/)).toBeInTheDocument()
    expect(screen.getByText(/3\.5× your pace/)).toBeInTheDocument()
    expect(screen.getByText(/35%\+/)).toBeInTheDocument()
  })

  it('shows the windowed wording by default, and the unbounded wording once missWindow is set to \'all\'', () => {
    renderModal()
    expect(screen.getByText(/50 most recent/)).toBeInTheDocument()

    const config: TypingTestConfig = { ...WORDS_CONFIG, weakSpot: { missWindow: 'all' } }
    renderModal({ config })
    expect(screen.getByText(/entire matching history/)).toBeInTheDocument()
  })

  it('shows no decay sentence by default (decay off), and shows one once a half-life is set', () => {
    renderModal()
    expect(screen.queryByText(/halves every/)).not.toBeInTheDocument()

    const config: TypingTestConfig = { ...WORDS_CONFIG, weakSpot: { decayHalfLifeDays: 14 } }
    renderModal({ config })
    expect(screen.getByText(/halves every 14 days/)).toBeInTheDocument()
  })

  it('interpolates the current bias ratio percentage', () => {
    renderModal()
    expect(screen.getByText(/About 60%/)).toBeInTheDocument()

    const config: TypingTestConfig = { ...WORDS_CONFIG, weakSpot: { biasRatio: 0.8 } }
    renderModal({ config })
    expect(screen.getByText(/About 80%/)).toBeInTheDocument()
  })

  it('shows the History retention cap with the real result limit, independent of window/decay settings', () => {
    renderModal()
    expect(screen.getByTestId('weak-spot-history-retention-note').textContent).toContain(String(MAX_TYPING_TEST_RESULTS))
  })
})

describe('WeakSpotSettingsModal — parameters', () => {
  it('clicking a miss threshold button writes the field, pruning nothing else', () => {
    const onConfigChange = vi.fn()
    const config: TypingTestConfig = { ...WORDS_CONFIG, weakSpot: { missWindow: 25 } }
    renderModal({ config, onConfigChange })
    fireEvent.click(screen.getByTestId('weak-spot-miss-threshold-5'))
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    if (arg.mode === 'words') {
      expect(arg.weakSpot).toEqual({ missThreshold: 5, missWindow: 25 })
    }
  })

  it('clicking the miss threshold DEFAULT button prunes the field out entirely', () => {
    const onConfigChange = vi.fn()
    const config: TypingTestConfig = { ...WORDS_CONFIG, weakSpot: { missThreshold: 5 } }
    renderModal({ config, onConfigChange })
    fireEvent.click(screen.getByTestId('weak-spot-miss-threshold-2'))
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    if (arg.mode === 'words') expect(arg.weakSpot).toBeUndefined()
  })

  it('highlights the currently selected miss threshold button with accent styling, and no other', () => {
    const config: TypingTestConfig = { ...WORDS_CONFIG, weakSpot: { missThreshold: 5 } }
    renderModal({ config })
    expect(screen.getByTestId('weak-spot-miss-threshold-5').className).toContain('border-accent')
    expect(screen.getByTestId('weak-spot-miss-threshold-2').className).not.toContain('border-accent')
  })

  it('flips aria-pressed to the newly selected button and back off the previously selected one', () => {
    const config: TypingTestConfig = { ...WORDS_CONFIG, weakSpot: { missThreshold: 5 } }
    renderModal({ config })
    expect(screen.getByTestId('weak-spot-miss-threshold-5')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('weak-spot-miss-threshold-2')).toHaveAttribute('aria-pressed', 'false')
  })

  it('clicking the already-selected option button is a no-op (fires no onConfigChange)', () => {
    const onConfigChange = vi.fn()
    const config: TypingTestConfig = { ...WORDS_CONFIG, weakSpot: { missThreshold: 5 } }
    renderModal({ config, onConfigChange })
    fireEvent.click(screen.getByTestId('weak-spot-miss-threshold-5'))
    expect(onConfigChange).not.toHaveBeenCalled()
  })

  it('clicking the DEFAULT button when the field is already absent (implicit default) is also a no-op', () => {
    const onConfigChange = vi.fn()
    renderModal({ onConfigChange }) // WORDS_CONFIG carries no weakSpot at all
    fireEvent.click(screen.getByTestId('weak-spot-miss-threshold-2')) // 2 is the default
    expect(onConfigChange).not.toHaveBeenCalled()
  })

  it('changing the rolling-window button updates config.weakSpot.missWindow', () => {
    const onConfigChange = vi.fn()
    renderModal({ onConfigChange })
    fireEvent.click(screen.getByTestId('weak-spot-miss-window-100'))
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    if (arg.mode === 'words') expect(arg.weakSpot).toEqual({ missWindow: 100 })
  })

  it('changing the decay half-life button updates config.weakSpot.decayHalfLifeDays', () => {
    const onConfigChange = vi.fn()
    renderModal({ onConfigChange })
    fireEvent.click(screen.getByTestId('weak-spot-decay-7'))
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    if (arg.mode === 'words') expect(arg.weakSpot).toEqual({ decayHalfLifeDays: 7 })
  })

  it('clicking a bias ratio button commits the fraction, not the displayed percent', () => {
    const onConfigChange = vi.fn()
    renderModal({ onConfigChange })
    fireEvent.click(screen.getByTestId('weak-spot-bias-ratio-80'))
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    if (arg.mode === 'words') expect(arg.weakSpot).toEqual({ biasRatio: 0.8 })
  })

  it('highlights the currently selected bias ratio button with accent styling', () => {
    const config: TypingTestConfig = { ...WORDS_CONFIG, weakSpot: { biasRatio: 0.8 } }
    renderModal({ config })
    expect(screen.getByTestId('weak-spot-bias-ratio-80').className).toContain('border-accent')
    expect(screen.getByTestId('weak-spot-bias-ratio-60').className).not.toContain('border-accent')
  })

  it('the reset button drops the whole weakSpot object', () => {
    const onConfigChange = vi.fn()
    const config: TypingTestConfig = {
      ...WORDS_CONFIG, weakSpot: { missThreshold: 5, missWindow: 100, biasRatio: 0.9 },
    }
    renderModal({ config, onConfigChange })
    fireEvent.click(screen.getByTestId('weak-spot-settings-reset'))
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    if (arg.mode === 'words') expect(arg.weakSpot).toBeUndefined()
  })

  it('the reset button is a no-op (fires no onConfigChange) when already at defaults', () => {
    const onConfigChange = vi.fn()
    renderModal({ onConfigChange }) // WORDS_CONFIG carries no weakSpot at all
    fireEvent.click(screen.getByTestId('weak-spot-settings-reset'))
    expect(onConfigChange).not.toHaveBeenCalled()
  })
})

describe('WeakSpotSettingsModal — dialog shell', () => {
  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn()
    renderModal({ onClose })
    fireEvent.click(screen.getByTestId('weak-spot-settings-modal-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('marks itself as an aria-modal dialog labelled by its own title', () => {
    renderModal()
    const dialog = screen.getByTestId('weak-spot-settings-modal')
    expect(dialog).toHaveAttribute('role', 'dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAttribute('aria-labelledby', 'weak-spot-settings-title')
  })

  it('groups each field-spec button row under role="group" labelled by its own field label', () => {
    renderModal()
    const group = screen.getByTestId('weak-spot-miss-threshold-2').closest('[role="group"]')
    expect(group).not.toBeNull()
    const labelledBy = group?.getAttribute('aria-labelledby')
    expect(labelledBy).toBe('weak-spot-miss-threshold-label')
    expect(document.getElementById(labelledBy ?? '')?.textContent).toBe('Miss threshold (times)')
  })

  it('renders the description before the enable toggle row (description first, then on/off)', () => {
    renderModal({ weakSpotGate: ACTIVE_GATE })
    const description = screen.getByText(/missed it 2\+ times/)
    const toggleRow = screen.getByTestId('weak-spot-enable-toggle-row')
    // DOCUMENT_POSITION_FOLLOWING on the toggle row means the description
    // node comes earlier in the document — i.e. description, then toggle.
    const position = description.compareDocumentPosition(toggleRow)
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
