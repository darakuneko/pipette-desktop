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

describe('RomajiSettingsModal — unified 3-way input method selector', () => {
  it('defaults to Romaji when romajiInput/inputMethod are both unset', () => {
    renderModal()
    expect(screen.getByTestId('japanese-input-method-romaji').className).toContain('text-accent')
    expect(screen.getByTestId('japanese-input-method-direct').className).not.toContain('text-accent')
    expect(screen.getByTestId('japanese-input-method-kana').className).not.toContain('text-accent')
  })

  it('resolves legacy romajiInput: true (no inputMethod) to Romaji', () => {
    renderModal({ config: { ...BASE_CONFIG, romajiInput: true } })
    expect(screen.getByTestId('japanese-input-method-romaji').className).toContain('text-accent')
  })

  it('resolves legacy romajiInput: false to Direct', () => {
    renderModal({ config: { ...BASE_CONFIG, romajiInput: false } })
    expect(screen.getByTestId('japanese-input-method-direct').className).toContain('text-accent')
  })

  it('resolves romajiInput: false to Direct regardless of a stale inputMethod', () => {
    // A leftover inputMethod: 'kana' from before this 3-way selector existed
    // must not resurface as "Kana selected" while the master flag is off —
    // the incoherent state this selector replaces must stay unrepresentable.
    renderModal({ config: { ...BASE_CONFIG, romajiInput: false, romaji: { inputMethod: 'kana' } } })
    expect(screen.getByTestId('japanese-input-method-direct').className).toContain('text-accent')
    expect(screen.getByTestId('japanese-input-method-kana').className).not.toContain('text-accent')
  })

  it('resolves inputMethod: kana (with romajiInput on) to Kana', () => {
    renderModal({ config: { ...BASE_CONFIG, romaji: { inputMethod: 'kana' } } })
    expect(screen.getByTestId('japanese-input-method-kana').className).toContain('text-accent')
  })

  it('selecting Direct writes romajiInput: false and prunes inputMethod', () => {
    const onConfigChange = vi.fn()
    renderModal({ config: { ...BASE_CONFIG, romaji: { inputMethod: 'kana' } }, onConfigChange })
    fireEvent.click(screen.getByTestId('japanese-input-method-direct'))
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    expect(arg.mode).toBe('words')
    if (arg.mode === 'words') {
      expect(arg.romajiInput).toBe(false)
      expect(arg.romaji).toBeUndefined()
    }
  })

  it('selecting Romaji from Direct writes romajiInput: true with no inputMethod', () => {
    const onConfigChange = vi.fn()
    renderModal({ config: { ...BASE_CONFIG, romajiInput: false }, onConfigChange })
    fireEvent.click(screen.getByTestId('japanese-input-method-romaji'))
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    if (arg.mode === 'words') {
      expect(arg.romajiInput).toBe(true)
      expect(arg.romaji).toBeUndefined()
    }
  })

  it('selecting Kana writes romajiInput: true with inputMethod: kana', () => {
    const onConfigChange = vi.fn()
    renderModal({ onConfigChange })
    fireEvent.click(screen.getByTestId('japanese-input-method-kana'))
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    if (arg.mode === 'words') {
      expect(arg.romajiInput).toBe(true)
      expect(arg.romaji).toEqual({ inputMethod: 'kana' })
    }
  })

  it('selecting Kana preserves existing romaji detail fields alongside inputMethod', () => {
    const onConfigChange = vi.fn()
    renderModal({ config: { ...BASE_CONFIG, romaji: { lineEndEnter: false } }, onConfigChange })
    fireEvent.click(screen.getByTestId('japanese-input-method-kana'))
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    if (arg.mode === 'words') expect(arg.romaji).toEqual({ lineEndEnter: false, inputMethod: 'kana' })
  })

  it('Direct hides Line-end Enter, Lines shown, and every romaji-only section', () => {
    renderModal({ config: { ...BASE_CONFIG, romajiInput: false } })
    expect(screen.queryByTestId('romaji-line-end-enter')).toBeNull()
    expect(screen.queryByTestId('romaji-guide-lines-1')).toBeNull()
    expect(screen.queryByTestId('romaji-case-lower')).toBeNull()
    expect(screen.queryByTestId('romaji-guide-base-hepburn')).toBeNull()
    expect(screen.queryByTestId('romaji-base-hepburn')).toBeNull()
  })

  it('Kana shows Line-end Enter and Lines shown, but hides romaji-only sections', () => {
    renderModal({ config: { ...BASE_CONFIG, romaji: { inputMethod: 'kana' } } })
    expect(screen.getByTestId('romaji-line-end-enter')).toBeInTheDocument()
    expect(screen.getByTestId('romaji-guide-lines-1')).toBeInTheDocument()
    expect(screen.queryByTestId('romaji-case-lower')).toBeNull()
    expect(screen.queryByTestId('romaji-guide-base-hepburn')).toBeNull()
    expect(screen.queryByTestId('romaji-base-hepburn')).toBeNull()
  })

  it('Romaji shows every section', () => {
    renderModal()
    expect(screen.getByTestId('romaji-line-end-enter')).toBeInTheDocument()
    expect(screen.getByTestId('romaji-guide-lines-1')).toBeInTheDocument()
    expect(screen.getByTestId('romaji-case-lower')).toBeInTheDocument()
    expect(screen.getByTestId('romaji-guide-base-hepburn')).toBeInTheDocument()
    expect(screen.getByTestId('romaji-base-hepburn')).toBeInTheDocument()
  })
})

describe('RomajiSettingsModal defaults', () => {
  it('defaults the case selector to lower', () => {
    renderModal()
    expect(screen.getByTestId('romaji-case-lower').className).toContain('text-accent')
    expect(screen.getByTestId('romaji-case-upper').className).not.toContain('text-accent')
  })

  it('defaults the guide line count selector to 1', () => {
    renderModal()
    expect(screen.getByTestId('romaji-guide-lines-1').className).toContain('text-accent')
    for (const n of [0, 2, 3]) {
      expect(screen.getByTestId(`romaji-guide-lines-${n}`).className).not.toContain('text-accent')
    }
  })

  it('highlights the persisted guideLineCount instead of the default', () => {
    renderModal({ config: { ...BASE_CONFIG, romaji: { guideLineCount: 0 } } })
    expect(screen.getByTestId('romaji-guide-lines-0').className).toContain('text-accent')
    expect(screen.getByTestId('romaji-guide-lines-1').className).not.toContain('text-accent')
  })

  it('shows the line-end Enter toggle on by default when lineEndEnter is not set', () => {
    renderModal()
    expect(screen.getByTestId('romaji-line-end-enter')).toHaveAttribute('aria-checked', 'true')
  })

  it('shows the line-end Enter toggle on when lineEndEnter is explicitly true', () => {
    renderModal({ config: { ...BASE_CONFIG, romaji: { lineEndEnter: true } } })
    expect(screen.getByTestId('romaji-line-end-enter')).toHaveAttribute('aria-checked', 'true')
  })

  it('shows the line-end Enter toggle off when lineEndEnter is explicitly false', () => {
    renderModal({ config: { ...BASE_CONFIG, romaji: { lineEndEnter: false } } })
    expect(screen.getByTestId('romaji-line-end-enter')).toHaveAttribute('aria-checked', 'false')
  })

  it('defaults the guide Base selector to Hepburn, with every Option off', () => {
    renderModal()
    expect(screen.getByTestId('romaji-guide-base-hepburn')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('romaji-guide-base-kunrei')).toHaveAttribute('aria-pressed', 'false')
    for (const style of ['c', 'q', 'digraph', 'xSmall', 'lSmall', 'w', 'v', 'f', 'ye', 'xn', 'nApos']) {
      expect(screen.getByTestId(`romaji-guide-${style}`)).toHaveAttribute('aria-pressed', 'false')
    }
  })

  it('defaults every input pattern to enabled (pressed), both bases and every option', () => {
    renderModal()
    for (const style of ['hepburn', 'kunrei']) {
      expect(screen.getByTestId(`romaji-base-${style}`)).toHaveAttribute('aria-pressed', 'true')
    }
    for (const style of ['c', 'q', 'digraph', 'xSmall', 'lSmall', 'w', 'v', 'f', 'ye', 'xn', 'nApos']) {
      expect(screen.getByTestId(`romaji-input-${style}`)).toHaveAttribute('aria-pressed', 'true')
    }
  })

  // Base and Options share the same grid-cols-4 container so every button
  // (Base's 2 and Options' 11) lands in an identically wide column, instead
  // of sizing to its own label's content width.
  it('lays out the Base and Options rows on the same 4-column grid, for both Guide and Accepted input patterns', () => {
    renderModal()
    // Options buttons sit inside a Tooltip wrapper div, so the grid
    // container is an ancestor rather than the immediate parent — closest()
    // finds it either way.
    for (const testid of ['romaji-guide-base-hepburn', 'romaji-guide-c', 'romaji-base-hepburn', 'romaji-input-c']) {
      const container = screen.getByTestId(testid).closest('.grid-cols-4')
      expect(container).not.toBeNull()
    }
  })
})

describe('RomajiSettingsModal edits', () => {
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

  it('setting guideLineCount to 0 persists it explicitly', () => {
    const onConfigChange = vi.fn()
    renderModal({ onConfigChange })
    fireEvent.click(screen.getByTestId('romaji-guide-lines-0'))
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    if (arg.mode === 'words') expect(arg.romaji).toEqual({ guideLineCount: 0 })
  })

  it('setting guideLineCount to 3 persists it explicitly', () => {
    const onConfigChange = vi.fn()
    renderModal({ onConfigChange })
    fireEvent.click(screen.getByTestId('romaji-guide-lines-3'))
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    if (arg.mode === 'words') expect(arg.romaji).toEqual({ guideLineCount: 3 })
  })

  it('re-selecting the default guideLineCount of 1 prunes the field back to unset', () => {
    const onConfigChange = vi.fn()
    renderModal({ config: { ...BASE_CONFIG, romaji: { guideLineCount: 0 } }, onConfigChange })
    fireEvent.click(screen.getByTestId('romaji-guide-lines-1'))
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    if (arg.mode === 'words') expect(arg.romaji).toBeUndefined()
  })

  it('toggles the line-end Enter setting off from the default-on state (writes an explicit false)', () => {
    const onConfigChange = vi.fn()
    renderModal({ onConfigChange })
    fireEvent.click(screen.getByTestId('romaji-line-end-enter'))
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    if (arg.mode === 'words') expect(arg.romaji).toEqual({ lineEndEnter: false })
  })

  it('toggling line-end Enter back on from an explicit false prunes the field back to unset', () => {
    const onConfigChange = vi.fn()
    renderModal({ config: { ...BASE_CONFIG, romaji: { lineEndEnter: false } }, onConfigChange })
    fireEvent.click(screen.getByTestId('romaji-line-end-enter'))
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    if (arg.mode === 'words') expect(arg.romaji).toBeUndefined()
  })

  it('toggling line-end Enter off preserves an existing romaji field alongside it', () => {
    const onConfigChange = vi.fn()
    renderModal({ config: { ...BASE_CONFIG, romaji: { caseStyle: 'capital' } }, onConfigChange })
    fireEvent.click(screen.getByTestId('romaji-line-end-enter'))
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    if (arg.mode === 'words') expect(arg.romaji).toEqual({ caseStyle: 'capital', lineEndEnter: false })
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
    fireEvent.click(screen.getByTestId('romaji-input-c'))
    const arg = onConfigChange.mock.calls[0][0] as TypingTestConfig
    if (arg.mode === 'words') expect(arg.romaji).toEqual({ disabledStyles: ['c'] })
  })

  it('re-enabling the only disabled style prunes disabledStyles back to unset', () => {
    const onConfigChange = vi.fn()
    renderModal({ config: { ...BASE_CONFIG, romaji: { disabledStyles: ['c'] } }, onConfigChange })
    fireEvent.click(screen.getByTestId('romaji-input-c'))
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
