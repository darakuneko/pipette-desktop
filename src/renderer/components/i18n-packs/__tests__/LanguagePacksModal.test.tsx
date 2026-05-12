// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (params && 'name' in params) return `${key}:${String(params.name)}`
      return key
    },
  }),
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
const renameFn = vi.fn()
const removeFn = vi.fn()
const importFromDialog = vi.fn()
const applyImport = vi.fn()
const setEnabled = vi.fn()

let storeMetas: Array<{
  id: string
  name: string
  version: string
  enabled: boolean
  hubPostId?: string
  hubUpdatedAt?: string
  filename: string
  savedAt: string
  updatedAt: string
  deletedAt?: string
  matchedBaseVersion?: string
  coverage?: { totalKeys: number; coveredKeys: number }
  appVersionAtImport?: string
  dangerousKeyCount?: number
}> = []

vi.mock('../../../hooks/useI18nPackStore', () => ({
  useI18nPackStore: () => ({
    metas: storeMetas,
    loading: false,
    refresh,
    rename: renameFn,
    remove: removeFn,
    importFromDialog,
    applyImport,
    setEnabled,
    packRemovedNotice: null,
    dismissPackRemovedNotice: vi.fn(),
  }),
}))

let mockLanguage: string = 'builtin:en'
const mockAppConfigSet = vi.fn()

vi.mock('../../../hooks/useAppConfig', () => ({
  useAppConfig: () => ({
    config: { language: mockLanguage },
    loading: false,
    set: mockAppConfigSet,
  }),
}))

vi.mock('../../../hooks/useHubFreshness', () => ({
  useHubFreshness: ({ enabled, candidates, fetchTimestamps }: {
    enabled: boolean
    candidates: Array<{ localId: string; hubPostId: string }>
    fetchTimestamps: (ids: string[]) => Promise<unknown>
  }) => {
    if (enabled && candidates.length > 0) {
      void fetchTimestamps(candidates.map((c) => c.hubPostId))
    }
    return new Map()
  },
  hasUpdate: () => false,
}))

vi.mock('../../../i18n', () => ({
  default: { changeLanguage: vi.fn().mockResolvedValue(undefined) },
}))

vi.mock('../../../../shared/i18n/validate', () => ({
  validatePack: (raw: unknown) => {
    if (!raw || typeof raw !== 'object') {
      return { ok: false, errors: ['Pack must be a JSON object'], warnings: [], dangerousKeys: [] }
    }
    const obj = raw as Record<string, unknown>
    if (obj.__dangerous) {
      return { ok: true, errors: [], warnings: [], dangerousKeys: ['__proto__'], header: { name: String(obj.name), version: String(obj.version) } }
    }
    if (obj.__invalid) {
      return { ok: false, errors: ['version must be a valid semver (e.g. 0.1.0)'], warnings: [], dangerousKeys: [] }
    }
    return { ok: true, errors: [], warnings: [], dangerousKeys: [], header: { name: String(obj.name), version: String(obj.version) } }
  },
}))

vi.mock('../../../../shared/i18n/coverage', () => ({
  computeCoverage: () => ({
    totalKeys: 100,
    coveredKeys: 100,
    missingKeys: [],
    excessKeys: [],
    coverageRatio: 1,
  }),
}))

vi.mock('../../../i18n/coverage-cache', () => ({
  BASE_REVISION: '0.1.0',
  ENGLISH_PACK_BODY: { name: 'English', version: '0.1.0', common: { save: 'Save' } },
}))

vi.mock('../../../i18n/locales/english.json', () => ({
  default: { name: 'English', version: '0.1.0', common: { save: 'Save' } },
}))

vi.mock('../../../utils/download-json', () => ({
  downloadJson: vi.fn(),
}))

vi.mock('../../../utils/format-timestamp', () => ({
  formatTimestamp: (iso: string) => iso === 'now' ? '' : iso,
}))

const vialAPI = {
  hubGetOrigin: vi.fn(),
  hubListI18nPosts: vi.fn(),
  hubDownloadI18nPost: vi.fn(),
  hubUploadI18nPost: vi.fn(),
  hubUpdateI18nPost: vi.fn(),
  hubDeleteI18nPost: vi.fn(),
  i18nPackGet: vi.fn(),
  i18nPackExport: vi.fn(),
  i18nPackSetHubPostId: vi.fn(),
  i18nPackHubTimestamps: vi.fn(),
  openExternal: vi.fn(),
}

Object.defineProperty(window, 'vialAPI', { value: vialAPI, writable: true })

import { LanguagePacksModal } from '../LanguagePacksModal'
import { downloadJson } from '../../../utils/download-json'

function meta(over: Partial<{
  id: string
  name: string
  version: string
  enabled: boolean
  hubPostId: string
  hubUpdatedAt: string
  deletedAt: string
  matchedBaseVersion: string
  coverage: { totalKeys: number; coveredKeys: number }
}> = {}) {
  return {
    id: over.id ?? 'a',
    name: over.name ?? 'Pack A',
    version: over.version ?? '0.1.0',
    enabled: over.enabled ?? true,
    filename: `${over.id ?? 'a'}.json`,
    savedAt: 'now',
    updatedAt: 'now',
    ...(over.hubPostId ? { hubPostId: over.hubPostId } : {}),
    ...(over.hubUpdatedAt ? { hubUpdatedAt: over.hubUpdatedAt } : {}),
    ...(over.deletedAt ? { deletedAt: over.deletedAt } : {}),
    ...(over.matchedBaseVersion !== undefined ? { matchedBaseVersion: over.matchedBaseVersion } : {}),
    ...(over.coverage ? { coverage: over.coverage } : {}),
  }
}

async function switchToHubTab(): Promise<void> {
  fireEvent.click(screen.getByTestId('language-packs-tab-hub'))
  await waitFor(() => expect(screen.getByTestId('language-packs-search-input')).toBeTruthy())
}

describe('LanguagePacksModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeMetas = []
    mockLanguage = 'builtin:en'
    removeFn.mockResolvedValue({ success: true })
    renameFn.mockResolvedValue({ success: true })
    importFromDialog.mockResolvedValue({ canceled: true })
    applyImport.mockResolvedValue({ success: true, meta: meta() })
    vialAPI.hubGetOrigin.mockResolvedValue('https://hub.example.com')
    vialAPI.hubListI18nPosts.mockResolvedValue({ success: true, data: { items: [] } })
    vialAPI.hubDownloadI18nPost.mockResolvedValue({ success: true, data: { pack: { name: 'DL', version: '0.1.0', common: {} } } })
    vialAPI.hubUploadI18nPost.mockResolvedValue({ success: true })
    vialAPI.hubUpdateI18nPost.mockResolvedValue({ success: true })
    vialAPI.hubDeleteI18nPost.mockResolvedValue({ success: true })
    vialAPI.i18nPackGet.mockResolvedValue({ success: true, data: { pack: { name: 'P', version: '0.1.0', common: {} } } })
    vialAPI.i18nPackExport.mockResolvedValue({ success: true })
    vialAPI.i18nPackSetHubPostId.mockResolvedValue({ success: true })
    vialAPI.i18nPackHubTimestamps.mockResolvedValue({ success: true, data: { items: [] } })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders nothing when closed', () => {
    const { container } = render(
      <LanguagePacksModal open={false} onClose={vi.fn()} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders modal content when open', () => {
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    expect(screen.getByTestId('language-packs-modal')).toBeTruthy()
    expect(screen.getByText('i18n.modalTitle')).toBeTruthy()
  })

  it('shows Installed and Hub tabs', () => {
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    expect(screen.getByTestId('language-packs-tab-installed')).toBeTruthy()
    expect(screen.getByTestId('language-packs-tab-hub')).toBeTruthy()
  })

  it('shows built-in English row on Installed tab', () => {
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    expect(screen.getByTestId('language-packs-row-builtin:en')).toBeTruthy()
    expect(screen.getByText('English')).toBeTruthy()
  })

  it('built-in English row shows export but not delete', () => {
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    expect(screen.getByTestId('language-packs-export-builtin:en')).toBeTruthy()
    expect(screen.queryByTestId('language-packs-delete-builtin:en')).toBeNull()
  })

  it('switches to Hub tab and shows search input', async () => {
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    await switchToHubTab()
    expect(screen.getByTestId('language-packs-search-input')).toBeTruthy()
    expect(screen.getByTestId('language-packs-search-button')).toBeTruthy()
  })

  it('switches back to Installed tab', async () => {
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    await switchToHubTab()
    fireEvent.click(screen.getByTestId('language-packs-tab-installed'))
    expect(screen.getByTestId('language-packs-row-builtin:en')).toBeTruthy()
    expect(screen.queryByTestId('language-packs-search-input')).toBeNull()
  })

  it('renders imported pack rows', () => {
    storeMetas = [meta({ id: 'p1', name: 'Japanese' })]
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    expect(screen.getByTestId('language-packs-row-p1')).toBeTruthy()
    expect(screen.getByText('Japanese')).toBeTruthy()
  })

  it('skips tombstoned (deleted) metas in installed rows', () => {
    storeMetas = [meta({ id: 'del1', name: 'Deleted', deletedAt: '2026-01-01' })]
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    expect(screen.queryByTestId('language-packs-row-del1')).toBeNull()
  })

  it('selects a language via the select button', () => {
    storeMetas = [meta({ id: 'p1', name: 'Japanese' })]
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('language-packs-select-p1'))
    expect(mockAppConfigSet).toHaveBeenCalledWith('language', 'pack:p1')
  })

  it('does not call set when selecting the already-active language', () => {
    storeMetas = [meta({ id: 'p1', name: 'Japanese' })]
    mockLanguage = 'pack:p1'
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('language-packs-select-p1'))
    expect(mockAppConfigSet).not.toHaveBeenCalled()
  })

  it('import button triggers importFromDialog', async () => {
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('language-packs-import-button'))
    await waitFor(() => expect(importFromDialog).toHaveBeenCalled())
  })

  it('import applies the raw data when dialog returns a file', async () => {
    const raw = { name: 'Imported', version: '0.1.0', common: { ok: 'OK' } }
    importFromDialog.mockResolvedValueOnce({ canceled: false, raw })
    applyImport.mockResolvedValueOnce({ success: true, meta: meta({ id: 'imp1', name: 'Imported' }) })
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('language-packs-import-button'))
    await waitFor(() => expect(applyImport).toHaveBeenCalled())
  })

  it('import shows error on parse failure', async () => {
    importFromDialog.mockResolvedValueOnce({ canceled: false, parseError: 'Bad format' })
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('language-packs-import-button'))
    await waitFor(() => {
      expect(screen.getByTestId('language-packs-error')).toBeTruthy()
    })
  })

  it('import shows error for invalid pack validation', async () => {
    const raw = { name: 'Bad', version: 'not-semver', __invalid: true }
    importFromDialog.mockResolvedValueOnce({ canceled: false, raw })
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('language-packs-import-button'))
    await waitFor(() => {
      expect(screen.getByTestId('language-packs-error')).toBeTruthy()
    })
  })

  it('import shows error for dangerous keys', async () => {
    const raw = { name: 'Danger', version: '0.1.0', __dangerous: true }
    importFromDialog.mockResolvedValueOnce({ canceled: false, raw })
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('language-packs-import-button'))
    await waitFor(() => {
      expect(screen.getByTestId('language-packs-error')).toBeTruthy()
    })
  })

  it('overwrite import with hubPostId auto-syncs to Hub', async () => {
    const raw = { name: 'Synced', version: '0.1.0', common: {} }
    importFromDialog.mockResolvedValueOnce({ canceled: false, raw })
    applyImport.mockResolvedValueOnce({ success: true, meta: meta({ id: 's1', name: 'Synced', hubPostId: 'hp1' }) })
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('language-packs-import-button'))
    await waitFor(() => expect(vialAPI.hubUpdateI18nPost).toHaveBeenCalled())
  })

  it('delete asks for confirmation before invoking remove', () => {
    storeMetas = [meta({ id: 'p1', name: 'Pack' })]
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('language-packs-delete-p1'))
    expect(screen.getByTestId('language-packs-confirm-delete-p1')).toBeTruthy()
    expect(screen.getByTestId('language-packs-cancel-delete-p1')).toBeTruthy()
  })

  it('confirmed delete calls store.remove', async () => {
    storeMetas = [meta({ id: 'p1', name: 'Pack' })]
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('language-packs-delete-p1'))
    fireEvent.click(screen.getByTestId('language-packs-confirm-delete-p1'))
    await waitFor(() => expect(removeFn).toHaveBeenCalledWith('p1'))
  })

  it('cancel delete hides the confirmation', () => {
    storeMetas = [meta({ id: 'p1', name: 'Pack' })]
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('language-packs-delete-p1'))
    fireEvent.click(screen.getByTestId('language-packs-cancel-delete-p1'))
    expect(screen.queryByTestId('language-packs-confirm-delete-p1')).toBeNull()
  })

  it('delete also calls hubDeleteI18nPost for hub-linked pack', async () => {
    storeMetas = [meta({ id: 'hd1', name: 'Hub Delete', hubPostId: 'hp-hd1' })]
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('language-packs-delete-hd1'))
    fireEvent.click(screen.getByTestId('language-packs-confirm-delete-hd1'))
    await waitFor(() => expect(vialAPI.hubDeleteI18nPost).toHaveBeenCalledWith('hp-hd1', 'hd1'))
    await waitFor(() => expect(removeFn).toHaveBeenCalledWith('hd1'))
  })

  it('export action triggers i18nPackExport for imported rows', async () => {
    storeMetas = [meta({ id: 'p1', name: 'Pack' })]
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('language-packs-export-p1'))
    await waitFor(() => expect(vialAPI.i18nPackExport).toHaveBeenCalledWith('p1'))
  })

  it('export action triggers downloadJson for built-in English', () => {
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('language-packs-export-builtin:en'))
    expect(downloadJson).toHaveBeenCalled()
  })

  it('upload action calls hubUploadI18nPost', async () => {
    storeMetas = [meta({ id: 'u1', name: 'Upload Me' })]
    render(
      <LanguagePacksModal open onClose={vi.fn()} hubCanWrite />,
    )
    fireEvent.click(screen.getByTestId('language-packs-upload-u1'))
    await waitFor(() => expect(vialAPI.i18nPackGet).toHaveBeenCalledWith('u1'))
    await waitFor(() => expect(vialAPI.hubUploadI18nPost).toHaveBeenCalled())
  })

  it('upload button is hidden when hubCanWrite is false', () => {
    storeMetas = [meta({ id: 'nw1', name: 'No Write' })]
    render(
      <LanguagePacksModal open onClose={vi.fn()} hubCanWrite={false} />,
    )
    expect(screen.queryByTestId('language-packs-upload-nw1')).toBeNull()
  })

  it('update action calls pushPackToHub', async () => {
    storeMetas = [meta({ id: 'up1', name: 'Update Me', hubPostId: 'hp-up1' })]
    render(
      <LanguagePacksModal open onClose={vi.fn()} hubCanWrite />,
    )
    fireEvent.click(screen.getByTestId('language-packs-update-up1'))
    await waitFor(() => expect(vialAPI.i18nPackGet).toHaveBeenCalledWith('up1'))
    await waitFor(() => expect(vialAPI.hubUpdateI18nPost).toHaveBeenCalled())
  })

  it('update and remove buttons are visible when hubCanWrite is true for hub-linked row', () => {
    storeMetas = [meta({ id: 'w1', name: 'Write Hub', hubPostId: 'hp-w1' })]
    render(
      <LanguagePacksModal open onClose={vi.fn()} hubCanWrite />,
    )
    expect(screen.getByTestId('language-packs-update-w1')).toBeTruthy()
    expect(screen.getByTestId('language-packs-remove-w1')).toBeTruthy()
    expect(screen.queryByTestId('language-packs-sync-w1')).toBeNull()
  })

  it('update and remove buttons are hidden when hubCanWrite is false for hub-linked row', () => {
    storeMetas = [meta({ id: 'nw2', name: 'No Write Hub', hubPostId: 'hp-nw2' })]
    render(
      <LanguagePacksModal open onClose={vi.fn()} hubCanWrite={false} />,
    )
    expect(screen.queryByTestId('language-packs-update-nw2')).toBeNull()
    expect(screen.queryByTestId('language-packs-remove-nw2')).toBeNull()
    expect(screen.getByTestId('language-packs-sync-nw2')).toBeTruthy()
  })

  it('sync action calls hubDownloadI18nPost and applyImport', async () => {
    storeMetas = [meta({ id: 'sy1', name: 'Sync Me', hubPostId: 'hp-sy1' })]
    render(
      <LanguagePacksModal open onClose={vi.fn()} hubCanWrite={false} />,
    )
    fireEvent.click(screen.getByTestId('language-packs-sync-sy1'))
    await waitFor(() => expect(vialAPI.hubDownloadI18nPost).toHaveBeenCalledWith('hp-sy1'))
    await waitFor(() => expect(applyImport).toHaveBeenCalled())
  })

  it('remove action asks for confirmation', () => {
    storeMetas = [meta({ id: 'rm1', name: 'Remove Me', hubPostId: 'hp-rm1' })]
    render(
      <LanguagePacksModal open onClose={vi.fn()} hubCanWrite />,
    )
    fireEvent.click(screen.getByTestId('language-packs-remove-rm1'))
    expect(screen.getByTestId('language-packs-confirm-remove-rm1')).toBeTruthy()
    expect(screen.getByTestId('language-packs-cancel-remove-rm1')).toBeTruthy()
  })

  it('confirmed remove calls hubDeleteI18nPost', async () => {
    storeMetas = [meta({ id: 'rm2', name: 'Remove Me', hubPostId: 'hp-rm2' })]
    render(
      <LanguagePacksModal open onClose={vi.fn()} hubCanWrite />,
    )
    fireEvent.click(screen.getByTestId('language-packs-remove-rm2'))
    fireEvent.click(screen.getByTestId('language-packs-confirm-remove-rm2'))
    await waitFor(() => expect(vialAPI.hubDeleteI18nPost).toHaveBeenCalledWith('hp-rm2', 'rm2'))
  })

  it('cancel remove hides the confirmation', () => {
    storeMetas = [meta({ id: 'rm3', name: 'Remove Me', hubPostId: 'hp-rm3' })]
    render(
      <LanguagePacksModal open onClose={vi.fn()} hubCanWrite />,
    )
    fireEvent.click(screen.getByTestId('language-packs-remove-rm3'))
    fireEvent.click(screen.getByTestId('language-packs-cancel-remove-rm3'))
    expect(screen.queryByTestId('language-packs-confirm-remove-rm3')).toBeNull()
  })

  it('Hub search button is disabled when query is less than 2 chars', async () => {
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    await switchToHubTab()
    fireEvent.change(screen.getByTestId('language-packs-search-input'), { target: { value: 'a' } })
    const btn = screen.getByTestId('language-packs-search-button') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('Hub search triggers when Search button clicked with 2+ chars', async () => {
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    await switchToHubTab()
    fireEvent.change(screen.getByTestId('language-packs-search-input'), { target: { value: 'japanese' } })
    fireEvent.click(screen.getByTestId('language-packs-search-button'))
    await waitFor(() => expect(vialAPI.hubListI18nPosts).toHaveBeenCalledWith({ q: 'japanese' }))
  })

  it('debounced search fires after typing 2+ chars and waiting', async () => {
    vi.useFakeTimers()
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    await act(async () => { fireEvent.click(screen.getByTestId('language-packs-tab-hub')) })
    await act(async () => {
      fireEvent.change(screen.getByTestId('language-packs-search-input'), { target: { value: 'french' } })
    })
    expect(vialAPI.hubListI18nPosts).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(300) })
    expect(vialAPI.hubListI18nPosts).toHaveBeenCalledWith({ q: 'french' })
    vi.useRealTimers()
  })

  it('shows hub results after search returns items', async () => {
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    await switchToHubTab()
    vialAPI.hubListI18nPosts.mockResolvedValueOnce({
      success: true,
      data: {
        items: [
          { id: 'hub-99', name: 'French Pack', version: '1.0', uploaderName: 'someone' },
        ],
      },
    })
    fireEvent.change(screen.getByTestId('language-packs-search-input'), { target: { value: 'french' } })
    fireEvent.click(screen.getByTestId('language-packs-search-button'))
    await waitFor(() => {
      expect(screen.getByTestId('language-packs-hub-row-hub-99')).toBeTruthy()
      expect(screen.getByText('French Pack')).toBeTruthy()
    })
  })

  it('hub download action calls hubDownloadI18nPost and persistImportedPack', async () => {
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    await switchToHubTab()
    vialAPI.hubListI18nPosts.mockResolvedValueOnce({
      success: true,
      data: {
        items: [
          { id: 'hub-dl', name: 'German', version: '1.0', uploaderName: null },
        ],
      },
    })
    fireEvent.change(screen.getByTestId('language-packs-search-input'), { target: { value: 'german' } })
    fireEvent.click(screen.getByTestId('language-packs-search-button'))
    await waitFor(() => expect(screen.getByTestId('language-packs-hub-download-hub-dl')).toBeTruthy())
    fireEvent.click(screen.getByTestId('language-packs-hub-download-hub-dl'))
    await waitFor(() => expect(vialAPI.hubDownloadI18nPost).toHaveBeenCalledWith('hub-dl'))
    await waitFor(() => expect(applyImport).toHaveBeenCalled())
  })

  it('hub row shows installed label when pack is already installed', async () => {
    storeMetas = [meta({ id: 'local1', name: 'Existing', hubPostId: 'hub-3' })]
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    await switchToHubTab()
    vialAPI.hubListI18nPosts.mockResolvedValueOnce({
      success: true,
      data: {
        items: [
          { id: 'hub-3', name: 'Existing', version: '1.0', uploaderName: null },
        ],
      },
    })
    fireEvent.change(screen.getByTestId('language-packs-search-input'), { target: { value: 'exist' } })
    fireEvent.click(screen.getByTestId('language-packs-search-button'))
    await waitFor(() => expect(screen.getByTestId('language-packs-hub-row-hub-3')).toBeTruthy())
    expect(screen.queryByTestId('language-packs-hub-download-hub-3')).toBeNull()
  })

  it('does not treat deleted (tombstoned) metas as installed in hub rows', async () => {
    storeMetas = [meta({ id: 'del1', name: 'Deleted', hubPostId: 'hp-del1', deletedAt: '2026-01-01' })]
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    await switchToHubTab()
    vialAPI.hubListI18nPosts.mockResolvedValueOnce({
      success: true,
      data: {
        items: [
          { id: 'hp-del1', name: 'Deleted', version: '1.0', uploaderName: null },
        ],
      },
    })
    fireEvent.change(screen.getByTestId('language-packs-search-input'), { target: { value: 'deleted' } })
    fireEvent.click(screen.getByTestId('language-packs-search-button'))
    await waitFor(() => expect(screen.getByTestId('language-packs-hub-row-hp-del1')).toBeTruthy())
    expect(screen.getByTestId('language-packs-hub-download-hp-del1')).toBeTruthy()
  })

  it('hub empty message when search returns no results', async () => {
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    await switchToHubTab()
    vialAPI.hubListI18nPosts.mockResolvedValueOnce({
      success: true,
      data: { items: [] },
    })
    fireEvent.change(screen.getByTestId('language-packs-search-input'), { target: { value: 'zzz' } })
    fireEvent.click(screen.getByTestId('language-packs-search-button'))
    await waitFor(() => {
      expect(screen.getByTestId('language-packs-hub-empty')).toBeTruthy()
      expect(screen.getByText('i18n.hubEmpty')).toBeTruthy()
    })
  })

  it('hub initial hint when no search has been performed', async () => {
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    await switchToHubTab()
    expect(screen.getByTestId('language-packs-hub-empty')).toBeTruthy()
    expect(screen.getByText('common.findOnHubHint')).toBeTruthy()
  })

  it('hub search error is displayed', async () => {
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    await switchToHubTab()
    vialAPI.hubListI18nPosts.mockResolvedValueOnce({
      success: false,
      error: 'Network error',
    })
    fireEvent.change(screen.getByTestId('language-packs-search-input'), { target: { value: 'fail' } })
    fireEvent.click(screen.getByTestId('language-packs-search-button'))
    await waitFor(() => {
      expect(screen.getByTestId('language-packs-error')).toBeTruthy()
      expect(screen.getByText('Network error')).toBeTruthy()
    })
  })

  it('rename triggers inline edit and commits on blur', async () => {
    storeMetas = [meta({ id: 'r1', name: 'Old Name' })]
    renameFn.mockResolvedValueOnce({ success: true, meta: meta({ id: 'r1', name: 'New Name' }) })
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('language-packs-name-r1'))
    const input = screen.getByTestId('language-packs-rename-input-r1')
    expect(input).toBeTruthy()
    fireEvent.change(input, { target: { value: 'New Name' } })
    fireEvent.blur(input)
    await waitFor(() => expect(renameFn).toHaveBeenCalledWith('r1', 'New Name'))
  })

  it('open in browser calls openExternal for hub-linked row', async () => {
    storeMetas = [meta({ id: 'o1', name: 'Open Me', hubPostId: 'hp-o1' })]
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    await waitFor(() => expect(vialAPI.hubGetOrigin).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId('language-packs-open-o1'))
    await waitFor(() => expect(vialAPI.openExternal).toHaveBeenCalled())
  })

  it('backdrop click calls onClose', () => {
    const onClose = vi.fn()
    render(
      <LanguagePacksModal open onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('language-packs-modal-backdrop'))
    expect(onClose).toHaveBeenCalled()
  })

  it('close button calls onClose', () => {
    const onClose = vi.fn()
    render(
      <LanguagePacksModal open onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('language-packs-modal-close'))
    expect(onClose).toHaveBeenCalled()
  })

  it('shows version badge for complete packs', () => {
    storeMetas = [meta({ id: 'c1', name: 'Complete', matchedBaseVersion: '0.1.0' })]
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    expect(screen.getByTestId('language-packs-version-c1')).toBeTruthy()
    expect(screen.getByTestId('language-packs-version-c1').textContent).toBe('v0.1.0')
  })

  it('shows not-set-keys button for incomplete packs', () => {
    storeMetas = [meta({ id: 'ic1', name: 'Incomplete' })]
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    expect(screen.getByTestId('language-packs-not-set-keys-ic1')).toBeTruthy()
  })

  it('not-set-keys button opens MissingKeysModal', async () => {
    storeMetas = [meta({ id: 'ic1', name: 'Incomplete' })]
    vialAPI.i18nPackGet.mockResolvedValueOnce({
      success: true,
      data: { pack: { name: 'Incomplete', version: '0.1.0', common: {} } },
    })
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('language-packs-not-set-keys-ic1'))
    await waitFor(() => expect(vialAPI.i18nPackGet).toHaveBeenCalledWith('ic1'))
    await waitFor(() => expect(screen.getByTestId('missing-keys-modal')).toBeTruthy())
  })

  it('upload shows error result on failure', async () => {
    storeMetas = [meta({ id: 'uf1', name: 'Upload Fail' })]
    vialAPI.i18nPackGet.mockResolvedValueOnce({ success: false, error: 'Not found' })
    render(
      <LanguagePacksModal open onClose={vi.fn()} hubCanWrite />,
    )
    fireEvent.click(screen.getByTestId('language-packs-upload-uf1'))
    await waitFor(() => {
      expect(screen.getByTestId('language-packs-result-uf1')).toBeTruthy()
    })
  })

  it('export shows error on failure', async () => {
    storeMetas = [meta({ id: 'ef1', name: 'Export Fail' })]
    vialAPI.i18nPackExport.mockResolvedValueOnce({ success: false, error: 'Export failed' })
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('language-packs-export-ef1'))
    await waitFor(() => {
      expect(screen.getByTestId('language-packs-result-ef1')).toBeTruthy()
    })
  })

  it('clears error and result state when modal closes and reopens', async () => {
    const onClose = vi.fn()
    const { rerender } = render(
      <LanguagePacksModal open onClose={onClose} />,
    )
    await switchToHubTab()
    vialAPI.hubListI18nPosts.mockResolvedValueOnce({
      success: false,
      error: 'Network error',
    })
    fireEvent.change(screen.getByTestId('language-packs-search-input'), { target: { value: 'fail' } })
    fireEvent.click(screen.getByTestId('language-packs-search-button'))
    await waitFor(() => expect(screen.getByTestId('language-packs-error')).toBeTruthy())
    rerender(<LanguagePacksModal open={false} onClose={onClose} />)
    rerender(<LanguagePacksModal open onClose={onClose} />)
    expect(screen.queryByTestId('language-packs-error')).toBeNull()
  })
})
