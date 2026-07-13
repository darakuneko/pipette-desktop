// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { RomajiSettingsModal } from '../RomajiSettingsModal'
import type { TypingTestConfig } from '../types'

const BASE_CONFIG: TypingTestConfig & { mode: 'words' } = {
  mode: 'words',
  wordCount: 30,
  punctuation: false,
  numbers: false,
}

function renderModal(props: Partial<Parameters<typeof RomajiSettingsModal>[0]> = {}) {
  const defaults = {
    config: BASE_CONFIG,
    onConfigChange: vi.fn(),
    linkedFontSize: 24,
    onClose: vi.fn(),
  }
  const merged = { ...defaults, ...props }
  render(
    <I18nextProvider i18n={i18n}>
      <RomajiSettingsModal {...merged} />
    </I18nextProvider>,
  )
  return merged
}

describe('RomajiSettingsModal defaults', () => {
  it('shows the master enable off when romajiInput is not set', () => {
    renderModal()
    expect(screen.getByTestId('romaji-settings-enabled')).toHaveAttribute('aria-checked', 'false')
  })

  it('shows the master enable on when romajiInput is true', () => {
    renderModal({ config: { ...BASE_CONFIG, romajiInput: true } })
    expect(screen.getByTestId('romaji-settings-enabled')).toHaveAttribute('aria-checked', 'true')
  })

  it('defaults the case selector to lower', () => {
    renderModal()
    expect(screen.getByTestId('romaji-case-lower').className).toContain('text-accent')
    expect(screen.getByTestId('romaji-case-upper').className).not.toContain('text-accent')
  })

  it('defaults the guide Base selector to Hepburn, with every Option off', () => {
    renderModal()
    expect(screen.getByTestId('romaji-guide-base-hepburn')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('romaji-guide-base-kunrei')).toHaveAttribute('aria-pressed', 'false')
    for (const style of ['cq', 'digraph', 'xSmall', 'lSmall']) {
      expect(screen.getByTestId(`romaji-guide-${style}`)).toHaveAttribute('aria-pressed', 'false')
    }
  })

  it('defaults every input pattern to enabled (pressed), both bases and every option', () => {
    renderModal()
    for (const style of ['hepburn', 'kunrei']) {
      expect(screen.getByTestId(`romaji-base-${style}`)).toHaveAttribute('aria-pressed', 'true')
    }
    for (const style of ['cq', 'digraph', 'xSmall', 'lSmall']) {
      expect(screen.getByTestId(`romaji-input-${style}`)).toHaveAttribute('aria-pressed', 'true')
    }
  })

  it('defaults the font size to linked, showing the Settings value in a disabled select', () => {
    renderModal({ linkedFontSize: 24 })
    expect(screen.getByTestId('romaji-font-linked')).toHaveAttribute('aria-checked', 'true')
    const select = screen.getByTestId('romaji-settings-font-size') as HTMLSelectElement
    expect(select).toBeDisabled()
    expect(select.value).toBe('24')
  })
})

describe('RomajiSettingsModal edits', () => {
  it('toggles the master enable', () => {
    const onConfigChange = vi.fn()
    renderModal({ onConfigChange })
    fireEvent.click(screen.getByTestId('romaji-settings-enabled'))
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    expect(arg.mode).toBe('words')
    if (arg.mode === 'words') expect(arg.romajiInput).toBe(true)
  })

  it('sets caseStyle when a non-default case is picked, and omits it when lower is re-picked', () => {
    const onConfigChange = vi.fn()
    renderModal({ config: { ...BASE_CONFIG, romaji: { caseStyle: 'upper' } }, onConfigChange })
    fireEvent.click(screen.getByTestId('romaji-case-lower'))
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    // 'lower' is the default, so the field is omitted entirely rather than
    // persisted as an explicit 'lower' value.
    if (arg.mode === 'words') expect(arg.romaji).toBeUndefined()
  })

  it('sets caseStyle to capital on click', () => {
    const onConfigChange = vi.fn()
    renderModal({ onConfigChange })
    fireEvent.click(screen.getByTestId('romaji-case-capital'))
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    if (arg.mode === 'words') expect(arg.romaji).toEqual({ caseStyle: 'capital' })
  })

  it('enables the font-size select once romaji.fontSize is set, seeded with that value', () => {
    renderModal({ config: { ...BASE_CONFIG, romaji: { fontSize: 32 } } })
    const select = screen.getByTestId('romaji-settings-font-size') as HTMLSelectElement
    expect(select).not.toBeDisabled()
    expect(select.value).toBe('32')
  })

  it('turning off the linked switch sets fontSize to the linked Settings Font value', () => {
    const onConfigChange = vi.fn()
    renderModal({ onConfigChange, linkedFontSize: 32 })
    fireEvent.click(screen.getByTestId('romaji-font-linked'))
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    if (arg.mode === 'words') expect(arg.romaji).toEqual({ fontSize: 32 })
  })

  it('sets an explicit fontSize once unlinked and a value picked', () => {
    const onConfigChange = vi.fn()
    renderModal({ config: { ...BASE_CONFIG, romaji: { fontSize: 24 } }, onConfigChange })
    fireEvent.change(screen.getByTestId('romaji-settings-font-size'), { target: { value: '30' } })
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    if (arg.mode === 'words') expect(arg.romaji).toEqual({ fontSize: 30 })
  })

  it('re-linking the font drops fontSize from the config', () => {
    const onConfigChange = vi.fn()
    renderModal({ config: { ...BASE_CONFIG, romaji: { fontSize: 30 } }, onConfigChange })
    fireEvent.click(screen.getByTestId('romaji-font-linked'))
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    if (arg.mode === 'words') expect(arg.romaji).toBeUndefined()
  })

  it('selecting Kunrei as the guide Base adds kunrei to guideStyles', () => {
    const onConfigChange = vi.fn()
    renderModal({ onConfigChange })
    fireEvent.click(screen.getByTestId('romaji-guide-base-kunrei'))
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    if (arg.mode === 'words') expect(arg.romaji).toEqual({ guideStyles: ['kunrei'] })
  })

  it('toggling a guide Option on adds to the existing guideStyles selection', () => {
    const onConfigChange = vi.fn()
    renderModal({ config: { ...BASE_CONFIG, romaji: { guideStyles: ['kunrei'] } }, onConfigChange })
    fireEvent.click(screen.getByTestId('romaji-guide-xSmall'))
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    if (arg.mode === 'words') expect(arg.romaji).toEqual({ guideStyles: ['kunrei', 'xSmall'] })
  })

  it('toggling an already-selected guide Option back off removes it from guideStyles', () => {
    const onConfigChange = vi.fn()
    renderModal({ config: { ...BASE_CONFIG, romaji: { guideStyles: ['kunrei', 'xSmall'] } }, onConfigChange })
    fireEvent.click(screen.getByTestId('romaji-guide-xSmall'))
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    if (arg.mode === 'words') expect(arg.romaji).toEqual({ guideStyles: ['kunrei'] })
  })

  it('selecting Hepburn as the guide Base removes kunrei from guideStyles', () => {
    const onConfigChange = vi.fn()
    renderModal({ config: { ...BASE_CONFIG, romaji: { guideStyles: ['kunrei', 'xSmall'] } }, onConfigChange })
    fireEvent.click(screen.getByTestId('romaji-guide-base-hepburn'))
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    if (arg.mode === 'words') expect(arg.romaji).toEqual({ guideStyles: ['xSmall'] })
  })

  it('omits guideStyles when Hepburn is re-selected and it was the only selected style', () => {
    const onConfigChange = vi.fn()
    renderModal({ config: { ...BASE_CONFIG, romaji: { guideStyles: ['kunrei'] } }, onConfigChange })
    fireEvent.click(screen.getByTestId('romaji-guide-base-hepburn'))
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    if (arg.mode === 'words') expect(arg.romaji).toBeUndefined()
  })

  it('marks Kunrei active and Hepburn inactive as the guide Base once guideStyles carries kunrei', () => {
    renderModal({ config: { ...BASE_CONFIG, romaji: { guideStyles: ['kunrei'] } } })
    expect(screen.getByTestId('romaji-guide-base-kunrei')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('romaji-guide-base-hepburn')).toHaveAttribute('aria-pressed', 'false')
  })

  it('disables an input style on click', () => {
    const onConfigChange = vi.fn()
    renderModal({ onConfigChange })
    fireEvent.click(screen.getByTestId('romaji-input-cq'))
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    if (arg.mode === 'words') expect(arg.romaji).toEqual({ disabledStyles: ['cq'] })
  })

  it('re-enabling the only disabled style prunes disabledStyles back to unset', () => {
    const onConfigChange = vi.fn()
    renderModal({ config: { ...BASE_CONFIG, romaji: { disabledStyles: ['cq'] } }, onConfigChange })
    fireEvent.click(screen.getByTestId('romaji-input-cq'))
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    // Re-enabling the only disabled style empties the array, which is
    // pruned back to "field unset" rather than persisted as [].
    if (arg.mode === 'words') expect(arg.romaji).toBeUndefined()
  })

  it('clicking an enabled base while both are on keeps only that base (kunrei alone is one click)', () => {
    const onConfigChange = vi.fn()
    renderModal({ onConfigChange })
    fireEvent.click(screen.getByTestId('romaji-base-kunrei'))
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    if (arg.mode === 'words') expect(arg.romaji).toEqual({ disabledStyles: ['hepburn'] })
  })

  it('clicking hepburn while both are on keeps hepburn alone', () => {
    const onConfigChange = vi.fn()
    renderModal({ onConfigChange })
    fireEvent.click(screen.getByTestId('romaji-base-hepburn'))
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    if (arg.mode === 'words') expect(arg.romaji).toEqual({ disabledStyles: ['kunrei'] })
  })

  it('clicking a disabled base joins it back in (both bases on)', () => {
    const onConfigChange = vi.fn()
    renderModal({ config: { ...BASE_CONFIG, romaji: { disabledStyles: ['hepburn'] } }, onConfigChange })
    fireEvent.click(screen.getByTestId('romaji-base-hepburn'))
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    // Re-enabling the only disabled style empties the array, which prunes
    // the romaji block back to unset.
    if (arg.mode === 'words') expect(arg.romaji).toBeUndefined()
  })

  it('clicking the sole enabled base is a no-op and the button never renders disabled', () => {
    const onConfigChange = vi.fn()
    renderModal({ config: { ...BASE_CONFIG, romaji: { disabledStyles: ['kunrei'] } }, onConfigChange })
    const hepburnButton = screen.getByTestId('romaji-base-hepburn')
    expect(hepburnButton).not.toBeDisabled()
    fireEvent.click(hepburnButton)
    expect(onConfigChange).not.toHaveBeenCalled()
  })

  it('closes on backdrop click', () => {
    const onClose = vi.fn()
    renderModal({ onClose })
    fireEvent.click(screen.getByTestId('romaji-settings-modal'))
    expect(onClose).toHaveBeenCalled()
  })

  it('closes on the close button', () => {
    const onClose = vi.fn()
    renderModal({ onClose })
    fireEvent.click(screen.getByTestId('romaji-settings-modal-close'))
    expect(onClose).toHaveBeenCalled()
  })
})
