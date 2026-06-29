// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { ResultNameModal } from '../ResultNameModal'

function renderModal(props: Partial<Parameters<typeof ResultNameModal>[0]> = {}) {
  const defaults = {
    initialName: '',
    chips: ['WPM:139', 'KPM:196'],
    onSave: vi.fn(),
    onClose: vi.fn(),
  }
  const merged = { ...defaults, ...props }
  render(
    <I18nextProvider i18n={i18n}>
      <ResultNameModal {...merged} />
    </I18nextProvider>,
  )
  return merged
}

describe('ResultNameModal', () => {
  it('shows the Unnamed placeholder and seeds the input with the initial name', () => {
    renderModal({ initialName: 'Existing name' })
    const input = screen.getByTestId('result-name-modal-input') as HTMLInputElement
    expect(input.placeholder).toBe('Unnamed')
    expect(input.value).toBe('Existing name')
  })

  it('inserts a chip as-is at the start of an empty input', () => {
    renderModal({ chips: ['WPM:139', 'KPM:196'] })
    const input = screen.getByTestId('result-name-modal-input') as HTMLInputElement
    input.setSelectionRange(0, 0)
    fireEvent.click(screen.getByTestId('result-name-chip-0'))
    expect(input.value).toBe('WPM:139')
  })

  it('prefixes "_" when inserting a chip after existing text', () => {
    renderModal({ initialName: 'XXXX', chips: ['WPM:139'] })
    const input = screen.getByTestId('result-name-modal-input') as HTMLInputElement
    input.setSelectionRange(4, 4)
    fireEvent.click(screen.getByTestId('result-name-chip-0'))
    expect(input.value).toBe('XXXX_WPM:139')
  })

  it('does not double the "_" when the preceding char is already "_"', () => {
    renderModal({ initialName: 'XXXX_', chips: ['WPM:139'] })
    const input = screen.getByTestId('result-name-modal-input') as HTMLInputElement
    input.setSelectionRange(5, 5)
    fireEvent.click(screen.getByTestId('result-name-chip-0'))
    expect(input.value).toBe('XXXX_WPM:139')
  })

  it('saves the trimmed value', () => {
    const onSave = vi.fn()
    renderModal({ onSave })
    const input = screen.getByTestId('result-name-modal-input')
    fireEvent.change(input, { target: { value: '  My run  ' } })
    fireEvent.click(screen.getByTestId('result-name-modal-save'))
    expect(onSave).toHaveBeenCalledWith('My run')
  })

  it('commits on Enter', () => {
    const onSave = vi.fn()
    renderModal({ onSave })
    const input = screen.getByTestId('result-name-modal-input')
    fireEvent.change(input, { target: { value: 'Run A' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSave).toHaveBeenCalledWith('Run A')
  })

  it('closes without saving on Cancel', () => {
    const onSave = vi.fn()
    const onClose = vi.fn()
    renderModal({ onSave, onClose })
    fireEvent.click(screen.getByText(i18n.t('common.cancel')))
    expect(onSave).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('closes on the X button', () => {
    const onClose = vi.fn()
    renderModal({ onClose })
    fireEvent.click(screen.getByTestId('result-name-modal-close'))
    expect(onClose).toHaveBeenCalled()
  })

  it('closes on Escape pressed in the input', () => {
    const onSave = vi.fn()
    const onClose = vi.fn()
    renderModal({ onSave, onClose })
    fireEvent.keyDown(screen.getByTestId('result-name-modal-input'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
  })
})
