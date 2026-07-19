// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

import { PackDeleteActions } from '../PackDeleteActions'

describe('PackDeleteActions', () => {
  it('renders Export and Delete (using the caller-supplied deleteLabel) when not confirming', () => {
    const onExport = vi.fn()
    const onAskDelete = vi.fn()
    render(
      <PackDeleteActions
        id="p1"
        testidPrefix="theme-packs"
        busy={false}
        confirming={false}
        deleteLabel="Custom Delete Label"
        onExport={onExport}
        onAskDelete={onAskDelete}
        onCancelDelete={vi.fn()}
        onConfirmDelete={vi.fn()}
      />,
    )
    expect(screen.getByTestId('theme-packs-export-p1')).toBeTruthy()
    expect(screen.getByTestId('theme-packs-delete-p1').textContent).toBe('Custom Delete Label')
    expect(screen.queryByTestId('theme-packs-confirm-delete-p1')).toBeNull()

    fireEvent.click(screen.getByTestId('theme-packs-export-p1'))
    expect(onExport).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('theme-packs-delete-p1'))
    expect(onAskDelete).toHaveBeenCalled()
  })

  it('renders Confirm/Cancel when confirming, and wires each to its callback', () => {
    const onConfirmDelete = vi.fn()
    const onCancelDelete = vi.fn()
    render(
      <PackDeleteActions
        id="p2"
        testidPrefix="language-packs"
        busy={false}
        confirming
        deleteLabel="Delete"
        onExport={vi.fn()}
        onAskDelete={vi.fn()}
        onCancelDelete={onCancelDelete}
        onConfirmDelete={onConfirmDelete}
      />,
    )
    expect(screen.queryByTestId('language-packs-export-p2')).toBeNull()
    expect(screen.queryByTestId('language-packs-delete-p2')).toBeNull()
    fireEvent.click(screen.getByTestId('language-packs-confirm-delete-p2'))
    expect(onConfirmDelete).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('language-packs-cancel-delete-p2'))
    expect(onCancelDelete).toHaveBeenCalled()
  })

  it('spaces Export and Delete itself instead of relying on the caller\'s wrapper (regression: Key Labels had no gap between them because it wraps the component in a non-flex span)', () => {
    render(
      <PackDeleteActions
        id="p4"
        testidPrefix="key-labels"
        busy={false}
        confirming={false}
        deleteLabel="Delete"
        onExport={vi.fn()}
        onAskDelete={vi.fn()}
        onCancelDelete={vi.fn()}
        onConfirmDelete={vi.fn()}
      />,
    )
    const exportBtn = screen.getByTestId('key-labels-export-p4')
    const deleteBtn = screen.getByTestId('key-labels-delete-p4')
    // Both buttons share one parent (the component's own wrapping span),
    // and that parent — not some ancestor the caller happens to supply —
    // carries the gap.
    expect(exportBtn.parentElement).toBe(deleteBtn.parentElement)
    expect(exportBtn.parentElement?.className).toContain('gap-2')
  })

  it('disables Export/Delete while busy', () => {
    render(
      <PackDeleteActions
        id="p3"
        testidPrefix="theme-packs"
        busy
        confirming={false}
        deleteLabel="Delete"
        onExport={vi.fn()}
        onAskDelete={vi.fn()}
        onCancelDelete={vi.fn()}
        onConfirmDelete={vi.fn()}
      />,
    )
    expect((screen.getByTestId('theme-packs-export-p3') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('theme-packs-delete-p3') as HTMLButtonElement).disabled).toBe(true)
  })
})
