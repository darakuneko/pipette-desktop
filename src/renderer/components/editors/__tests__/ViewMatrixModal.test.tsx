// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ViewMatrixModal } from '../ViewMatrixModal'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'editor.viewMatrix.modalTitle': 'Edit View Position',
        'editor.viewMatrix.physicalLabel': 'Matrix',
        'editor.viewMatrix.rowLabel': 'Row',
        'editor.viewMatrix.colLabel': 'Col',
        'common.save': 'Save',
        'common.cancel': 'Cancel',
      }
      return map[key] ?? key
    },
  }),
}))

describe('ViewMatrixModal', () => {
  it('renders the effective row/col values prefilled', () => {
    render(<ViewMatrixModal physRow={1} physCol={2} effectiveRow={5} effectiveCol={7} onSave={vi.fn()} onClose={vi.fn()} />)

    expect(screen.getByTestId('view-matrix-row-input')).toHaveValue(5)
    expect(screen.getByTestId('view-matrix-col-input')).toHaveValue(7)
  })

  it('shows the physical position read-only', () => {
    render(<ViewMatrixModal physRow={1} physCol={2} effectiveRow={5} effectiveCol={7} onSave={vi.fn()} onClose={vi.fn()} />)

    expect(screen.getByTestId('view-matrix-physical-label')).toHaveTextContent('Matrix: 1, 2')
  })

  it('falls back to the physical position when there is no override', () => {
    render(<ViewMatrixModal physRow={3} physCol={4} effectiveRow={3} effectiveCol={4} onSave={vi.fn()} onClose={vi.fn()} />)

    expect(screen.getByTestId('view-matrix-row-input')).toHaveValue(3)
    expect(screen.getByTestId('view-matrix-col-input')).toHaveValue(4)
  })

  it('saves the edited row/col and closes on Save', () => {
    const onSave = vi.fn()
    const onClose = vi.fn()
    render(<ViewMatrixModal physRow={0} physCol={0} effectiveRow={0} effectiveCol={0} onSave={onSave} onClose={onClose} />)

    fireEvent.change(screen.getByTestId('view-matrix-row-input'), { target: { value: '2' } })
    fireEvent.change(screen.getByTestId('view-matrix-col-input'), { target: { value: '3' } })
    fireEvent.click(screen.getByTestId('view-matrix-save-button'))

    expect(onSave).toHaveBeenCalledWith(2, 3)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('discards edits and closes without saving on Cancel', () => {
    const onSave = vi.fn()
    const onClose = vi.fn()
    render(<ViewMatrixModal physRow={0} physCol={0} effectiveRow={0} effectiveCol={0} onSave={onSave} onClose={onClose} />)

    fireEvent.change(screen.getByTestId('view-matrix-row-input'), { target: { value: '9' } })
    fireEvent.click(screen.getByTestId('view-matrix-cancel-button'))

    expect(onSave).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('discards edits and closes without saving on close button', () => {
    const onSave = vi.fn()
    const onClose = vi.fn()
    render(<ViewMatrixModal physRow={0} physCol={0} effectiveRow={0} effectiveCol={0} onSave={onSave} onClose={onClose} />)

    fireEvent.click(screen.getByTestId('view-matrix-modal-close'))

    expect(onSave).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('discards edits and closes without saving on backdrop click', () => {
    const onSave = vi.fn()
    const onClose = vi.fn()
    render(<ViewMatrixModal physRow={0} physCol={0} effectiveRow={0} effectiveCol={0} onSave={onSave} onClose={onClose} />)

    fireEvent.click(screen.getByTestId('view-matrix-modal-backdrop'))

    expect(onSave).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('clamps a cleared/invalid input back to the last valid value instead of NaN', () => {
    const onSave = vi.fn()
    render(<ViewMatrixModal physRow={0} physCol={0} effectiveRow={4} effectiveCol={6} onSave={onSave} onClose={vi.fn()} />)

    fireEvent.change(screen.getByTestId('view-matrix-row-input'), { target: { value: '-1' } })
    fireEvent.click(screen.getByTestId('view-matrix-save-button'))

    // Negative input is rejected — the row stays at its last valid value (4).
    expect(onSave).toHaveBeenCalledWith(4, 6)
  })
})
