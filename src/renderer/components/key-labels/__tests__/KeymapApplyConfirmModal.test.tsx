// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { KeymapApplyConfirmModal } from '../KeymapApplyConfirmModal'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (params && 'name' in params) return `${key}:${String(params.name)}`
      return key
    },
  }),
}))

describe('KeymapApplyConfirmModal', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <KeymapApplyConfirmModal
        open={false}
        labelName="Colemak"
        onApply={vi.fn()}
        onDisplayOnly={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('uses the medium modal width (w-modal-md) so the three footer buttons fit on one line at Japanese string lengths', () => {
    render(
      <KeymapApplyConfirmModal
        open
        labelName="Colemak"
        onApply={vi.fn()}
        onDisplayOnly={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByTestId('keymap-apply-confirm-modal').className).toContain('w-modal-md')
  })

  it('shows the pack name in the title', () => {
    render(
      <KeymapApplyConfirmModal
        open
        labelName="Colemak"
        onApply={vi.fn()}
        onDisplayOnly={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByTestId('keymap-apply-confirm-modal')).toBeTruthy()
    expect(screen.getByText('keyLabels.keymapApply.title:Colemak')).toBeTruthy()
  })

  it('shows the rewrite-consequence note with the pack name (display stays QWERTY)', () => {
    render(
      <KeymapApplyConfirmModal
        open
        labelName="Colemak"
        onApply={vi.fn()}
        onDisplayOnly={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByText('keyLabels.keymapApply.rewriteNote:Colemak')).toBeTruthy()
  })

  it('shows the save-recommendation notice before rewriting', () => {
    render(
      <KeymapApplyConfirmModal
        open
        labelName="Colemak"
        onApply={vi.fn()}
        onDisplayOnly={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByTestId('keymap-apply-confirm-save-recommendation')).toHaveTextContent(
      'keyLabels.keymapApply.saveRecommendation',
    )
  })

  it('Apply button fires onApply', () => {
    const onApply = vi.fn()
    render(
      <KeymapApplyConfirmModal
        open
        labelName="Colemak"
        onApply={onApply}
        onDisplayOnly={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('keymap-apply-confirm-apply'))
    expect(onApply).toHaveBeenCalledTimes(1)
  })

  it('Display Only button fires onDisplayOnly', () => {
    const onDisplayOnly = vi.fn()
    render(
      <KeymapApplyConfirmModal
        open
        labelName="Colemak"
        onApply={vi.fn()}
        onDisplayOnly={onDisplayOnly}
        onCancel={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('keymap-apply-confirm-display-only'))
    expect(onDisplayOnly).toHaveBeenCalledTimes(1)
  })

  it('Cancel button fires onCancel', () => {
    const onCancel = vi.fn()
    render(
      <KeymapApplyConfirmModal
        open
        labelName="Colemak"
        onApply={vi.fn()}
        onDisplayOnly={vi.fn()}
        onCancel={onCancel}
      />,
    )
    fireEvent.click(screen.getByTestId('keymap-apply-confirm-cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('close button and backdrop click both fire onCancel', () => {
    const onCancel = vi.fn()
    render(
      <KeymapApplyConfirmModal
        open
        labelName="Colemak"
        onApply={vi.fn()}
        onDisplayOnly={vi.fn()}
        onCancel={onCancel}
      />,
    )
    fireEvent.click(screen.getByTestId('keymap-apply-confirm-close'))
    fireEvent.click(screen.getByTestId('keymap-apply-confirm-backdrop'))
    expect(onCancel).toHaveBeenCalledTimes(2)
  })
})
