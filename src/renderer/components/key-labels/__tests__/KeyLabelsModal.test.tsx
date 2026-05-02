// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (params && 'name' in params) return `${key}:${String(params.name)}`
      return key
    },
  }),
  // Minimal Trans stub: render the i18nKey verbatim and append the
  // mapped components so tests can still locate links / spans by
  // testid. The real Trans walks the translation string and slots
  // children into matching tags; for tests we don't need the parsing.
  Trans: ({
    i18nKey,
    components,
  }: {
    i18nKey: string
    components?: Record<string, JSX.Element>
  }) => (
    <>
      {i18nKey}
      {components
        ? Object.entries(components).map(([key, node]) => (
            <span key={key}>{node}</span>
          ))
        : null}
    </>
  ),
}))

const refresh = vi.fn().mockResolvedValue(undefined)
const importFromFile = vi.fn()
const exportEntry = vi.fn()
const reorder = vi.fn()
const renameFn = vi.fn()
const remove = vi.fn()
const hubSearch = vi.fn()
const hubDownload = vi.fn()
const hubUpload = vi.fn()
const hubUpdate = vi.fn()
const hubDelete = vi.fn()

let metas: Array<{ id: string; name: string; uploaderName?: string; hubPostId?: string; filename: string; savedAt: string; updatedAt: string }> = []

vi.mock('../../../hooks/useKeyLabels', () => ({
  useKeyLabels: () => ({
    metas,
    loading: false,
    error: null,
    refresh,
    importFromFile,
    exportEntry,
    reorder,
    rename: renameFn,
    remove,
    hubSearch,
    hubDownload,
    hubUpload,
    hubUpdate,
    hubDelete,
  }),
}))

import { KeyLabelsModal } from '../KeyLabelsModal'

function meta(over: Partial<{ id: string; name: string; uploaderName: string; hubPostId: string }> = {}) {
  return {
    id: over.id ?? 'a',
    name: over.name ?? 'A',
    ...(over.uploaderName ? { uploaderName: over.uploaderName } : {}),
    filename: 'a.json',
    savedAt: 'now',
    updatedAt: 'now',
    ...(over.hubPostId ? { hubPostId: over.hubPostId } : {}),
  }
}

describe('KeyLabelsModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    metas = []
    importFromFile.mockResolvedValue({ success: true, data: meta() })
    exportEntry.mockResolvedValue({ success: true, data: { filePath: '/tmp/x.json' } })
    reorder.mockResolvedValue({ success: true })
    renameFn.mockResolvedValue({ success: true, data: meta() })
    remove.mockResolvedValue({ success: true })
    hubSearch.mockResolvedValue({
      success: true,
      data: { items: [], total: 0, page: 1, per_page: 20 },
    })
    hubDownload.mockResolvedValue({ success: true, data: meta({ id: 'd', name: 'Downloaded' }) })
    hubUpload.mockResolvedValue({ success: true, data: meta() })
    hubUpdate.mockResolvedValue({ success: true, data: meta() })
    hubDelete.mockResolvedValue({ success: true })
  })

  it('renders nothing when closed', () => {
    const { container } = render(
      <KeyLabelsModal open={false} onClose={vi.fn()} currentDisplayName="me" hubCanWrite />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('shows qwerty row without actions', () => {
    metas = [meta({ id: 'qwerty', name: 'QWERTY', uploaderName: 'pipette' })]
    render(<KeyLabelsModal open onClose={vi.fn()} currentDisplayName="me" hubCanWrite />)
    expect(screen.getByText('QWERTY')).toBeTruthy()
    // No upload/rename/delete buttons for qwerty
    expect(screen.queryByTestId('key-labels-upload-qwerty')).toBeNull()
    expect(screen.queryByTestId('key-labels-rename-qwerty')).toBeNull()
    expect(screen.queryByTestId('key-labels-delete-qwerty')).toBeNull()
  })

  it('shows Upload + clickable rename name + Delete for own local row without hub post', () => {
    metas = [meta({ id: 'mine', name: 'Mine', uploaderName: 'me' })]
    render(<KeyLabelsModal open onClose={vi.fn()} currentDisplayName="me" hubCanWrite />)
    expect(screen.getByTestId('key-labels-upload-mine')).toBeTruthy()
    // The label name itself is the rename trigger (no separate button).
    expect(screen.getByTestId('key-labels-name-mine')).toBeTruthy()
    expect(screen.getByTestId('key-labels-delete-mine')).toBeTruthy()
    expect(screen.queryByTestId('key-labels-update-mine')).toBeNull()
  })

  it('shows Update + Remove for own local row already on hub', () => {
    metas = [meta({ id: 'synced', name: 'Synced', uploaderName: 'me', hubPostId: 'hub-1' })]
    render(<KeyLabelsModal open onClose={vi.fn()} currentDisplayName="me" hubCanWrite />)
    expect(screen.getByTestId('key-labels-update-synced')).toBeTruthy()
    expect(screen.getByTestId('key-labels-remove-synced')).toBeTruthy()
    expect(screen.queryByTestId('key-labels-upload-synced')).toBeNull()
  })

  it('shows only Delete for downloaded foreign rows', () => {
    metas = [meta({ id: 'dl', name: 'Foreign', uploaderName: 'someone-else', hubPostId: 'hub-2' })]
    render(<KeyLabelsModal open onClose={vi.fn()} currentDisplayName="me" hubCanWrite />)
    expect(screen.getByTestId('key-labels-delete-dl')).toBeTruthy()
    expect(screen.queryByTestId('key-labels-update-dl')).toBeNull()
    expect(screen.queryByTestId('key-labels-remove-dl')).toBeNull()
    expect(screen.queryByTestId('key-labels-upload-dl')).toBeNull()
  })

  it('triggers hub search when Search button clicked', async () => {
    render(<KeyLabelsModal open onClose={vi.fn()} currentDisplayName="me" hubCanWrite />)
    fireEvent.click(screen.getByTestId('key-labels-tab-hub'))
    fireEvent.change(screen.getByTestId('key-labels-search-input'), { target: { value: 'french' } })
    fireEvent.click(screen.getByTestId('key-labels-search-button'))

    await waitFor(() => expect(hubSearch).toHaveBeenCalled())
    expect(hubSearch).toHaveBeenCalledWith({ q: 'french', perPage: 50 })
  })

  it('shows hub-only rows after a search returns items', async () => {
    hubSearch.mockResolvedValueOnce({
      success: true,
      data: {
        items: [
          {
            id: 'hub-99',
            name: 'Brazilian',
            map: {},
            composite_labels: null,
            uploaded_by: null,
            uploader_name: 'someone',
            created_at: '',
            updated_at: '',
          },
        ],
        total: 1,
        page: 1,
        per_page: 50,
      },
    })
    render(<KeyLabelsModal open onClose={vi.fn()} currentDisplayName="me" hubCanWrite />)
    fireEvent.click(screen.getByTestId('key-labels-tab-hub'))
    // Search now requires 2+ characters before the button enables.
    fireEvent.change(screen.getByTestId('key-labels-search-input'), { target: { value: 'br' } })
    fireEvent.click(screen.getByTestId('key-labels-search-button'))
    await waitFor(() => {
      expect(screen.getByTestId('key-labels-download-hub-99')).toBeTruthy()
    })
  })

  it('Delete asks for confirmation before invoking remove', async () => {
    metas = [meta({ id: 'mine', name: 'Mine', uploaderName: 'me' })]
    render(<KeyLabelsModal open onClose={vi.fn()} currentDisplayName="me" hubCanWrite />)
    fireEvent.click(screen.getByTestId('key-labels-delete-mine'))
    const confirm = await screen.findByTestId('key-labels-confirm-delete-mine')
    fireEvent.click(confirm)
    await waitFor(() => expect(remove).toHaveBeenCalledWith('mine'))
  })

  it('Export action triggers exportEntry for the row', async () => {
    metas = [meta({ id: 'mine', name: 'Mine', uploaderName: 'me' })]
    render(<KeyLabelsModal open onClose={vi.fn()} currentDisplayName="me" hubCanWrite />)
    fireEvent.click(screen.getByTestId('key-labels-export-mine'))
    await waitFor(() => expect(exportEntry).toHaveBeenCalledWith('mine'))
  })

  it('Import button triggers importFromFile', async () => {
    render(<KeyLabelsModal open onClose={vi.fn()} currentDisplayName="me" hubCanWrite />)
    fireEvent.click(screen.getByTestId('key-labels-import-button'))
    await waitFor(() => expect(importFromFile).toHaveBeenCalled())
  })

  it('shows duplicate-name error when import fails with DUPLICATE_NAME', async () => {
    importFromFile.mockResolvedValueOnce({
      success: false,
      errorCode: 'DUPLICATE_NAME',
      error: 'KEY_LABEL_DUPLICATE',
    })
    render(<KeyLabelsModal open onClose={vi.fn()} currentDisplayName="me" hubCanWrite />)
    fireEvent.click(screen.getByTestId('key-labels-import-button'))
    await waitFor(() => {
      expect(screen.getByText('keyLabels.errorDuplicate')).toBeTruthy()
    })
  })

  it('disables hub-write actions when hubCanWrite is false', () => {
    metas = [meta({ id: 'mine', name: 'Mine', uploaderName: 'me' })]
    render(<KeyLabelsModal open onClose={vi.fn()} currentDisplayName="me" hubCanWrite={false} />)
    const upload = screen.getByTestId('key-labels-upload-mine') as HTMLButtonElement
    expect(upload.disabled).toBe(true)
  })
})
