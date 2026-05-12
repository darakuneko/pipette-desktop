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
const exportPack = vi.fn()

let metas: Array<{
  id: string
  name: string
  version: string
  hubPostId?: string
  hubUpdatedAt?: string
  filename: string
  savedAt: string
  updatedAt: string
  deletedAt?: string
}> = []

vi.mock('../../../hooks/useThemePackStore', () => ({
  useThemePackStore: () => ({
    metas,
    loading: false,
    refresh,
    rename: renameFn,
    remove: removeFn,
    importFromDialog,
    applyImport,
    exportPack,
  }),
}))

let mockTheme: string = 'system'

vi.mock('../../../hooks/useAppConfig', () => ({
  useAppConfig: () => ({
    config: { theme: mockTheme },
    loading: false,
    set: vi.fn(),
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

vi.mock('../../../hooks/useTheme', () => ({
  applyPackColors: vi.fn(),
  clearPackColors: vi.fn(),
  isPackTheme: (t: string) => t.startsWith('pack:'),
  extractPackId: (t: string) => t.slice(5),
}))

const vialAPI = {
  hubGetOrigin: vi.fn(),
  hubListThemePosts: vi.fn(),
  hubDownloadThemePost: vi.fn(),
  hubUploadThemePost: vi.fn(),
  hubUpdateThemePost: vi.fn(),
  hubDeleteThemePost: vi.fn(),
  themePackGet: vi.fn(),
  themePackHubTimestamps: vi.fn(),
  openExternal: vi.fn(),
}

Object.defineProperty(window, 'vialAPI', { value: vialAPI, writable: true })

import { ThemePacksModal } from '../ThemePacksModal'

function meta(over: Partial<{
  id: string
  name: string
  version: string
  hubPostId: string
  hubUpdatedAt: string
  deletedAt: string
}> = {}) {
  return {
    id: over.id ?? 'a',
    name: over.name ?? 'Pack A',
    version: over.version ?? '1.0',
    filename: 'a.json',
    savedAt: 'now',
    updatedAt: 'now',
    ...(over.hubPostId ? { hubPostId: over.hubPostId } : {}),
    ...(over.hubUpdatedAt ? { hubUpdatedAt: over.hubUpdatedAt } : {}),
    ...(over.deletedAt ? { deletedAt: over.deletedAt } : {}),
  }
}

describe('ThemePacksModal', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    metas = []
    mockTheme = 'system'
    removeFn.mockResolvedValue({ success: true })
    renameFn.mockResolvedValue({ success: true })
    importFromDialog.mockResolvedValue({ canceled: true })
    applyImport.mockResolvedValue({ success: true, meta: meta() })
    exportPack.mockResolvedValue({ success: true })
    vialAPI.hubGetOrigin.mockResolvedValue('https://hub.example.com')
    vialAPI.hubListThemePosts.mockResolvedValue({ success: true, data: { items: [] } })
    vialAPI.hubDownloadThemePost.mockResolvedValue({ success: true, data: { name: 'DL', version: '1', colorScheme: 'dark', colors: {} } })
    vialAPI.hubUploadThemePost.mockResolvedValue({ success: true })
    vialAPI.hubUpdateThemePost.mockResolvedValue({ success: true })
    vialAPI.hubDeleteThemePost.mockResolvedValue({ success: true })
    vialAPI.themePackGet.mockResolvedValue({ success: true, data: { meta: {}, pack: { name: 'P', version: '1', colorScheme: 'dark', colors: {} } } })
    vialAPI.themePackHubTimestamps.mockResolvedValue({ success: true, data: { items: [] } })
  })

  it('renders nothing when closed', () => {
    const { container } = render(
      <ThemePacksModal open={false} onClose={vi.fn()} onThemeChange={vi.fn()} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders modal content when open', () => {
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />,
    )
    expect(screen.getByTestId('theme-packs-modal')).toBeTruthy()
    expect(screen.getByText('themePacks.title')).toBeTruthy()
  })

  it('shows Installed and Hub tabs', () => {
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />,
    )
    expect(screen.getByTestId('theme-packs-tab-installed')).toBeTruthy()
    expect(screen.getByTestId('theme-packs-tab-hub')).toBeTruthy()
  })

  it('switches to Hub tab and shows search input', () => {
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-tab-hub'))
    expect(screen.getByTestId('theme-packs-search-input')).toBeTruthy()
    expect(screen.getByTestId('theme-packs-search-button')).toBeTruthy()
  })

  it('switches back to Installed tab', () => {
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-tab-hub'))
    fireEvent.click(screen.getByTestId('theme-packs-tab-installed'))
    expect(screen.getByTestId('theme-packs-builtin-system')).toBeTruthy()
    expect(screen.queryByTestId('theme-packs-search-input')).toBeNull()
  })

  it('renders built-in theme buttons (system, light, dark)', () => {
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />,
    )
    expect(screen.getByTestId('theme-packs-builtin-system')).toBeTruthy()
    expect(screen.getByTestId('theme-packs-builtin-light')).toBeTruthy()
    expect(screen.getByTestId('theme-packs-builtin-dark')).toBeTruthy()
  })

  it('selects a built-in theme and calls onThemeChange', () => {
    const onThemeChange = vi.fn()
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={onThemeChange} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-builtin-dark'))
    expect(onThemeChange).toHaveBeenCalledWith('dark')
  })

  it('does not call onThemeChange when selecting the already-active theme', () => {
    mockTheme = 'dark'
    const onThemeChange = vi.fn()
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={onThemeChange} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-builtin-dark'))
    expect(onThemeChange).not.toHaveBeenCalled()
  })

  it('renders imported pack rows', () => {
    metas = [meta({ id: 'p1', name: 'My Theme' })]
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />,
    )
    expect(screen.getByTestId('theme-packs-row-p1')).toBeTruthy()
    expect(screen.getByText('My Theme')).toBeTruthy()
  })

  it('selects a pack theme via the select button', () => {
    metas = [meta({ id: 'p1', name: 'My Theme' })]
    const onThemeChange = vi.fn()
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={onThemeChange} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-select-p1'))
    expect(onThemeChange).toHaveBeenCalledWith('pack:p1')
  })

  it('falls back to system when active pack is deleted', async () => {
    metas = [meta({ id: 'p1', name: 'Active Pack' })]
    mockTheme = 'pack:p1'
    const onThemeChange = vi.fn()
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={onThemeChange} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-delete-p1'))
    const confirm = await screen.findByTestId('theme-packs-confirm-delete-p1')
    fireEvent.click(confirm)
    await waitFor(() => expect(removeFn).toHaveBeenCalledWith('p1'))
    await waitFor(() => expect(onThemeChange).toHaveBeenCalledWith('system'))
  })

  it('delete asks for confirmation before invoking remove', async () => {
    metas = [meta({ id: 'p1', name: 'Pack' })]
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-delete-p1'))
    expect(screen.getByTestId('theme-packs-confirm-delete-p1')).toBeTruthy()
    expect(screen.getByTestId('theme-packs-cancel-delete-p1')).toBeTruthy()
  })

  it('cancel delete hides the confirmation', () => {
    metas = [meta({ id: 'p1', name: 'Pack' })]
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-delete-p1'))
    fireEvent.click(screen.getByTestId('theme-packs-cancel-delete-p1'))
    expect(screen.queryByTestId('theme-packs-confirm-delete-p1')).toBeNull()
  })

  it('export action triggers exportPack for the row', async () => {
    metas = [meta({ id: 'p1', name: 'Pack' })]
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-export-p1'))
    await waitFor(() => expect(exportPack).toHaveBeenCalledWith('p1'))
  })

  it('import button triggers importFromDialog', async () => {
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-import-button'))
    await waitFor(() => expect(importFromDialog).toHaveBeenCalled())
  })

  it('import applies the raw data when dialog returns a file', async () => {
    const raw = { name: 'Imported', version: '1', colorScheme: 'dark', colors: {} }
    importFromDialog.mockResolvedValueOnce({ canceled: false, raw })
    applyImport.mockResolvedValueOnce({ success: true, meta: meta({ id: 'new1', name: 'Imported' }) })
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-import-button'))
    await waitFor(() => expect(applyImport).toHaveBeenCalledWith(raw))
  })

  it('import shows error on parse failure', async () => {
    importFromDialog.mockResolvedValueOnce({ canceled: false, parseError: 'Bad format' })
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-import-button'))
    await waitFor(() => {
      expect(screen.getByTestId('theme-packs-error')).toBeTruthy()
      expect(screen.getByText('Bad format')).toBeTruthy()
    })
  })

  it('import with hubPostId auto-syncs to hub', async () => {
    const raw = { name: 'Synced', version: '1', colorScheme: 'dark', colors: {} }
    importFromDialog.mockResolvedValueOnce({ canceled: false, raw })
    applyImport.mockResolvedValueOnce({ success: true, meta: meta({ id: 's1', name: 'Synced', hubPostId: 'hp1' }) })
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-import-button'))
    await waitFor(() => expect(vialAPI.hubUpdateThemePost).toHaveBeenCalled())
  })

  it('Hub search button is disabled when query is less than 2 chars', () => {
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-tab-hub'))
    fireEvent.change(screen.getByTestId('theme-packs-search-input'), { target: { value: 'a' } })
    const btn = screen.getByTestId('theme-packs-search-button') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('Hub search triggers when Search button clicked with 2+ chars', async () => {
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-tab-hub'))
    fireEvent.change(screen.getByTestId('theme-packs-search-input'), { target: { value: 'retro' } })
    fireEvent.click(screen.getByTestId('theme-packs-search-button'))
    await waitFor(() => expect(vialAPI.hubListThemePosts).toHaveBeenCalledWith({ q: 'retro' }))
  })

  it('debounced search fires after typing 2+ chars and waiting', async () => {
    vi.useFakeTimers()
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-tab-hub'))
    fireEvent.change(screen.getByTestId('theme-packs-search-input'), { target: { value: 'neon' } })
    expect(vialAPI.hubListThemePosts).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(300) })
    vi.useRealTimers()
    await waitFor(() => expect(vialAPI.hubListThemePosts).toHaveBeenCalledWith({ q: 'neon' }))
  })

  it('shows hub results after search returns items', async () => {
    vialAPI.hubListThemePosts.mockResolvedValueOnce({
      success: true,
      data: {
        items: [
          { id: 'hub-1', name: 'Retro Theme', version: '2.0', uploaderName: 'alice', createdAt: '', updatedAt: '' },
        ],
      },
    })
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-tab-hub'))
    fireEvent.change(screen.getByTestId('theme-packs-search-input'), { target: { value: 'retro' } })
    fireEvent.click(screen.getByTestId('theme-packs-search-button'))
    await waitFor(() => {
      expect(screen.getByTestId('theme-packs-hub-row-hub-1')).toBeTruthy()
      expect(screen.getByText('Retro Theme')).toBeTruthy()
    })
  })

  it('hub download action calls hubDownloadThemePost and applyImport', async () => {
    vialAPI.hubListThemePosts.mockResolvedValueOnce({
      success: true,
      data: {
        items: [
          { id: 'hub-2', name: 'Dark Pro', version: '1.0', uploaderName: null, createdAt: '', updatedAt: '' },
        ],
      },
    })
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-tab-hub'))
    fireEvent.change(screen.getByTestId('theme-packs-search-input'), { target: { value: 'dark' } })
    fireEvent.click(screen.getByTestId('theme-packs-search-button'))
    await waitFor(() => expect(screen.getByTestId('theme-packs-hub-download-hub-2')).toBeTruthy())
    fireEvent.click(screen.getByTestId('theme-packs-hub-download-hub-2'))
    await waitFor(() => expect(vialAPI.hubDownloadThemePost).toHaveBeenCalledWith('hub-2'))
    await waitFor(() => expect(applyImport).toHaveBeenCalled())
  })

  it('hub row shows installed label when pack is already installed', async () => {
    metas = [meta({ id: 'local1', name: 'Existing', hubPostId: 'hub-3' })]
    vialAPI.hubListThemePosts.mockResolvedValueOnce({
      success: true,
      data: {
        items: [
          { id: 'hub-3', name: 'Existing', version: '1.0', uploaderName: null, createdAt: '', updatedAt: '' },
        ],
      },
    })
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-tab-hub'))
    fireEvent.change(screen.getByTestId('theme-packs-search-input'), { target: { value: 'exist' } })
    fireEvent.click(screen.getByTestId('theme-packs-search-button'))
    await waitFor(() => expect(screen.getByTestId('theme-packs-hub-row-hub-3')).toBeTruthy())
    const row = screen.getByTestId('theme-packs-hub-row-hub-3')
    expect(row.querySelector('span.text-xs.text-content-muted')?.textContent).toBe('common.installed')
    expect(screen.queryByTestId('theme-packs-hub-download-hub-3')).toBeNull()
  })

  it('hub empty message when search returns no results', async () => {
    vialAPI.hubListThemePosts.mockResolvedValueOnce({
      success: true,
      data: { items: [] },
    })
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-tab-hub'))
    fireEvent.change(screen.getByTestId('theme-packs-search-input'), { target: { value: 'zzz' } })
    fireEvent.click(screen.getByTestId('theme-packs-search-button'))
    await waitFor(() => {
      expect(screen.getByTestId('theme-packs-hub-empty')).toBeTruthy()
      expect(screen.getByText('themePacks.hubEmpty')).toBeTruthy()
    })
  })

  it('hub initial hint when no search has been performed', () => {
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-tab-hub'))
    expect(screen.getByTestId('theme-packs-hub-empty')).toBeTruthy()
    expect(screen.getByText('common.findOnHubHint')).toBeTruthy()
  })

  it('preview button calls hubDownloadThemePost', async () => {
    vialAPI.hubListThemePosts.mockResolvedValueOnce({
      success: true,
      data: {
        items: [
          { id: 'hub-p', name: 'Preview Pack', version: '1.0', uploaderName: null, createdAt: '', updatedAt: '' },
        ],
      },
    })
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-tab-hub'))
    fireEvent.change(screen.getByTestId('theme-packs-search-input'), { target: { value: 'preview' } })
    fireEvent.click(screen.getByTestId('theme-packs-search-button'))
    await waitFor(() => expect(screen.getByTestId('theme-packs-hub-preview-hub-p')).toBeTruthy())
    fireEvent.click(screen.getByTestId('theme-packs-hub-preview-hub-p'))
    await waitFor(() => expect(vialAPI.hubDownloadThemePost).toHaveBeenCalledWith('hub-p'))
  })

  it('upload action calls hubUploadThemePost', async () => {
    metas = [meta({ id: 'u1', name: 'Upload Me' })]
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} hubCanWrite />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-upload-u1'))
    await waitFor(() => expect(vialAPI.themePackGet).toHaveBeenCalledWith('u1'))
    await waitFor(() => expect(vialAPI.hubUploadThemePost).toHaveBeenCalled())
  })

  it('update action calls hubUpdateThemePost', async () => {
    metas = [meta({ id: 'up1', name: 'Update Me', hubPostId: 'hp-up1' })]
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} hubCanWrite />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-update-up1'))
    await waitFor(() => expect(vialAPI.themePackGet).toHaveBeenCalledWith('up1'))
    await waitFor(() => expect(vialAPI.hubUpdateThemePost).toHaveBeenCalled())
  })

  it('sync action calls hubDownloadThemePost and applyImport', async () => {
    metas = [meta({ id: 'sy1', name: 'Sync Me', hubPostId: 'hp-sy1' })]
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} hubCanWrite={false} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-sync-sy1'))
    await waitFor(() => expect(vialAPI.hubDownloadThemePost).toHaveBeenCalledWith('hp-sy1'))
    await waitFor(() => expect(applyImport).toHaveBeenCalled())
  })

  it('remove action asks for confirmation', async () => {
    metas = [meta({ id: 'rm1', name: 'Remove Me', hubPostId: 'hp-rm1' })]
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} hubCanWrite />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-remove-rm1'))
    expect(screen.getByTestId('theme-packs-confirm-remove-rm1')).toBeTruthy()
    expect(screen.getByTestId('theme-packs-cancel-remove-rm1')).toBeTruthy()
  })

  it('confirmed remove calls hubDeleteThemePost', async () => {
    metas = [meta({ id: 'rm2', name: 'Remove Me', hubPostId: 'hp-rm2' })]
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} hubCanWrite />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-remove-rm2'))
    fireEvent.click(screen.getByTestId('theme-packs-confirm-remove-rm2'))
    await waitFor(() => expect(vialAPI.hubDeleteThemePost).toHaveBeenCalledWith('hp-rm2', 'rm2'))
  })

  it('cancel remove hides the confirmation', () => {
    metas = [meta({ id: 'rm3', name: 'Remove Me', hubPostId: 'hp-rm3' })]
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} hubCanWrite />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-remove-rm3'))
    fireEvent.click(screen.getByTestId('theme-packs-cancel-remove-rm3'))
    expect(screen.queryByTestId('theme-packs-confirm-remove-rm3')).toBeNull()
  })

  it('error display shows actionError', async () => {
    vialAPI.hubListThemePosts.mockResolvedValueOnce({
      success: false,
      error: 'Network error',
    })
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-tab-hub'))
    fireEvent.change(screen.getByTestId('theme-packs-search-input'), { target: { value: 'fail' } })
    fireEvent.click(screen.getByTestId('theme-packs-search-button'))
    await waitFor(() => {
      expect(screen.getByTestId('theme-packs-error')).toBeTruthy()
      expect(screen.getByText('Network error')).toBeTruthy()
    })
  })

  it('export error is displayed', async () => {
    metas = [meta({ id: 'e1', name: 'Export Fail' })]
    exportPack.mockResolvedValueOnce({ success: false, error: 'Export failed' })
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-export-e1'))
    await waitFor(() => {
      expect(screen.getByTestId('theme-packs-error')).toBeTruthy()
      expect(screen.getByText('Export failed')).toBeTruthy()
    })
  })

  it('upload shows error result on failure', async () => {
    metas = [meta({ id: 'uf1', name: 'Upload Fail' })]
    vialAPI.themePackGet.mockResolvedValueOnce({ success: false, error: 'Not found' })
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} hubCanWrite />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-upload-uf1'))
    await waitFor(() => {
      expect(screen.getByTestId('theme-packs-result-uf1')).toBeTruthy()
    })
  })

  it('upload button is hidden when hubCanWrite is false', () => {
    metas = [meta({ id: 'nw1', name: 'No Write' })]
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} hubCanWrite={false} />,
    )
    expect(screen.queryByTestId('theme-packs-upload-nw1')).toBeNull()
  })

  it('update and remove buttons are hidden when hubCanWrite is false for hub-linked row', () => {
    metas = [meta({ id: 'nw2', name: 'No Write Hub', hubPostId: 'hp-nw2' })]
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} hubCanWrite={false} />,
    )
    expect(screen.queryByTestId('theme-packs-update-nw2')).toBeNull()
    expect(screen.queryByTestId('theme-packs-remove-nw2')).toBeNull()
    expect(screen.getByTestId('theme-packs-sync-nw2')).toBeTruthy()
  })

  it('update and remove buttons are visible when hubCanWrite is true for hub-linked row', () => {
    metas = [meta({ id: 'w1', name: 'Write Hub', hubPostId: 'hp-w1' })]
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} hubCanWrite />,
    )
    expect(screen.getByTestId('theme-packs-update-w1')).toBeTruthy()
    expect(screen.getByTestId('theme-packs-remove-w1')).toBeTruthy()
    expect(screen.queryByTestId('theme-packs-sync-w1')).toBeNull()
  })

  it('backdrop click calls onClose', () => {
    const onClose = vi.fn()
    render(
      <ThemePacksModal open onClose={onClose} onThemeChange={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-backdrop'))
    expect(onClose).toHaveBeenCalled()
  })

  it('close button calls onClose', () => {
    const onClose = vi.fn()
    render(
      <ThemePacksModal open onClose={onClose} onThemeChange={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-close'))
    expect(onClose).toHaveBeenCalled()
  })

  it('delete also calls hubDeleteThemePost for hub-linked pack', async () => {
    metas = [meta({ id: 'hd1', name: 'Hub Delete', hubPostId: 'hp-hd1' })]
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-delete-hd1'))
    fireEvent.click(screen.getByTestId('theme-packs-confirm-delete-hd1'))
    await waitFor(() => expect(vialAPI.hubDeleteThemePost).toHaveBeenCalledWith('hp-hd1', 'hd1'))
    await waitFor(() => expect(removeFn).toHaveBeenCalledWith('hd1'))
  })

  it('does not fall back to system when deleting a non-active pack', async () => {
    metas = [meta({ id: 'na1', name: 'Not Active' })]
    mockTheme = 'dark'
    const onThemeChange = vi.fn()
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={onThemeChange} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-delete-na1'))
    fireEvent.click(screen.getByTestId('theme-packs-confirm-delete-na1'))
    await waitFor(() => expect(removeFn).toHaveBeenCalledWith('na1'))
    expect(onThemeChange).not.toHaveBeenCalled()
  })

  it('does not treat deleted (tombstoned) metas as installed in hub rows', async () => {
    metas = [meta({ id: 'del1', name: 'Deleted', hubPostId: 'hp-del1', deletedAt: '2026-01-01' })]
    vialAPI.hubListThemePosts.mockResolvedValueOnce({
      success: true,
      data: {
        items: [
          { id: 'hp-del1', name: 'Deleted', version: '1', uploaderName: null, createdAt: '', updatedAt: '' },
        ],
      },
    })
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-tab-hub'))
    fireEvent.change(screen.getByTestId('theme-packs-search-input'), { target: { value: 'deleted' } })
    fireEvent.click(screen.getByTestId('theme-packs-search-button'))
    await waitFor(() => expect(screen.getByTestId('theme-packs-hub-row-hp-del1')).toBeTruthy())
    expect(screen.getByTestId('theme-packs-hub-download-hp-del1')).toBeTruthy()
  })
})
