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
        onCancel={vi.fn()}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('uses the medium modal width (w-modal-md) so the two footer buttons fit on one line at Japanese string lengths', () => {
    render(
      <KeymapApplyConfirmModal
        open
        labelName="Colemak"
        onApply={vi.fn()}
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
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByTestId('keymap-apply-confirm-modal')).toBeTruthy()
    expect(screen.getByText('keyLabels.keymapApply.title:Colemak')).toBeTruthy()
  })

  it('shows the save-recommendation notice as plain body text (no warning-box styling)', () => {
    render(
      <KeymapApplyConfirmModal
        open
        labelName="Colemak"
        onApply={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    const note = screen.getByTestId('keymap-apply-confirm-save-recommendation')
    expect(note).toHaveTextContent('keyLabels.keymapApply.saveRecommendation')
    expect(note.className).not.toMatch(/warning/)
  })

  it('Apply button fires onApply', () => {
    const onApply = vi.fn()
    render(
      <KeymapApplyConfirmModal
        open
        labelName="Colemak"
        onApply={onApply}
        onCancel={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('keymap-apply-confirm-apply'))
    expect(onApply).toHaveBeenCalledTimes(1)
  })

  // Display Only is gone (Plan-qwerty-select-no-rewrite v7) — simulated
  // viewing is the tabs' job now, not a modal button, so the modal is a
  // plain Cancel / Rewrite choice.
  it('has no Display Only button', () => {
    render(
      <KeymapApplyConfirmModal
        open
        labelName="Colemak"
        onApply={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('keymap-apply-confirm-display-only')).toBeNull()
  })

  it('Cancel button fires onCancel', () => {
    const onCancel = vi.fn()
    render(
      <KeymapApplyConfirmModal
        open
        labelName="Colemak"
        onApply={vi.fn()}
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
        onCancel={onCancel}
      />,
    )
    fireEvent.click(screen.getByTestId('keymap-apply-confirm-close'))
    fireEvent.click(screen.getByTestId('keymap-apply-confirm-backdrop'))
    expect(onCancel).toHaveBeenCalledTimes(2)
  })

  // `busy` (fed from `useKeymapApplyPrompt`'s `isApplying`) disables both
  // footer buttons while a Confirm apply is in flight — the visible half of
  // the double-click guard (the hook itself is the actual guard, since
  // Escape/backdrop route around `disabled` entirely).
  describe('busy (apply in flight)', () => {
    it('disables both footer buttons when busy', () => {
      render(
        <KeymapApplyConfirmModal
          open
          labelName="Colemak"
          onApply={vi.fn()}
          onCancel={vi.fn()}
          busy
        />,
      )
      expect(screen.getByTestId('keymap-apply-confirm-cancel')).toBeDisabled()
      expect(screen.getByTestId('keymap-apply-confirm-apply')).toBeDisabled()
    })

    it('leaves both footer buttons enabled when not busy (default)', () => {
      render(
        <KeymapApplyConfirmModal
          open
          labelName="Colemak"
          onApply={vi.fn()}
          onCancel={vi.fn()}
        />,
      )
      expect(screen.getByTestId('keymap-apply-confirm-cancel')).not.toBeDisabled()
      expect(screen.getByTestId('keymap-apply-confirm-apply')).not.toBeDisabled()
    })

    it('a disabled Apply button does not fire onApply when clicked', () => {
      const onApply = vi.fn()
      render(
        <KeymapApplyConfirmModal
          open
          labelName="Colemak"
          onApply={onApply}
          onCancel={vi.fn()}
          busy
        />,
      )
      fireEvent.click(screen.getByTestId('keymap-apply-confirm-apply'))
      expect(onApply).not.toHaveBeenCalled()
    })
  })
})
