// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { LayoutStoreModal, LayoutStoreContent, type FileStatus } from '../LayoutStoreModal'
import type { SnapshotMeta } from '../../../../shared/types/snapshot-store'
import type { HubMyPost } from '../../../../shared/types/hub'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

const MOCK_ENTRIES: SnapshotMeta[] = [
  {
    id: 'entry-1',
    label: 'First Layout',
    filename: 'KB_2026-01-01.pipette',
    savedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'entry-2',
    label: '',
    filename: 'KB_2026-01-02.pipette',
    savedAt: '2026-01-02T12:30:00.000Z',
  },
]

const DEFAULT_PROPS = {
  onSave: vi.fn(),
  onLoad: vi.fn(),
  onRename: vi.fn(),
  onDelete: vi.fn(),
  onClose: vi.fn(),
  keyboardName: 'TestKeyboard',
}

describe('LayoutStoreModal', () => {
  it('shows empty state when no entries', () => {
    render(
      <LayoutStoreModal
        entries={[]}
        {...DEFAULT_PROPS}
      />,
    )

    expect(screen.getByTestId('layout-store-empty')).toBeInTheDocument()
  })

  it('renders entries with labels and dates', () => {
    render(
      <LayoutStoreModal
        entries={MOCK_ENTRIES}
        {...DEFAULT_PROPS}
      />,
    )

    const items = screen.getAllByTestId('layout-store-entry')
    expect(items).toHaveLength(2)

    const labels = screen.getAllByTestId('layout-store-entry-label')
    expect(labels[0].textContent).toBe('First Layout')
    // Entry with empty label shows noLabel key
    expect(labels[1].textContent).toBe('layoutStore.noLabel')
  })

  it('calls onLoad when load button clicked', () => {
    const onLoad = vi.fn()
    render(
      <LayoutStoreModal
        entries={MOCK_ENTRIES}
        {...DEFAULT_PROPS}
        onLoad={onLoad}
      />,
    )

    const loadButtons = screen.getAllByTestId('layout-store-load-btn')
    fireEvent.click(loadButtons[0])

    expect(onLoad).toHaveBeenCalledWith('entry-1')
  })

  it('enters rename mode and submits on Enter', () => {
    const onRename = vi.fn()
    render(
      <LayoutStoreModal
        entries={MOCK_ENTRIES}
        {...DEFAULT_PROPS}
        onRename={onRename}
      />,
    )

    // Click label for first entry to enter rename mode
    const labels = screen.getAllByTestId('layout-store-entry-label')
    fireEvent.click(labels[0])

    const input = screen.getByTestId('layout-store-rename-input')
    expect(input).toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'New Name' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onRename).toHaveBeenCalledWith('entry-1', 'New Name')
  })

  it('cancels rename on Escape', () => {
    const onRename = vi.fn()
    render(
      <LayoutStoreModal
        entries={MOCK_ENTRIES}
        {...DEFAULT_PROPS}
        onRename={onRename}
      />,
    )

    const labels = screen.getAllByTestId('layout-store-entry-label')
    fireEvent.click(labels[0])

    const input = screen.getByTestId('layout-store-rename-input')
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(onRename).not.toHaveBeenCalled()
    expect(screen.queryByTestId('layout-store-rename-input')).not.toBeInTheDocument()
  })

  it('commits rename on blur (clicking outside)', () => {
    const onRename = vi.fn()
    render(
      <LayoutStoreModal
        entries={MOCK_ENTRIES}
        {...DEFAULT_PROPS}
        onRename={onRename}
      />,
    )

    const labels = screen.getAllByTestId('layout-store-entry-label')
    fireEvent.click(labels[0])

    const input = screen.getByTestId('layout-store-rename-input')
    fireEvent.change(input, { target: { value: 'Changed Name' } })
    fireEvent.blur(input)

    expect(onRename).toHaveBeenCalledWith('entry-1', 'Changed Name')
    expect(screen.queryByTestId('layout-store-rename-input')).not.toBeInTheDocument()
  })

  describe('confirm flash', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('shows confirm flash on card after Enter rename', () => {
      vi.useFakeTimers()
      const onRename = vi.fn()
      render(
        <LayoutStoreModal
          entries={MOCK_ENTRIES}
          {...DEFAULT_PROPS}
          onRename={onRename}
        />,
      )

      const labels = screen.getAllByTestId('layout-store-entry-label')
      fireEvent.click(labels[0])

      const input = screen.getByTestId('layout-store-rename-input')
      fireEvent.change(input, { target: { value: 'New Name' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      // Flash is deferred via setTimeout(0) so the class is added after the label mounts
      act(() => { vi.advanceTimersByTime(0) })

      // Card should have confirm flash animation
      const cards = screen.getAllByTestId('layout-store-entry')
      expect(cards[0].className).toContain('confirm-flash')

      // After 1200ms, animation class should be removed
      act(() => { vi.advanceTimersByTime(1200) })
      expect(cards[0].className).not.toContain('confirm-flash')

      vi.useRealTimers()
    })

    it('does not flash when Enter is pressed without changes', () => {
      const onRename = vi.fn()
      render(
        <LayoutStoreModal
          entries={MOCK_ENTRIES}
          {...DEFAULT_PROPS}
          onRename={onRename}
        />,
      )

      const labels = screen.getAllByTestId('layout-store-entry-label')
      fireEvent.click(labels[0])

      const input = screen.getByTestId('layout-store-rename-input')
      // Press Enter without changing the value
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(onRename).not.toHaveBeenCalled()
      const cards = screen.getAllByTestId('layout-store-entry')
      expect(cards[0].className).not.toContain('confirm-flash')
    })
  })

  it('shows delete confirmation and calls onDelete', () => {
    const onDelete = vi.fn()
    render(
      <LayoutStoreModal
        entries={MOCK_ENTRIES}
        {...DEFAULT_PROPS}
        onDelete={onDelete}
      />,
    )

    // Click delete
    const deleteButtons = screen.getAllByTestId('layout-store-delete-btn')
    fireEvent.click(deleteButtons[0])

    // Confirm
    const confirmBtn = screen.getByTestId('layout-store-delete-confirm')
    fireEvent.click(confirmBtn)

    expect(onDelete).toHaveBeenCalledWith('entry-1')
  })

  it('cancels delete confirmation', () => {
    const onDelete = vi.fn()
    render(
      <LayoutStoreModal
        entries={MOCK_ENTRIES}
        {...DEFAULT_PROPS}
        onDelete={onDelete}
      />,
    )

    // Click delete
    const deleteButtons = screen.getAllByTestId('layout-store-delete-btn')
    fireEvent.click(deleteButtons[0])

    // Cancel
    const cancelBtn = screen.getByTestId('layout-store-delete-cancel')
    fireEvent.click(cancelBtn)

    expect(onDelete).not.toHaveBeenCalled()
    expect(screen.queryByTestId('layout-store-delete-confirm')).not.toBeInTheDocument()
  })

  it('calls onClose when close button clicked', () => {
    const onClose = vi.fn()
    render(
      <LayoutStoreModal
        entries={MOCK_ENTRIES}
        {...DEFAULT_PROPS}
        onClose={onClose}
      />,
    )

    fireEvent.click(screen.getByTestId('layout-store-modal-close'))

    expect(onClose).toHaveBeenCalledOnce()
  })

  it('calls onClose when backdrop clicked', () => {
    const onClose = vi.fn()
    render(
      <LayoutStoreModal
        entries={MOCK_ENTRIES}
        {...DEFAULT_PROPS}
        onClose={onClose}
      />,
    )

    fireEvent.click(screen.getByTestId('layout-store-modal-backdrop'))

    expect(onClose).toHaveBeenCalledOnce()
  })

  it('does not close modal on Escape key', () => {
    const onClose = vi.fn()
    render(
      <LayoutStoreModal
        entries={MOCK_ENTRIES}
        {...DEFAULT_PROPS}
        onClose={onClose}
      />,
    )

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows loading state', () => {
    render(
      <LayoutStoreModal
        entries={[]}
        loading
        {...DEFAULT_PROPS}
      />,
    )

    expect(screen.queryByTestId('layout-store-empty')).not.toBeInTheDocument()
    expect(screen.getByText('common.loading')).toBeInTheDocument()
  })

  // Save form tests
  it('renders save form with input and button', () => {
    render(
      <LayoutStoreModal
        entries={[]}
        {...DEFAULT_PROPS}
      />,
    )

    expect(screen.getByTestId('layout-store-save-input')).toBeInTheDocument()
    expect(screen.getByTestId('layout-store-save-submit')).toBeInTheDocument()
  })

  it('calls onSave with trimmed label on form submit', () => {
    const onSave = vi.fn()
    render(
      <LayoutStoreModal
        entries={[]}
        {...DEFAULT_PROPS}
        onSave={onSave}
      />,
    )

    const input = screen.getByTestId('layout-store-save-input')
    fireEvent.change(input, { target: { value: '  My Layout  ' } })
    fireEvent.submit(input.closest('form')!)

    expect(onSave).toHaveBeenCalledWith('My Layout')
  })

  it('disables save button when label is empty', () => {
    const onSave = vi.fn()
    render(
      <LayoutStoreModal
        entries={[]}
        {...DEFAULT_PROPS}
        onSave={onSave}
      />,
    )

    const btn = screen.getByTestId('layout-store-save-submit')
    expect(btn).toBeDisabled()
    fireEvent.click(btn)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('disables save button when saving', () => {
    render(
      <LayoutStoreModal
        entries={[]}
        saving
        {...DEFAULT_PROPS}
      />,
    )

    expect(screen.getByTestId('layout-store-save-submit')).toBeDisabled()
  })

  it('clears input after save submit', () => {
    render(
      <LayoutStoreModal
        entries={[]}
        {...DEFAULT_PROPS}
      />,
    )

    const input = screen.getByTestId('layout-store-save-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Test Label' } })
    fireEvent.submit(input.closest('form')!)

    expect(input.value).toBe('')
  })

  it('shows overwrite confirmation when saving with existing label', () => {
    const onSave = vi.fn()
    const onDelete = vi.fn()
    render(
      <LayoutStoreModal
        entries={MOCK_ENTRIES}
        {...DEFAULT_PROPS}
        onSave={onSave}
        onDelete={onDelete}
      />,
    )

    const input = screen.getByTestId('layout-store-save-input')
    fireEvent.change(input, { target: { value: 'First Layout' } })
    fireEvent.submit(input.closest('form')!)

    // Should show confirmation, not save yet
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByTestId('layout-store-overwrite-confirm')).toBeInTheDocument()
    expect(screen.getByTestId('layout-store-overwrite-cancel')).toBeInTheDocument()
  })

  it('overwrites on confirm: deletes old and saves new', () => {
    const onSave = vi.fn()
    const onDelete = vi.fn()
    render(
      <LayoutStoreModal
        entries={MOCK_ENTRIES}
        {...DEFAULT_PROPS}
        onSave={onSave}
        onDelete={onDelete}
      />,
    )

    const input = screen.getByTestId('layout-store-save-input')
    fireEvent.change(input, { target: { value: 'First Layout' } })
    fireEvent.submit(input.closest('form')!)

    // Confirm overwrite
    fireEvent.click(screen.getByTestId('layout-store-overwrite-confirm'))

    expect(onDelete).toHaveBeenCalledWith('entry-1')
    expect(onSave).toHaveBeenCalledWith('First Layout')
  })

  it('cancels overwrite confirmation', () => {
    const onSave = vi.fn()
    render(
      <LayoutStoreModal
        entries={MOCK_ENTRIES}
        {...DEFAULT_PROPS}
        onSave={onSave}
      />,
    )

    const input = screen.getByTestId('layout-store-save-input')
    fireEvent.change(input, { target: { value: 'First Layout' } })
    fireEvent.submit(input.closest('form')!)

    // Cancel
    fireEvent.click(screen.getByTestId('layout-store-overwrite-cancel'))

    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByTestId('layout-store-save-submit')).toBeInTheDocument()
  })

  it('initializes save input from defaultSaveLabel', () => {
    render(
      <LayoutStoreModal
        entries={MOCK_ENTRIES}
        {...DEFAULT_PROPS}
        defaultSaveLabel="My Layout"
      />,
    )

    const input = screen.getByTestId('layout-store-save-input') as HTMLInputElement
    expect(input.value).toBe('My Layout')
  })

  it('does not call onSave when saving is true (Enter key guard)', () => {
    const onSave = vi.fn()
    render(
      <LayoutStoreModal
        entries={[]}
        saving
        {...DEFAULT_PROPS}
        onSave={onSave}
      />,
    )

    const input = screen.getByTestId('layout-store-save-input')
    fireEvent.change(input, { target: { value: 'Test' } })
    fireEvent.submit(input.closest('form')!)

    expect(onSave).not.toHaveBeenCalled()
  })

  it('does not call onRename when Escape is pressed after changing rename text', () => {
    const onRename = vi.fn()
    render(
      <LayoutStoreModal
        entries={MOCK_ENTRIES}
        {...DEFAULT_PROPS}
        onRename={onRename}
      />,
    )

    const labels = screen.getAllByTestId('layout-store-entry-label')
    fireEvent.click(labels[0])

    const input = screen.getByTestId('layout-store-rename-input')
    fireEvent.change(input, { target: { value: 'Changed Name' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(onRename).not.toHaveBeenCalled()
    expect(screen.queryByTestId('layout-store-rename-input')).not.toBeInTheDocument()
  })

  describe('import/sideload section', () => {
    it('renders import and sideload buttons before save form', () => {
      const onImportVil = vi.fn()
      const onSideloadJson = vi.fn()
      render(
        <LayoutStoreModal
          entries={[]}
          {...DEFAULT_PROPS}
          onImportVil={onImportVil}
          onSideloadJson={onSideloadJson}
        />,
      )

      const importSection = screen.getByTestId('layout-store-import-section')
      const saveInput = screen.getByTestId('layout-store-save-input')

      expect(importSection).toBeInTheDocument()
      expect(screen.getByTestId('layout-store-import-vil')).toBeInTheDocument()
      expect(screen.getByTestId('layout-store-sideload-json')).toBeInTheDocument()

      // Import section should appear after save form in DOM (below history)
      const importPos = importSection.compareDocumentPosition(saveInput)
      expect(importPos & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    })

    it('calls onImportVil when import button clicked', () => {
      const onImportVil = vi.fn()
      render(
        <LayoutStoreModal
          entries={[]}
          {...DEFAULT_PROPS}
          onImportVil={onImportVil}
        />,
      )

      fireEvent.click(screen.getByTestId('layout-store-import-vil'))
      expect(onImportVil).toHaveBeenCalledOnce()
    })

    it('calls onSideloadJson when sideload button clicked', () => {
      const onSideloadJson = vi.fn()
      render(
        <LayoutStoreModal
          entries={[]}
          {...DEFAULT_PROPS}
          onSideloadJson={onSideloadJson}
        />,
      )

      fireEvent.click(screen.getByTestId('layout-store-sideload-json'))
      expect(onSideloadJson).toHaveBeenCalledOnce()
    })

    it('disables import/sideload buttons when fileDisabled is true', () => {
      render(
        <LayoutStoreModal
          entries={[]}
          {...DEFAULT_PROPS}
          onImportVil={vi.fn()}
          onSideloadJson={vi.fn()}
          fileDisabled
        />,
      )

      expect(screen.getByTestId('layout-store-import-vil')).toBeDisabled()
      expect(screen.getByTestId('layout-store-sideload-json')).toBeDisabled()
    })

    it('does not render import section when no import/sideload props', () => {
      render(
        <LayoutStoreModal
          entries={[]}
          {...DEFAULT_PROPS}
        />,
      )

      expect(screen.queryByTestId('layout-store-import-section')).not.toBeInTheDocument()
    })
  })

  describe('per-entry export', () => {
    it('renders export buttons on each entry', () => {
      render(
        <LayoutStoreModal
          entries={MOCK_ENTRIES}
          {...DEFAULT_PROPS}
          onExportEntryVil={vi.fn()}
          onExportEntryKeymapC={vi.fn()}
          onExportEntryPdf={vi.fn()}
        />,
      )

      const vilBtns = screen.getAllByTestId('layout-store-entry-export-vil')
      const cBtns = screen.getAllByTestId('layout-store-entry-export-keymap-c')
      const pdfBtns = screen.getAllByTestId('layout-store-entry-export-pdf')

      expect(vilBtns).toHaveLength(2)
      expect(cBtns).toHaveLength(2)
      expect(pdfBtns).toHaveLength(2)
    })

    it('calls onExportEntryVil with entryId when clicked', () => {
      const onExportEntryVil = vi.fn()
      render(
        <LayoutStoreModal
          entries={MOCK_ENTRIES}
          {...DEFAULT_PROPS}
          onExportEntryVil={onExportEntryVil}
        />,
      )

      const btns = screen.getAllByTestId('layout-store-entry-export-vil')
      fireEvent.click(btns[0])
      expect(onExportEntryVil).toHaveBeenCalledWith('entry-1')

      fireEvent.click(btns[1])
      expect(onExportEntryVil).toHaveBeenCalledWith('entry-2')
    })

    it('calls onExportEntryKeymapC with entryId when clicked', () => {
      const onExportEntryKeymapC = vi.fn()
      render(
        <LayoutStoreModal
          entries={MOCK_ENTRIES}
          {...DEFAULT_PROPS}
          onExportEntryKeymapC={onExportEntryKeymapC}
        />,
      )

      const btns = screen.getAllByTestId('layout-store-entry-export-keymap-c')
      fireEvent.click(btns[0])
      expect(onExportEntryKeymapC).toHaveBeenCalledWith('entry-1')
    })

    it('calls onExportEntryPdf with entryId when clicked', () => {
      const onExportEntryPdf = vi.fn()
      render(
        <LayoutStoreModal
          entries={MOCK_ENTRIES}
          {...DEFAULT_PROPS}
          onExportEntryPdf={onExportEntryPdf}
        />,
      )

      const btns = screen.getAllByTestId('layout-store-entry-export-pdf')
      fireEvent.click(btns[0])
      expect(onExportEntryPdf).toHaveBeenCalledWith('entry-1')
    })

    it('disables entry export buttons when fileDisabled is true', () => {
      render(
        <LayoutStoreModal
          entries={MOCK_ENTRIES}
          {...DEFAULT_PROPS}
          onExportEntryVil={vi.fn()}
          onExportEntryKeymapC={vi.fn()}
          onExportEntryPdf={vi.fn()}
          fileDisabled
        />,
      )

      screen.getAllByTestId('layout-store-entry-export-vil').forEach((btn) => {
        expect(btn).toBeDisabled()
      })
      screen.getAllByTestId('layout-store-entry-export-keymap-c').forEach((btn) => {
        expect(btn).toBeDisabled()
      })
      screen.getAllByTestId('layout-store-entry-export-pdf').forEach((btn) => {
        expect(btn).toBeDisabled()
      })
    })

    it('does not render entry export buttons when no export entry props', () => {
      render(
        <LayoutStoreModal
          entries={MOCK_ENTRIES}
          {...DEFAULT_PROPS}
        />,
      )

      expect(screen.queryByTestId('layout-store-entry-export-vil')).not.toBeInTheDocument()
      expect(screen.queryByTestId('layout-store-entry-export-keymap-c')).not.toBeInTheDocument()
      expect(screen.queryByTestId('layout-store-entry-export-pdf')).not.toBeInTheDocument()
    })
  })

  describe('current section', () => {
    it('renders current section with export buttons', () => {
      render(
        <LayoutStoreModal
          entries={[]}
          {...DEFAULT_PROPS}
          onExportVil={vi.fn()}
          onExportKeymapC={vi.fn()}
          onExportPdf={vi.fn()}
        />,
      )

      expect(screen.getByTestId('layout-store-current-section')).toBeInTheDocument()
      expect(screen.getByTestId('layout-store-current-export-vil')).toBeInTheDocument()
      expect(screen.getByTestId('layout-store-current-export-keymap-c')).toBeInTheDocument()
      expect(screen.getByTestId('layout-store-current-export-pdf')).toBeInTheDocument()
    })

    it('calls onExportVil when current .vil button clicked', () => {
      const onExportVil = vi.fn()
      render(
        <LayoutStoreModal
          entries={[]}
          {...DEFAULT_PROPS}
          onExportVil={onExportVil}
        />,
      )

      fireEvent.click(screen.getByTestId('layout-store-current-export-vil'))
      expect(onExportVil).toHaveBeenCalledOnce()
    })

    it('calls onExportKeymapC when current .c button clicked', () => {
      const onExportKeymapC = vi.fn()
      render(
        <LayoutStoreModal
          entries={[]}
          {...DEFAULT_PROPS}
          onExportKeymapC={onExportKeymapC}
        />,
      )

      fireEvent.click(screen.getByTestId('layout-store-current-export-keymap-c'))
      expect(onExportKeymapC).toHaveBeenCalledOnce()
    })

    it('calls onExportPdf when current PDF button clicked', () => {
      const onExportPdf = vi.fn()
      render(
        <LayoutStoreModal
          entries={[]}
          {...DEFAULT_PROPS}
          onExportPdf={onExportPdf}
        />,
      )

      fireEvent.click(screen.getByTestId('layout-store-current-export-pdf'))
      expect(onExportPdf).toHaveBeenCalledOnce()
    })

    it('disables current export buttons when fileDisabled is true', () => {
      render(
        <LayoutStoreModal
          entries={[]}
          {...DEFAULT_PROPS}
          onExportVil={vi.fn()}
          onExportKeymapC={vi.fn()}
          onExportPdf={vi.fn()}
          fileDisabled
        />,
      )

      expect(screen.getByTestId('layout-store-current-export-vil')).toBeDisabled()
      expect(screen.getByTestId('layout-store-current-export-keymap-c')).toBeDisabled()
      expect(screen.getByTestId('layout-store-current-export-pdf')).toBeDisabled()
    })

    it('does not render current section when no export props', () => {
      render(
        <LayoutStoreModal
          entries={[]}
          {...DEFAULT_PROPS}
        />,
      )

      expect(screen.queryByTestId('layout-store-current-section')).not.toBeInTheDocument()
      expect(screen.queryByTestId('layout-store-current-export-vil')).not.toBeInTheDocument()
      expect(screen.queryByTestId('layout-store-current-export-keymap-c')).not.toBeInTheDocument()
      expect(screen.queryByTestId('layout-store-current-export-pdf')).not.toBeInTheDocument()
    })
  })

  describe('file status display', () => {
    function renderWithStatus(fileStatus: FileStatus) {
      return render(
        <LayoutStoreModal
          entries={[]}
          {...DEFAULT_PROPS}
          onImportVil={vi.fn()}
          fileStatus={fileStatus}
        />,
      )
    }

    it('does not show status element when idle', () => {
      renderWithStatus('idle')
      expect(screen.queryByTestId('layout-store-file-status')).not.toBeInTheDocument()
    })

    it('shows importing status with muted text', () => {
      renderWithStatus('importing')
      const el = screen.getByTestId('layout-store-file-status')
      expect(el.textContent).toBe('fileIO.importing')
      expect(el.className).toContain('text-content-muted')
    })

    it('shows exporting status with muted text', () => {
      renderWithStatus('exporting')
      const el = screen.getByTestId('layout-store-file-status')
      expect(el.textContent).toBe('fileIO.exporting')
      expect(el.className).toContain('text-content-muted')
    })

    it('shows success status with accent text', () => {
      renderWithStatus({ kind: 'success', message: 'Done!' })
      const el = screen.getByTestId('layout-store-file-status')
      expect(el.textContent).toBe('Done!')
      expect(el.className).toContain('text-accent')
    })

    it('shows error status with danger text', () => {
      renderWithStatus({ kind: 'error', message: 'Failed' })
      const el = screen.getByTestId('layout-store-file-status')
      expect(el.textContent).toBe('Failed')
      expect(el.className).toContain('text-danger')
    })

    it('does not show status element when fileStatus is undefined', () => {
      render(
        <LayoutStoreModal
          entries={[]}
          {...DEFAULT_PROPS}
        />,
      )
      expect(screen.queryByTestId('layout-store-file-status')).not.toBeInTheDocument()
    })
  })

  describe('Hub actions', () => {
    const HUB_KEYBOARD_POSTS: HubMyPost[] = [
      { id: 'post-42', title: 'First Layout', keyboard_name: 'KB', created_at: '2026-01-01T00:00:00.000Z' },
    ]
    const ENTRIES_WITH_HUB: SnapshotMeta[] = [
      {
        id: 'entry-1',
        label: 'First Layout',
        filename: 'KB_2026-01-01.pipette',
        savedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'entry-2',
        label: '',
        filename: 'KB_2026-01-02.pipette',
        savedAt: '2026-01-02T12:30:00.000Z',
      },
    ]

    it('shows Hub row when hub props are provided', () => {
      render(
        <LayoutStoreModal
          entries={MOCK_ENTRIES}
          {...DEFAULT_PROPS}
          onUploadToHub={vi.fn()}
        />,
      )

      const hubRows = screen.getAllByTestId('layout-store-hub-row')
      expect(hubRows).toHaveLength(2)
      expect(hubRows[0].textContent).toContain('hub.pipetteHub')
    })

    it('does not show Hub row when no hub props are provided', () => {
      render(
        <LayoutStoreModal
          entries={MOCK_ENTRIES}
          {...DEFAULT_PROPS}
        />,
      )

      expect(screen.queryByTestId('layout-store-hub-row')).not.toBeInTheDocument()
    })

    it('shows Upload button when entry has no hubPostId', () => {
      render(
        <LayoutStoreModal
          entries={MOCK_ENTRIES}
          {...DEFAULT_PROPS}
          onUploadToHub={vi.fn()}
        />,
      )

      const uploadBtns = screen.getAllByTestId('layout-store-upload-hub')
      expect(uploadBtns).toHaveLength(2)
      expect(uploadBtns[0].textContent).toBe('hub.uploadToHub')
    })

    it('calls onUploadToHub with entryId when clicked', () => {
      const onUploadToHub = vi.fn()
      render(
        <LayoutStoreModal
          entries={MOCK_ENTRIES}
          {...DEFAULT_PROPS}
          onUploadToHub={onUploadToHub}
        />,
      )

      const btns = screen.getAllByTestId('layout-store-upload-hub')
      fireEvent.click(btns[0])

      expect(onUploadToHub).toHaveBeenCalledWith('entry-1')
    })

    it('shows Update and Remove buttons when entry has hubPostId', () => {
      render(
        <LayoutStoreModal
          entries={ENTRIES_WITH_HUB}
          {...DEFAULT_PROPS}
          hubKeyboardPosts={HUB_KEYBOARD_POSTS}
          onUploadToHub={vi.fn()}
          onUpdateOnHub={vi.fn()}
          onRemoveFromHub={vi.fn()}
        />,
      )

      // Entry 1 has hubPostId → Update + Remove
      expect(screen.getByTestId('layout-store-update-hub')).toBeInTheDocument()
      expect(screen.getByTestId('layout-store-remove-hub')).toBeInTheDocument()
      // Entry 2 has no hubPostId → Upload
      expect(screen.getByTestId('layout-store-upload-hub')).toBeInTheDocument()
    })

    it('calls onUpdateOnHub with entryId when Update clicked', () => {
      const onUpdateOnHub = vi.fn()
      render(
        <LayoutStoreModal
          entries={ENTRIES_WITH_HUB}
          {...DEFAULT_PROPS}
          hubKeyboardPosts={HUB_KEYBOARD_POSTS}
          onUploadToHub={vi.fn()}
          onUpdateOnHub={onUpdateOnHub}
          onRemoveFromHub={vi.fn()}
        />,
      )

      fireEvent.click(screen.getByTestId('layout-store-update-hub'))
      expect(onUpdateOnHub).toHaveBeenCalledWith('entry-1')
    })

    it('shows inline confirmation for Remove', () => {
      render(
        <LayoutStoreModal
          entries={ENTRIES_WITH_HUB}
          {...DEFAULT_PROPS}
          hubKeyboardPosts={HUB_KEYBOARD_POSTS}
          onUploadToHub={vi.fn()}
          onUpdateOnHub={vi.fn()}
          onRemoveFromHub={vi.fn()}
        />,
      )

      // Click Remove
      fireEvent.click(screen.getByTestId('layout-store-remove-hub'))

      // Should show confirm/cancel
      expect(screen.getByTestId('layout-store-hub-remove-confirm')).toBeInTheDocument()
      expect(screen.getByTestId('layout-store-hub-remove-cancel')).toBeInTheDocument()
      // Update and Remove buttons should be hidden
      expect(screen.queryByTestId('layout-store-update-hub')).not.toBeInTheDocument()
      expect(screen.queryByTestId('layout-store-remove-hub')).not.toBeInTheDocument()
    })

    it('calls onRemoveFromHub when confirmation clicked', () => {
      const onRemoveFromHub = vi.fn()
      render(
        <LayoutStoreModal
          entries={ENTRIES_WITH_HUB}
          {...DEFAULT_PROPS}
          hubKeyboardPosts={HUB_KEYBOARD_POSTS}
          onUploadToHub={vi.fn()}
          onUpdateOnHub={vi.fn()}
          onRemoveFromHub={onRemoveFromHub}
        />,
      )

      fireEvent.click(screen.getByTestId('layout-store-remove-hub'))
      fireEvent.click(screen.getByTestId('layout-store-hub-remove-confirm'))

      expect(onRemoveFromHub).toHaveBeenCalledWith('entry-1')
    })

    it('cancels Remove confirmation', () => {
      const onRemoveFromHub = vi.fn()
      render(
        <LayoutStoreModal
          entries={ENTRIES_WITH_HUB}
          {...DEFAULT_PROPS}
          hubKeyboardPosts={HUB_KEYBOARD_POSTS}
          onUploadToHub={vi.fn()}
          onUpdateOnHub={vi.fn()}
          onRemoveFromHub={onRemoveFromHub}
        />,
      )

      fireEvent.click(screen.getByTestId('layout-store-remove-hub'))
      fireEvent.click(screen.getByTestId('layout-store-hub-remove-cancel'))

      expect(onRemoveFromHub).not.toHaveBeenCalled()
      // Update/Remove buttons should be back
      expect(screen.getByTestId('layout-store-update-hub')).toBeInTheDocument()
      expect(screen.getByTestId('layout-store-remove-hub')).toBeInTheDocument()
    })

    it('shows uploading text and disables buttons during upload', () => {
      render(
        <LayoutStoreModal
          entries={MOCK_ENTRIES}
          {...DEFAULT_PROPS}
          onUploadToHub={vi.fn()}
          hubUploading="entry-1"
        />,
      )

      const btns = screen.getAllByTestId('layout-store-upload-hub')
      expect(btns[0].textContent).toBe('hub.uploading')
      btns.forEach((btn) => {
        expect(btn).toBeDisabled()
      })
    })

    it('shows updating text during hub update', () => {
      render(
        <LayoutStoreModal
          entries={ENTRIES_WITH_HUB}
          {...DEFAULT_PROPS}
          hubKeyboardPosts={HUB_KEYBOARD_POSTS}
          onUploadToHub={vi.fn()}
          onUpdateOnHub={vi.fn()}
          onRemoveFromHub={vi.fn()}
          hubUploading="entry-1"
        />,
      )

      expect(screen.getByTestId('layout-store-update-hub').textContent).toBe('hub.updating')
      expect(screen.getByTestId('layout-store-update-hub')).toBeDisabled()
      expect(screen.getByTestId('layout-store-remove-hub')).toBeDisabled()
    })

    it('disables hub buttons when fileDisabled is true', () => {
      render(
        <LayoutStoreModal
          entries={ENTRIES_WITH_HUB}
          {...DEFAULT_PROPS}
          hubKeyboardPosts={HUB_KEYBOARD_POSTS}
          onUploadToHub={vi.fn()}
          onUpdateOnHub={vi.fn()}
          onRemoveFromHub={vi.fn()}
          fileDisabled
        />,
      )

      expect(screen.getByTestId('layout-store-update-hub')).toBeDisabled()
      expect(screen.getByTestId('layout-store-remove-hub')).toBeDisabled()
      expect(screen.getByTestId('layout-store-upload-hub')).toBeDisabled()
    })

    it('shows hub result below the matching entry hub row', () => {
      render(
        <LayoutStoreModal
          entries={MOCK_ENTRIES}
          {...DEFAULT_PROPS}
          onUploadToHub={vi.fn()}
          hubUploadResult={{ kind: 'error', message: 'Upload failed', entryId: 'entry-1' }}
        />,
      )

      const result = screen.getByTestId('layout-store-hub-result')
      expect(result.textContent).toBe('Upload failed')
      expect(result.className).toContain('text-danger')

      // Result should be inside the first entry's hub row
      const hubRows = screen.getAllByTestId('layout-store-hub-row')
      expect(hubRows[0].contains(result)).toBe(true)
    })

    it('shows success hub result for matching entry', () => {
      render(
        <LayoutStoreModal
          entries={MOCK_ENTRIES}
          {...DEFAULT_PROPS}
          onUploadToHub={vi.fn()}
          hubUploadResult={{ kind: 'success', message: 'Uploaded!', entryId: 'entry-2' }}
        />,
      )

      const result = screen.getByTestId('layout-store-hub-result')
      expect(result.textContent).toBe('Uploaded!')
      expect(result.className).toContain('text-accent')

      // Result should be inside the second entry's hub row
      const hubRows = screen.getAllByTestId('layout-store-hub-row')
      expect(hubRows[1].contains(result)).toBe(true)
    })

    it('does not show hub result when no hub props', () => {
      render(
        <LayoutStoreModal
          entries={MOCK_ENTRIES}
          {...DEFAULT_PROPS}
          hubUploadResult={{ kind: 'error', message: 'Upload failed', entryId: 'entry-1' }}
        />,
      )

      expect(screen.queryByTestId('layout-store-hub-result')).not.toBeInTheDocument()
    })

    it('shows share link for entry with hubPostId when hubOrigin is set', () => {
      render(
        <LayoutStoreModal
          entries={ENTRIES_WITH_HUB}
          {...DEFAULT_PROPS}
          hubKeyboardPosts={HUB_KEYBOARD_POSTS}
          onUploadToHub={vi.fn()}
          onUpdateOnHub={vi.fn()}
          onRemoveFromHub={vi.fn()}
          hubOrigin="https://example.com"
        />,
      )

      const link = screen.getByTestId('layout-store-hub-share-link')
      expect(link).toBeInTheDocument()
      expect(link.textContent).toBe('hub.openInBrowser')
      expect(link.getAttribute('href')).toBe('https://example.com/post/post-42')
    })

    it('does not show share link when hubOrigin is not set', () => {
      render(
        <LayoutStoreModal
          entries={ENTRIES_WITH_HUB}
          {...DEFAULT_PROPS}
          hubKeyboardPosts={HUB_KEYBOARD_POSTS}
          onUploadToHub={vi.fn()}
          onUpdateOnHub={vi.fn()}
          onRemoveFromHub={vi.fn()}
        />,
      )

      expect(screen.queryByTestId('layout-store-hub-share-link')).not.toBeInTheDocument()
    })

    it('does not show share link for entry without hubPostId', () => {
      render(
        <LayoutStoreModal
          entries={MOCK_ENTRIES}
          {...DEFAULT_PROPS}
          onUploadToHub={vi.fn()}
          hubOrigin="https://example.com"
        />,
      )

      expect(screen.queryByTestId('layout-store-hub-share-link')).not.toBeInTheDocument()
    })

    it('calls openExternal when share link clicked', () => {
      const openExternal = vi.fn().mockResolvedValue(undefined)
      window.vialAPI = { ...window.vialAPI, openExternal }

      render(
        <LayoutStoreModal
          entries={ENTRIES_WITH_HUB}
          {...DEFAULT_PROPS}
          hubKeyboardPosts={HUB_KEYBOARD_POSTS}
          onUploadToHub={vi.fn()}
          onUpdateOnHub={vi.fn()}
          onRemoveFromHub={vi.fn()}
          hubOrigin="https://example.com"
        />,
      )

      fireEvent.click(screen.getByTestId('layout-store-hub-share-link'))
      expect(openExternal).toHaveBeenCalledWith('https://example.com/post/post-42')
    })
  })

  describe('orphaned hub post detection', () => {
    const HUB_MY_POSTS: HubMyPost[] = [
      { id: 'orphan-post-1', title: 'First Layout', keyboard_name: 'TestKeyboard', created_at: '2026-01-01T00:00:00.000Z' },
      { id: 'orphan-post-2', title: 'Other Layout', keyboard_name: 'TestKeyboard', created_at: '2026-01-01T00:00:00.000Z' },
    ]

    const ENTRIES_NO_HUB: SnapshotMeta[] = [
      {
        id: 'entry-1',
        label: 'First Layout',
        filename: 'KB_2026-01-01.pipette',
        savedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'entry-2',
        label: 'No Match Layout',
        filename: 'KB_2026-01-02.pipette',
        savedAt: '2026-01-02T12:30:00.000Z',
      },
    ]

    it('shows Upload? and Delete when orphan match found', () => {
      render(
        <LayoutStoreModal
          entries={ENTRIES_NO_HUB}
          {...DEFAULT_PROPS}
          hubMyPosts={HUB_MY_POSTS}
          onReuploadToHub={vi.fn()}
          onDeleteOrphanedHubPost={vi.fn()}
        />,
      )

      expect(screen.getByTestId('layout-store-reupload-hub')).toBeInTheDocument()
      expect(screen.getByTestId('layout-store-reupload-hub').textContent).toBe('hub.uploadQuestion')
      expect(screen.getByTestId('layout-store-delete-orphan-hub')).toBeInTheDocument()
      expect(screen.getByTestId('layout-store-delete-orphan-hub').textContent).toBe('hub.deleteFromHub')
    })

    it('shows normal Upload when no orphan match', () => {
      render(
        <LayoutStoreModal
          entries={ENTRIES_NO_HUB}
          {...DEFAULT_PROPS}
          hubMyPosts={HUB_MY_POSTS}
          onUploadToHub={vi.fn()}
          onReuploadToHub={vi.fn()}
          onDeleteOrphanedHubPost={vi.fn()}
        />,
      )

      // entry-2 ("No Match Layout") doesn't match any hub post
      expect(screen.getByTestId('layout-store-upload-hub')).toBeInTheDocument()
      expect(screen.getByTestId('layout-store-upload-hub').textContent).toBe('hub.uploadToHub')
    })

    it('calls onReuploadToHub with entryId and orphanedPostId when Upload? clicked', () => {
      const onReuploadToHub = vi.fn()
      render(
        <LayoutStoreModal
          entries={ENTRIES_NO_HUB}
          {...DEFAULT_PROPS}
          hubMyPosts={HUB_MY_POSTS}
          onReuploadToHub={onReuploadToHub}
          onDeleteOrphanedHubPost={vi.fn()}
        />,
      )

      fireEvent.click(screen.getByTestId('layout-store-reupload-hub'))

      expect(onReuploadToHub).toHaveBeenCalledWith('entry-1', 'orphan-post-1')
    })

    it('calls onDeleteOrphanedHubPost with entryId and orphanedPostId when Delete clicked', () => {
      const onDeleteOrphanedHubPost = vi.fn()
      render(
        <LayoutStoreModal
          entries={ENTRIES_NO_HUB}
          {...DEFAULT_PROPS}
          hubMyPosts={HUB_MY_POSTS}
          onReuploadToHub={vi.fn()}
          onDeleteOrphanedHubPost={onDeleteOrphanedHubPost}
        />,
      )

      fireEvent.click(screen.getByTestId('layout-store-delete-orphan-hub'))

      expect(onDeleteOrphanedHubPost).toHaveBeenCalledWith('entry-1', 'orphan-post-1')
    })

    it('does not match orphan post from different keyboard', () => {
      const crossKeyboardPosts: HubMyPost[] = [
        { id: 'other-kb-post', title: 'First Layout', keyboard_name: 'OtherKeyboard', created_at: '2026-01-01T00:00:00.000Z' },
      ]
      render(
        <LayoutStoreModal
          entries={ENTRIES_NO_HUB}
          {...DEFAULT_PROPS}
          hubMyPosts={crossKeyboardPosts}
          onUploadToHub={vi.fn()}
          onReuploadToHub={vi.fn()}
          onDeleteOrphanedHubPost={vi.fn()}
        />,
      )

      // Same title but different keyboard_name — should show Upload, not Upload?/Delete
      expect(screen.queryByTestId('layout-store-reupload-hub')).not.toBeInTheDocument()
      expect(screen.queryByTestId('layout-store-delete-orphan-hub')).not.toBeInTheDocument()
      expect(screen.getAllByTestId('layout-store-upload-hub')).toHaveLength(2)
    })

    it('shows normal Upload when hubMyPosts not provided', () => {
      render(
        <LayoutStoreModal
          entries={ENTRIES_NO_HUB}
          {...DEFAULT_PROPS}
          onUploadToHub={vi.fn()}
        />,
      )

      const uploadBtns = screen.getAllByTestId('layout-store-upload-hub')
      expect(uploadBtns).toHaveLength(2)
    })
  })

  describe('hubNeedsDisplayName hint', () => {
    const HUB_POSTS: HubMyPost[] = [
      { id: 'post-1', title: 'First Layout', keyboard_name: 'KB', created_at: '2026-01-01T00:00:00.000Z' },
    ]

    it('shows hint when hubNeedsDisplayName is true and no upload prop', () => {
      render(
        <LayoutStoreContent
          entries={MOCK_ENTRIES}
          onSave={vi.fn()}
          onLoad={vi.fn()}
          onRename={vi.fn()}
          onDelete={vi.fn()}
          hubNeedsDisplayName
        />,
      )

      const hints = screen.getAllByTestId('layout-store-hub-needs-display-name')
      expect(hints).toHaveLength(2)
      expect(hints[0].textContent).toBe('hub.needsDisplayName')
    })

    it('does not show hint when hubNeedsDisplayName is false', () => {
      render(
        <LayoutStoreContent
          entries={MOCK_ENTRIES}
          onSave={vi.fn()}
          onLoad={vi.fn()}
          onRename={vi.fn()}
          onDelete={vi.fn()}
        />,
      )

      expect(screen.queryByTestId('layout-store-hub-needs-display-name')).not.toBeInTheDocument()
    })

    it('does not show hint when onUploadToHub is provided', () => {
      render(
        <LayoutStoreContent
          entries={MOCK_ENTRIES}
          onSave={vi.fn()}
          onLoad={vi.fn()}
          onRename={vi.fn()}
          onDelete={vi.fn()}
          hubNeedsDisplayName
          onUploadToHub={vi.fn()}
        />,
      )

      expect(screen.queryByTestId('layout-store-hub-needs-display-name')).not.toBeInTheDocument()
    })

    it('shows hint for existing hub post entry when update is blocked', () => {
      render(
        <LayoutStoreContent
          entries={MOCK_ENTRIES}
          onSave={vi.fn()}
          onLoad={vi.fn()}
          onRename={vi.fn()}
          onDelete={vi.fn()}
          hubKeyboardPosts={HUB_POSTS}
          onRemoveFromHub={vi.fn()}
          hubNeedsDisplayName
        />,
      )

      // entry-1 ("First Layout") matches a hub post — hint in entryHubPostId branch
      // entry-2 (empty label) has no hub post — hint in !entryHubPostId branch
      const hints = screen.getAllByTestId('layout-store-hub-needs-display-name')
      expect(hints).toHaveLength(2)
    })

    it('does not show hint for existing hub post entry when onUpdateOnHub is provided', () => {
      render(
        <LayoutStoreContent
          entries={MOCK_ENTRIES}
          onSave={vi.fn()}
          onLoad={vi.fn()}
          onRename={vi.fn()}
          onDelete={vi.fn()}
          hubKeyboardPosts={HUB_POSTS}
          onUpdateOnHub={vi.fn()}
          onRemoveFromHub={vi.fn()}
        />,
      )

      expect(screen.queryByTestId('layout-store-hub-needs-display-name')).not.toBeInTheDocument()
    })
  })

  describe('isDummy mode', () => {
    const CONTENT_PROPS = {
      onSave: vi.fn(),
      onLoad: vi.fn(),
      onRename: vi.fn(),
      onDelete: vi.fn(),
      keyboardName: 'TestKeyboard',
    }

    it('hides save form when isDummy is true', () => {
      render(
        <LayoutStoreContent
          entries={[]}
          isDummy
          {...CONTENT_PROPS}
        />,
      )

      expect(screen.queryByTestId('layout-store-save-input')).not.toBeInTheDocument()
      expect(screen.queryByTestId('layout-store-save-submit')).not.toBeInTheDocument()
    })

    it('hides history section when isDummy is true', () => {
      render(
        <LayoutStoreContent
          entries={MOCK_ENTRIES}
          isDummy
          {...CONTENT_PROPS}
        />,
      )

      expect(screen.queryByTestId('layout-store-list')).not.toBeInTheDocument()
      expect(screen.queryByTestId('layout-store-empty')).not.toBeInTheDocument()
    })

    it('shows import/export sections when isDummy is true', () => {
      render(
        <LayoutStoreContent
          entries={[]}
          isDummy
          {...CONTENT_PROPS}
          onImportVil={vi.fn()}
          onExportVil={vi.fn()}
          onExportKeymapC={vi.fn()}
          onExportPdf={vi.fn()}
        />,
      )

      expect(screen.getByTestId('layout-store-import-section')).toBeInTheDocument()
      expect(screen.getByTestId('layout-store-current-section')).toBeInTheDocument()
    })

    it('hides footer when isDummy is true', () => {
      render(
        <LayoutStoreContent
          entries={[]}
          isDummy
          {...CONTENT_PROPS}
          footer={<div data-testid="test-footer">Footer</div>}
        />,
      )

      expect(screen.queryByTestId('test-footer')).not.toBeInTheDocument()
      // Sanity: footer renders when isDummy is false
      render(
        <LayoutStoreContent
          entries={[]}
          {...CONTENT_PROPS}
          footer={<div data-testid="test-footer-visible">Footer</div>}
        />,
      )
      expect(screen.getByTestId('test-footer-visible')).toBeInTheDocument()
    })

    it('shows save form and history when isDummy is not set', () => {
      render(
        <LayoutStoreContent
          entries={MOCK_ENTRIES}
          {...CONTENT_PROPS}
        />,
      )

      expect(screen.getByTestId('layout-store-save-input')).toBeInTheDocument()
      expect(screen.getByTestId('layout-store-list')).toBeInTheDocument()
    })
  })

  describe('input maxLength attributes', () => {
    it('save input has maxLength=200', () => {
      render(
        <LayoutStoreModal
          entries={[]}
          {...DEFAULT_PROPS}
        />,
      )
      const input = screen.getByTestId('layout-store-save-input')
      expect(input).toHaveAttribute('maxLength', '200')
    })

    it('rename input has maxLength=200', () => {
      render(
        <LayoutStoreModal
          entries={MOCK_ENTRIES}
          {...DEFAULT_PROPS}
        />,
      )
      const labels = screen.getAllByTestId('layout-store-entry-label')
      fireEvent.click(labels[0])
      const input = screen.getByTestId('layout-store-rename-input')
      expect(input).toHaveAttribute('maxLength', '200')
    })
  })

  describe('onOverwriteSave callback', () => {
    it('calls onOverwriteSave instead of onDelete+onSave when provided and overwrite confirmed', () => {
      const onSave = vi.fn()
      const onDelete = vi.fn()
      const onOverwriteSave = vi.fn()
      render(
        <LayoutStoreModal
          entries={MOCK_ENTRIES}
          {...DEFAULT_PROPS}
          onSave={onSave}
          onDelete={onDelete}
          onOverwriteSave={onOverwriteSave}
        />,
      )

      // Type a label that matches an existing entry
      const input = screen.getByTestId('layout-store-save-input')
      fireEvent.change(input, { target: { value: 'First Layout' } })
      fireEvent.submit(input.closest('form')!)

      // Confirm overwrite
      fireEvent.click(screen.getByTestId('layout-store-overwrite-confirm'))

      // onOverwriteSave should be called with the entry id and label
      expect(onOverwriteSave).toHaveBeenCalledWith('entry-1', 'First Layout')
      // onDelete and onSave should NOT be called
      expect(onDelete).not.toHaveBeenCalled()
      expect(onSave).not.toHaveBeenCalled()
    })

    it('falls back to onDelete+onSave when onOverwriteSave is not provided', () => {
      const onSave = vi.fn()
      const onDelete = vi.fn()
      render(
        <LayoutStoreModal
          entries={MOCK_ENTRIES}
          {...DEFAULT_PROPS}
          onSave={onSave}
          onDelete={onDelete}
        />,
      )

      const input = screen.getByTestId('layout-store-save-input')
      fireEvent.change(input, { target: { value: 'First Layout' } })
      fireEvent.submit(input.closest('form')!)

      // Confirm overwrite
      fireEvent.click(screen.getByTestId('layout-store-overwrite-confirm'))

      expect(onDelete).toHaveBeenCalledWith('entry-1')
      expect(onSave).toHaveBeenCalledWith('First Layout')
    })

    it('clears save input and confirmation state after onOverwriteSave', () => {
      const onOverwriteSave = vi.fn()
      render(
        <LayoutStoreModal
          entries={MOCK_ENTRIES}
          {...DEFAULT_PROPS}
          onOverwriteSave={onOverwriteSave}
        />,
      )

      const input = screen.getByTestId('layout-store-save-input') as HTMLInputElement
      fireEvent.change(input, { target: { value: 'First Layout' } })
      fireEvent.submit(input.closest('form')!)
      fireEvent.click(screen.getByTestId('layout-store-overwrite-confirm'))

      // Input should be cleared
      expect(input.value).toBe('')
      // Confirmation state should be reset (save button visible again)
      expect(screen.getByTestId('layout-store-save-submit')).toBeInTheDocument()
      expect(screen.queryByTestId('layout-store-overwrite-confirm')).not.toBeInTheDocument()
    })
  })
})
