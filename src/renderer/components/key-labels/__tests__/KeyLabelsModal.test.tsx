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
const hubSync = vi.fn()
const hubTimestamps = vi.fn()
const hubDelete = vi.fn()

let metas: Array<{ id: string; name: string; uploaderName?: string; hubPostId?: string; hubUpdatedAt?: string; filename: string; savedAt: string; updatedAt: string }> = []

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
    hubSync,
    hubTimestamps,
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
    hubSync.mockResolvedValue({ success: true, data: meta() })
    hubTimestamps.mockResolvedValue({ success: true, data: { items: [] } })
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

  it('shows Delete + Sync (pull) for downloaded foreign rows', () => {
    metas = [meta({ id: 'dl', name: 'Foreign', uploaderName: 'someone-else', hubPostId: 'hub-2' })]
    render(<KeyLabelsModal open onClose={vi.fn()} currentDisplayName="me" hubCanWrite />)
    expect(screen.getByTestId('key-labels-delete-dl')).toBeTruthy()
    expect(screen.getByTestId('key-labels-sync-dl')).toBeTruthy()
    expect(screen.queryByTestId('key-labels-update-dl')).toBeNull()
    expect(screen.queryByTestId('key-labels-remove-dl')).toBeNull()
    expect(screen.queryByTestId('key-labels-upload-dl')).toBeNull()
  })

  it('Sync button triggers hubSync for downloaded foreign rows', async () => {
    metas = [meta({ id: 'dl', name: 'Foreign', uploaderName: 'someone-else', hubPostId: 'hub-2' })]
    render(<KeyLabelsModal open onClose={vi.fn()} currentDisplayName="me" hubCanWrite />)
    fireEvent.click(screen.getByTestId('key-labels-sync-dl'))
    await waitFor(() => expect(hubSync).toHaveBeenCalledWith('dl'))
  })

  it('does not show Sync on owner rows (Cloud Sync handles owner data)', () => {
    metas = [meta({ id: 'mine', name: 'Mine', uploaderName: 'me', hubPostId: 'hub-3' })]
    render(<KeyLabelsModal open onClose={vi.fn()} currentDisplayName="me" hubCanWrite />)
    expect(screen.queryByTestId('key-labels-sync-mine')).toBeNull()
  })

  it('shows update-available dot when bulk timestamps says Hub is newer', async () => {
    metas = [
      // Local cached value is older than what timestamps will report
      { id: 'dl', name: 'Foreign', uploaderName: 'someone-else', filename: 'd.json', savedAt: 'now', updatedAt: 'now', hubPostId: 'hub-1', hubUpdatedAt: '2026-04-01T00:00:00Z' },
    ]
    hubTimestamps.mockResolvedValueOnce({
      success: true,
      data: { items: [{ id: 'hub-1', updated_at: '2026-05-02T23:29:00Z' }] },
    })
    render(<KeyLabelsModal open onClose={vi.fn()} currentDisplayName="me" hubCanWrite />)
    await waitFor(() => expect(hubTimestamps).toHaveBeenCalledWith(['hub-1']))
    await waitFor(() => {
      expect(screen.queryByTestId('key-labels-update-available-dl')).toBeTruthy()
    })
  })

  it('marks rows as removed when their hubPostId is missing from timestamps response', async () => {
    metas = [
      { id: 'gone', name: 'Gone', uploaderName: 'someone-else', filename: 'g.json', savedAt: 'now', updatedAt: 'now', hubPostId: 'hub-2', hubUpdatedAt: '2026-04-01T00:00:00Z' },
    ]
    // Empty items → server says the post is gone.
    hubTimestamps.mockResolvedValueOnce({ success: true, data: { items: [] } })
    render(<KeyLabelsModal open onClose={vi.fn()} currentDisplayName="me" hubCanWrite />)
    await waitFor(() => expect(hubTimestamps).toHaveBeenCalledWith(['hub-2']))
    await waitFor(() => {
      // The Updated cell shows the localized "(removed)" placeholder.
      expect(screen.getByTestId('key-labels-updated-at-gone').textContent).toBe('keyLabels.hubRemoved')
    })
  })

  it('does not call hubTimestamps when there are no Hub-linked rows', async () => {
    metas = [
      { id: 'qwerty', name: 'QWERTY', filename: 'q.json', savedAt: 'now', updatedAt: 'now' },
      { id: 'localOnly', name: 'Local Only', filename: 'l.json', savedAt: 'now', updatedAt: 'now' },
    ]
    render(<KeyLabelsModal open onClose={vi.fn()} currentDisplayName="me" hubCanWrite />)
    // No `hubPostId` anywhere → effect returns early before calling IPC.
    await new Promise((r) => setTimeout(r, 50))
    expect(hubTimestamps).not.toHaveBeenCalled()
  })

  it('shows hubUpdatedAt for Hub-linked rows and blanks for QWERTY/never-uploaded', () => {
    metas = [
      // QWERTY: never on Hub → blank
      { id: 'qwerty', name: 'QWERTY', filename: 'q.json', savedAt: 'now', updatedAt: '2026-01-01T00:00:00Z' },
      // Local-only entry without hubUpdatedAt → blank
      { id: 'local', name: 'Local', filename: 'l.json', savedAt: 'now', updatedAt: '2026-04-15T11:30:00Z' },
      // Hub-linked entry with hubUpdatedAt → shown
      { id: 'hub', name: 'Hub', filename: 'h.json', savedAt: 'now', updatedAt: '2026-04-15T11:30:00Z', hubPostId: 'post', hubUpdatedAt: '2026-04-15T11:30:00Z' },
    ]
    render(<KeyLabelsModal open onClose={vi.fn()} currentDisplayName="me" hubCanWrite />)
    expect(screen.getByTestId('key-labels-updated-at-qwerty').textContent).toBe('')
    expect(screen.getByTestId('key-labels-updated-at-local').textContent).toBe('')
    // Format is locale-timezone dependent, so just assert non-empty.
    expect(screen.getByTestId('key-labels-updated-at-hub').textContent).not.toBe('')
  })

  it('triggers hub search when Search button clicked', async () => {
    render(<KeyLabelsModal open onClose={vi.fn()} currentDisplayName="me" hubCanWrite />)
    fireEvent.click(screen.getByTestId('key-labels-tab-hub'))
    await waitFor(() => expect(hubSearch).toHaveBeenCalledWith({ q: '', perPage: 50 }))
    hubSearch.mockClear()
    fireEvent.change(screen.getByTestId('key-labels-search-input'), { target: { value: 'french' } })
    fireEvent.click(screen.getByTestId('key-labels-search-button'))
    await waitFor(() => expect(hubSearch).toHaveBeenCalledWith({ q: 'french', perPage: 50 }))
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

  // --- Phase 3: Delete = Hub cascade (aligns Key Labels with Language/Theme Packs) ---

  it('Delete on a hub-linked entry cascades to hubDelete before the local remove', async () => {
    metas = [meta({ id: 'linked', name: 'Linked', uploaderName: 'me', hubPostId: 'hub-1' })]
    render(<KeyLabelsModal open onClose={vi.fn()} currentDisplayName="me" hubCanWrite />)
    fireEvent.click(screen.getByTestId('key-labels-delete-linked'))
    const confirm = await screen.findByTestId('key-labels-confirm-delete-linked')
    fireEvent.click(confirm)
    await waitFor(() => expect(hubDelete).toHaveBeenCalledWith('linked'))
    await waitFor(() => expect(remove).toHaveBeenCalledWith('linked'))
  })

  it('Delete on a local-only entry (no hubPostId) does not call hubDelete', async () => {
    metas = [meta({ id: 'localonly', name: 'Local Only', uploaderName: 'me' })]
    render(<KeyLabelsModal open onClose={vi.fn()} currentDisplayName="me" hubCanWrite />)
    fireEvent.click(screen.getByTestId('key-labels-delete-localonly'))
    const confirm = await screen.findByTestId('key-labels-confirm-delete-localonly')
    fireEvent.click(confirm)
    await waitFor(() => expect(remove).toHaveBeenCalledWith('localonly'))
    expect(hubDelete).not.toHaveBeenCalled()
  })

  it('blocks the local delete and surfaces an error when the Hub delete rejects, leaving the entry intact', async () => {
    metas = [meta({ id: 'linked2', name: 'Linked2', uploaderName: 'me', hubPostId: 'hub-2' })]
    hubDelete.mockRejectedValueOnce(new Error('network error'))
    render(<KeyLabelsModal open onClose={vi.fn()} currentDisplayName="me" hubCanWrite />)
    fireEvent.click(screen.getByTestId('key-labels-delete-linked2'))
    const confirm = await screen.findByTestId('key-labels-confirm-delete-linked2')
    fireEvent.click(confirm)
    await waitFor(() => expect(hubDelete).toHaveBeenCalledWith('linked2'))
    await waitFor(() => expect(screen.getByTestId('key-labels-result-linked2').textContent).toBe('network error'))
    // A failed cascade must not proceed to the local delete — otherwise
    // the Hub post is orphaned under a name nobody can re-upload.
    expect(remove).not.toHaveBeenCalled()
    // Confirm state closed — retrying just means clicking Delete again.
    expect(screen.queryByTestId('key-labels-confirm-delete-linked2')).toBeNull()
    expect(screen.getByTestId('key-labels-delete-linked2')).toBeTruthy()
  })

  it('blocks the local delete when the Hub delete resolves with success: false', async () => {
    metas = [meta({ id: 'linked3', name: 'Linked3', uploaderName: 'me', hubPostId: 'hub-3' })]
    hubDelete.mockResolvedValueOnce({ success: false, error: 'Hub rejected the delete' })
    render(<KeyLabelsModal open onClose={vi.fn()} currentDisplayName="me" hubCanWrite />)
    fireEvent.click(screen.getByTestId('key-labels-delete-linked3'))
    const confirm = await screen.findByTestId('key-labels-confirm-delete-linked3')
    fireEvent.click(confirm)
    await waitFor(() => expect(hubDelete).toHaveBeenCalledWith('linked3'))
    await waitFor(() => expect(screen.getByTestId('key-labels-result-linked3').textContent).toBe('Hub rejected the delete'))
    expect(remove).not.toHaveBeenCalled()
  })

  // --- regression: Delete must not cascade to Hub for entries the user
  // does not own (fix/delete-ownership-gate). A downloaded label also
  // carries hubPostId (for Sync/freshness linkage) but is never
  // deletable on Hub by this user — the old code attempted the Hub
  // delete regardless of ownership, which failed for a foreign post
  // (or a deactivated uploader account, e.g. "Brazilian (QWERTY)" by
  // pipette) and then blocked the local delete too, leaving the user
  // unable to remove a downloaded label at all. ---

  it('a label downloaded from someone else deletes locally only — no Hub call at all (THE regression)', async () => {
    metas = [meta({ id: 'foreign-del', name: 'Foreign Label', uploaderName: 'pipette', hubPostId: 'hub-foreign' })]
    render(<KeyLabelsModal open onClose={vi.fn()} currentDisplayName="me" hubCanWrite />)
    fireEvent.click(screen.getByTestId('key-labels-delete-foreign-del'))
    const confirm = await screen.findByTestId('key-labels-confirm-delete-foreign-del')
    fireEvent.click(confirm)
    await waitFor(() => expect(remove).toHaveBeenCalledWith('foreign-del'))
    expect(hubDelete).not.toHaveBeenCalled()
  })

  it('a legacy hub-linked label with no cached uploaderName deletes locally only (conservative default, matches Update/Remove gating)', async () => {
    metas = [meta({ id: 'legacy-del', name: 'Legacy Label', hubPostId: 'hub-legacy' })]
    render(<KeyLabelsModal open onClose={vi.fn()} currentDisplayName="me" hubCanWrite />)
    fireEvent.click(screen.getByTestId('key-labels-delete-legacy-del'))
    const confirm = await screen.findByTestId('key-labels-confirm-delete-legacy-del')
    fireEvent.click(confirm)
    await waitFor(() => expect(remove).toHaveBeenCalledWith('legacy-del'))
    expect(hubDelete).not.toHaveBeenCalled()
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

  // --- Import/download placement + toolbar feedback + auto-scroll ---

  it('asc state: a new import is inserted at its sorted position via reorder, including QWERTY in scope', async () => {
    // Already ascending (QWERTY sorts between Alpha and Zeta) — detected
    // as 'asc' on open, no click needed.
    metas = [
      meta({ id: 'a', name: 'Alpha', uploaderName: 'me' }),
      meta({ id: 'qwerty', name: 'QWERTY', uploaderName: 'pipette' }),
      meta({ id: 'z', name: 'Zeta', uploaderName: 'me' }),
    ]
    importFromFile.mockResolvedValueOnce({ success: true, data: meta({ id: 'm', name: 'Mu' }) })
    render(<KeyLabelsModal open onClose={vi.fn()} currentDisplayName="me" hubCanWrite />)

    fireEvent.click(screen.getByTestId('key-labels-import-button'))
    await waitFor(() => expect(reorder).toHaveBeenCalledWith(['a', 'm', 'qwerty', 'z']))
  })

  it('free state (shuffled list): a new import does not call reorder — the store appends it at the bottom on its own', async () => {
    metas = [
      meta({ id: 'm', name: 'Mu', uploaderName: 'me' }),
      meta({ id: 'z', name: 'Zeta', uploaderName: 'me' }),
      meta({ id: 'a', name: 'Alpha', uploaderName: 'me' }),
    ]
    importFromFile.mockResolvedValueOnce({ success: true, data: meta({ id: 'b', name: 'Beta' }) })
    render(<KeyLabelsModal open onClose={vi.fn()} currentDisplayName="me" hubCanWrite />)

    fireEvent.click(screen.getByTestId('key-labels-import-button'))
    await waitFor(() => expect(importFromFile).toHaveBeenCalled())
    expect(reorder).not.toHaveBeenCalled()
  })

  it('overwrite (same id already installed) keeps its position — no reorder call, "Updated" feedback', async () => {
    metas = [meta({ id: 'a', name: 'Alpha', uploaderName: 'me' }), meta({ id: 'z', name: 'Zeta', uploaderName: 'me' })]
    // Overwrite: the store reuses the existing 'a' id.
    importFromFile.mockResolvedValueOnce({ success: true, data: meta({ id: 'a', name: 'Alpha' }) })
    render(<KeyLabelsModal open onClose={vi.fn()} currentDisplayName="me" hubCanWrite />)

    fireEvent.click(screen.getByTestId('key-labels-import-button'))
    await waitFor(() => expect(importFromFile).toHaveBeenCalled())
    expect(reorder).not.toHaveBeenCalled()
    expect(screen.getByTestId('key-labels-import-feedback').textContent).toBe('common.updatedNamed:Alpha')
  })

  it('new import shows "Imported {{name}}" feedback next to the Name button', async () => {
    metas = [meta({ id: 'a', name: 'Alpha', uploaderName: 'me' })]
    importFromFile.mockResolvedValueOnce({ success: true, data: meta({ id: 'b', name: 'Beta' }) })
    render(<KeyLabelsModal open onClose={vi.fn()} currentDisplayName="me" hubCanWrite />)

    fireEvent.click(screen.getByTestId('key-labels-import-button'))
    await waitFor(() => expect(screen.getByTestId('key-labels-import-feedback').textContent).toBe('common.importedNamed:Beta'))
  })

  it('scrolls the imported row into view', async () => {
    metas = [meta({ id: 'a', name: 'Alpha', uploaderName: 'me' })]
    const newMeta = meta({ id: 'b', name: 'Beta' })
    importFromFile.mockImplementationOnce(async () => {
      metas = [...metas, newMeta]
      return { success: true, data: newMeta }
    })
    render(<KeyLabelsModal open onClose={vi.fn()} currentDisplayName="me" hubCanWrite />)

    await waitFor(() => expect(screen.getByTestId('key-labels-row-a')).toBeTruthy())
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    try {
      fireEvent.click(screen.getByTestId('key-labels-import-button'))
      await waitFor(() => expect(screen.getByTestId('key-labels-row-b')).toBeTruthy())
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' }))
    } finally {
      scrollIntoView.mockRestore()
    }
  })

  it('hub download parity: DUPLICATE_NAME guard aside, a new Hub download is always an insert (never an overwrite), placed at its sorted position via reorder', async () => {
    // Already ascending — detected as 'asc' on open, no click needed.
    metas = [meta({ id: 'a', name: 'Alpha', uploaderName: 'me' }), meta({ id: 'z', name: 'Zeta', uploaderName: 'me' })]
    hubDownload.mockResolvedValueOnce({ success: true, data: meta({ id: 'hub-m', name: 'Mu' }) })
    render(<KeyLabelsModal open onClose={vi.fn()} currentDisplayName="me" hubCanWrite />)

    fireEvent.click(screen.getByTestId('key-labels-tab-hub'))
    fireEvent.change(screen.getByTestId('key-labels-search-input'), { target: { value: 'mu' } })
    hubSearch.mockResolvedValueOnce({
      success: true,
      data: { items: [{ id: 'hub-m', name: 'Mu', map: {}, composite_labels: null, uploaded_by: null, uploader_name: 'someone', created_at: '', updated_at: '' }], total: 1, page: 1, per_page: 50 },
    })
    fireEvent.click(screen.getByTestId('key-labels-search-button'))
    await waitFor(() => expect(screen.getByTestId('key-labels-download-hub-m')).toBeTruthy())

    fireEvent.click(screen.getByTestId('key-labels-download-hub-m'))
    await waitFor(() => expect(reorder).toHaveBeenCalledWith(['a', 'hub-m', 'z']))
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

  it('Delete on a hub-linked entry calls remove(id)', async () => {
    metas = [meta({ id: 'hubbed', name: 'Hubbed', uploaderName: 'me', hubPostId: 'hub-99' })]
    render(<KeyLabelsModal open onClose={vi.fn()} currentDisplayName="me" hubCanWrite />)
    fireEvent.click(screen.getByTestId('key-labels-delete-hubbed'))
    const confirm = await screen.findByTestId('key-labels-confirm-delete-hubbed')
    fireEvent.click(confirm)
    await waitFor(() => expect(remove).toHaveBeenCalledWith('hubbed'))
  })

  it('auto-pushes to Hub when importing over an entry with hubPostId', async () => {
    const importedMeta = meta({ id: 'existing', name: 'Existing', hubPostId: 'hub-55' })
    importFromFile.mockResolvedValueOnce({ success: true, data: importedMeta })
    hubUpdate.mockResolvedValueOnce({ success: true, data: importedMeta })
    render(<KeyLabelsModal open onClose={vi.fn()} currentDisplayName="me" hubCanWrite />)
    fireEvent.click(screen.getByTestId('key-labels-import-button'))
    await waitFor(() => expect(hubUpdate).toHaveBeenCalledWith('existing'))
  })

  it('shows error when hub auto-sync fails after import', async () => {
    const importedMeta = meta({ id: 'existing', name: 'Existing', hubPostId: 'hub-55' })
    importFromFile.mockResolvedValueOnce({ success: true, data: importedMeta })
    hubUpdate.mockResolvedValueOnce({ success: false, error: 'network error' })
    render(<KeyLabelsModal open onClose={vi.fn()} currentDisplayName="me" hubCanWrite />)
    fireEvent.click(screen.getByTestId('key-labels-import-button'))
    await waitFor(() => expect(hubUpdate).toHaveBeenCalledWith('existing'))
    await waitFor(() => {
      expect(screen.getByText('network error')).toBeTruthy()
    })
  })

  // --- Phase 2: Name sort (drag reorder itself predates this phase) -------

  it('the Name sort button sorts installed labels ascending on first click, including QWERTY', async () => {
    metas = [
      meta({ id: 'qwerty', name: 'QWERTY', uploaderName: 'pipette' }),
      meta({ id: 'z', name: 'Zeta' }),
      meta({ id: 'a', name: 'Alpha' }),
    ]
    render(<KeyLabelsModal open onClose={vi.fn()} currentDisplayName="me" hubCanWrite />)
    fireEvent.click(screen.getByTestId('key-labels-sort-button'))
    await waitFor(() => expect(reorder).toHaveBeenCalledWith(['a', 'qwerty', 'z']))
  })

  it('a second click on the Name sort button reverses the order', async () => {
    metas = [meta({ id: 'z', name: 'Zeta' }), meta({ id: 'a', name: 'Alpha' })]
    render(<KeyLabelsModal open onClose={vi.fn()} currentDisplayName="me" hubCanWrite />)
    fireEvent.click(screen.getByTestId('key-labels-sort-button'))
    await waitFor(() => expect(reorder).toHaveBeenCalledWith(['a', 'z']))
    fireEvent.click(screen.getByTestId('key-labels-sort-button'))
    await waitFor(() => expect(reorder).toHaveBeenLastCalledWith(['z', 'a']))
  })
})
