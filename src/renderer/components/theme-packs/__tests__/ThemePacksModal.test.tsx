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
const reorderFn = vi.fn()

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
    reorder: reorderFn,
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
  uploaderName: string
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
    ...(over.uploaderName ? { uploaderName: over.uploaderName } : {}),
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
    importFromDialog.mockResolvedValue({ canceled: true, files: [] })
    applyImport.mockResolvedValue({ success: true, meta: meta() })
    exportPack.mockResolvedValue({ success: true })
    reorderFn.mockResolvedValue({ success: true })
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

  it('Author column shows the cached uploaderName for a hub-linked pack', () => {
    metas = [meta({ id: 'auth1', name: 'Authored', hubPostId: 'hp-auth1', uploaderName: 'alice' })]
    render(<ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />)
    expect(screen.getByTestId('theme-packs-author-auth1').textContent).toBe('alice')
  })

  it('Author column is blank for a never-uploaded local pack (no uploaderName)', () => {
    metas = [meta({ id: 'local1', name: 'Local Only' })]
    render(<ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />)
    expect(screen.getByTestId('theme-packs-author-local1').textContent).toBe('')
  })

  it('Updated column shows the Hub-side hubUpdatedAt, not the local updatedAt', () => {
    metas = [meta({ id: 'hu1', name: 'Hub Updated', hubPostId: 'hp-hu1', hubUpdatedAt: '2026-05-01T00:00:00.000Z' })]
    render(<ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />)
    expect(screen.getByTestId('theme-packs-timestamp-hu1').textContent).not.toBe('')
  })

  it('Updated column is blank for a pack with no hubUpdatedAt (legacy row or never uploaded)', () => {
    metas = [meta({ id: 'legacy1', name: 'Legacy' })]
    render(<ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />)
    expect(screen.getByTestId('theme-packs-timestamp-legacy1').textContent).toBe('')
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
    importFromDialog.mockResolvedValueOnce({ canceled: false, files: [{ filePath: 'test.json', raw }] })
    applyImport.mockResolvedValueOnce({ success: true, meta: meta({ id: 'new1', name: 'Imported' }) })
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-import-button'))
    await waitFor(() => expect(applyImport).toHaveBeenCalledWith(raw))
  })

  it('import shows error on parse failure', async () => {
    importFromDialog.mockResolvedValueOnce({ canceled: false, files: [{ filePath: 'bad.json', parseError: 'Bad format' }] })
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-import-button'))
    await waitFor(() => {
      expect(screen.getByTestId('theme-packs-error').textContent).toContain('Bad format')
    })
  })

  it('import with hubPostId auto-syncs to hub', async () => {
    const raw = { name: 'Synced', version: '1', colorScheme: 'dark', colors: {} }
    importFromDialog.mockResolvedValueOnce({ canceled: false, files: [{ filePath: 'test.json', raw }] })
    applyImport.mockResolvedValueOnce({ success: true, meta: meta({ id: 's1', name: 'Synced', hubPostId: 'hp1' }) })
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-import-button'))
    await waitFor(() => expect(vialAPI.hubUpdateThemePost).toHaveBeenCalled())
  })

  // --- Import/download placement + toolbar feedback + auto-scroll ---

  it('asc state: a new import is inserted at its sorted position via reorder', async () => {
    // Already ascending — detected as 'asc' on open, no click needed.
    metas = [meta({ id: 'a', name: 'Alpha' }), meta({ id: 'z', name: 'Zeta' })]
    const raw = { name: 'Mu', version: '1', colorScheme: 'dark', colors: {} }
    importFromDialog.mockResolvedValueOnce({ canceled: false, files: [{ filePath: 'test.json', raw }] })
    applyImport.mockResolvedValueOnce({ success: true, meta: meta({ id: 'm', name: 'Mu' }) })
    render(<ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />)

    fireEvent.click(screen.getByTestId('theme-packs-import-button'))
    await waitFor(() => expect(reorderFn).toHaveBeenCalledWith(['a', 'm', 'z']))
  })

  it('desc state: a new import is inserted at its sorted position via reorder', async () => {
    // Already descending — detected as 'desc' on open, no click needed.
    metas = [meta({ id: 'z', name: 'Zeta' }), meta({ id: 'a', name: 'Alpha' })]
    const raw = { name: 'Mu', version: '1', colorScheme: 'dark', colors: {} }
    importFromDialog.mockResolvedValueOnce({ canceled: false, files: [{ filePath: 'test.json', raw }] })
    applyImport.mockResolvedValueOnce({ success: true, meta: meta({ id: 'm', name: 'Mu' }) })
    render(<ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />)

    fireEvent.click(screen.getByTestId('theme-packs-import-button'))
    await waitFor(() => expect(reorderFn).toHaveBeenCalledWith(['z', 'm', 'a']))
  })

  it('free state (shuffled list): a new import does not call reorder — the store appends it at the bottom on its own', async () => {
    metas = [meta({ id: 'm', name: 'Mu' }), meta({ id: 'z', name: 'Zeta' }), meta({ id: 'a', name: 'Alpha' })]
    const raw = { name: 'Beta', version: '1', colorScheme: 'dark', colors: {} }
    importFromDialog.mockResolvedValueOnce({ canceled: false, files: [{ filePath: 'test.json', raw }] })
    applyImport.mockResolvedValueOnce({ success: true, meta: meta({ id: 'b', name: 'Beta' }) })
    render(<ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />)

    fireEvent.click(screen.getByTestId('theme-packs-import-button'))
    await waitFor(() => expect(applyImport).toHaveBeenCalled())
    expect(reorderFn).not.toHaveBeenCalled()
  })

  it('overwrite (same id already installed) keeps its position — no reorder call, "Updated" feedback', async () => {
    metas = [meta({ id: 'a', name: 'Alpha' }), meta({ id: 'z', name: 'Zeta' })]
    const raw = { name: 'Alpha', version: '1', colorScheme: 'dark', colors: {} }
    importFromDialog.mockResolvedValueOnce({ canceled: false, files: [{ filePath: 'test.json', raw }] })
    // Overwrite: the store reuses the existing 'a' id.
    applyImport.mockResolvedValueOnce({ success: true, meta: meta({ id: 'a', name: 'Alpha' }) })
    render(<ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />)

    fireEvent.click(screen.getByTestId('theme-packs-import-button'))
    await waitFor(() => expect(applyImport).toHaveBeenCalled())
    expect(reorderFn).not.toHaveBeenCalled()
    expect(screen.getByTestId('theme-packs-import-feedback').textContent).toBe('common.updatedNamed:Alpha')
  })

  it('new import shows "Imported {{name}}" feedback next to the Name button', async () => {
    metas = [meta({ id: 'a', name: 'Alpha' })]
    const raw = { name: 'Beta', version: '1', colorScheme: 'dark', colors: {} }
    importFromDialog.mockResolvedValueOnce({ canceled: false, files: [{ filePath: 'test.json', raw }] })
    applyImport.mockResolvedValueOnce({ success: true, meta: meta({ id: 'b', name: 'Beta' }) })
    render(<ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />)

    fireEvent.click(screen.getByTestId('theme-packs-import-button'))
    await waitFor(() => expect(screen.getByTestId('theme-packs-import-feedback').textContent).toBe('common.importedNamed:Beta'))
  })

  it('scrolls the imported row into view', async () => {
    metas = [meta({ id: 'a', name: 'Alpha' })]
    const raw = { name: 'Beta', version: '1', colorScheme: 'dark', colors: {} }
    importFromDialog.mockResolvedValueOnce({ canceled: false, files: [{ filePath: 'test.json', raw }] })
    const newMeta = meta({ id: 'b', name: 'Beta' })
    applyImport.mockImplementationOnce(async () => {
      metas = [...metas, newMeta]
      return { success: true, meta: newMeta }
    })
    render(<ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />)

    await waitFor(() => expect(screen.getByTestId('theme-packs-row-a')).toBeTruthy())
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    try {
      fireEvent.click(screen.getByTestId('theme-packs-import-button'))
      await waitFor(() => expect(screen.getByTestId('theme-packs-row-b')).toBeTruthy())
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' }))
    } finally {
      scrollIntoView.mockRestore()
    }
  })

  it('multi-file import: every selected file is saved and each row gets its own "Saved" badge', async () => {
    metas = [meta({ id: 'a', name: 'Alpha' })]
    const rawB = { name: 'Beta', version: '1', colorScheme: 'dark', colors: {} }
    const rawC = { name: 'Gamma', version: '1', colorScheme: 'dark', colors: {} }
    importFromDialog.mockResolvedValueOnce({
      canceled: false,
      files: [
        { filePath: 'beta.json', raw: rawB },
        { filePath: 'gamma.json', raw: rawC },
      ],
    })
    const metaB = meta({ id: 'b', name: 'Beta' })
    const metaC = meta({ id: 'c', name: 'Gamma' })
    // The mocked store doesn't simulate a metas re-fetch on its own —
    // append each new meta by hand so both rows actually render, the
    // way a real `refresh()` would after each `applyImport` call.
    applyImport
      .mockImplementationOnce(async () => {
        metas = [...metas, metaB]
        return { success: true, meta: metaB }
      })
      .mockImplementationOnce(async () => {
        metas = [...metas, metaC]
        return { success: true, meta: metaC }
      })
    render(<ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />)

    fireEvent.click(screen.getByTestId('theme-packs-import-button'))
    await waitFor(() => expect(screen.getByTestId('theme-packs-result-b').textContent).toBe('common.saved'))
    expect(screen.getByTestId('theme-packs-result-c').textContent).toBe('common.saved')
  })

  it('partial-failure batch: the good file keeps its badge while the bad file is aggregated into one banner', async () => {
    metas = [meta({ id: 'a', name: 'Alpha' })]
    const rawGood = { name: 'Good Theme', version: '1', colorScheme: 'dark', colors: {} }
    const rawBad = { name: 'Bad Theme', version: '1', colorScheme: 'dark', colors: {} }
    importFromDialog.mockResolvedValueOnce({
      canceled: false,
      files: [
        { filePath: 'bad.json', raw: rawBad },
        { filePath: 'good.json', raw: rawGood },
      ],
    })
    const goodMeta = meta({ id: 'g', name: 'Good Theme' })
    applyImport
      .mockResolvedValueOnce({ success: false, error: 'Invalid theme colors' })
      .mockImplementationOnce(async () => {
        metas = [...metas, goodMeta]
        return { success: true, meta: goodMeta }
      })
    render(<ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />)

    fireEvent.click(screen.getByTestId('theme-packs-import-button'))
    await waitFor(() => expect(screen.getByTestId('theme-packs-result-g').textContent).toBe('common.saved'))

    const banner = screen.getByTestId('theme-packs-error')
    expect(banner.textContent).toContain('bad.json')
    expect(banner.textContent).toContain('Invalid theme colors')
  })

  it('P1 fix: importing files that interleave with existing rows (existing A,D; import B,C) lands fully sorted A,B,C,D in one reorder call', async () => {
    metas = [meta({ id: 'a', name: 'Alpha' }), meta({ id: 'd', name: 'Delta' })]
    const rawB = { name: 'Beta', version: '1', colorScheme: 'dark', colors: {} }
    const rawC = { name: 'Charlie', version: '1', colorScheme: 'dark', colors: {} }
    importFromDialog.mockResolvedValueOnce({
      canceled: false,
      files: [
        { filePath: 'beta.json', raw: rawB },
        { filePath: 'charlie.json', raw: rawC },
      ],
    })
    const metaB = meta({ id: 'b', name: 'Beta' })
    const metaC = meta({ id: 'c', name: 'Charlie' })
    applyImport
      .mockResolvedValueOnce({ success: true, meta: metaB })
      .mockResolvedValueOnce({ success: true, meta: metaC })
    render(<ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />)

    fireEvent.click(screen.getByTestId('theme-packs-import-button'))
    await waitFor(() => expect(reorderFn).toHaveBeenCalled())
    // Without the fix, Charlie's position would be computed against a
    // stale [Alpha, Delta] snapshot that never saw Beta's insert,
    // persisting ['a', 'c', 'd'] and silently dropping Beta.
    expect(reorderFn).toHaveBeenCalledTimes(1)
    expect(reorderFn).toHaveBeenCalledWith(['a', 'b', 'c', 'd'])
  })

  it('hub-sync failure after import is reported against the originating filename, not the pack name (P2a)', async () => {
    metas = [meta({ id: 'a', name: 'Alpha' })]
    const raw = { name: 'Existing Pack', version: '1', colorScheme: 'dark', colors: {} }
    importFromDialog.mockResolvedValueOnce({
      canceled: false,
      files: [{ filePath: 'my-upload.json', raw }],
    })
    const savedMeta = meta({ id: 'e', name: 'Existing Pack', hubPostId: 'hub-1' })
    applyImport.mockResolvedValueOnce({ success: true, meta: savedMeta })
    vialAPI.hubUpdateThemePost.mockResolvedValueOnce({ success: false, error: 'network error' })
    render(<ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />)

    fireEvent.click(screen.getByTestId('theme-packs-import-button'))
    await waitFor(() => {
      expect(screen.getByTestId('theme-packs-error')).toBeTruthy()
    })
    const banner = screen.getByTestId('theme-packs-error')
    expect(banner.textContent).toContain('my-upload.json')
    expect(banner.textContent).toContain('network error')
  })

  it('hub download parity: a new Hub download is inserted at its sorted position via reorder', async () => {
    // Already ascending — detected as 'asc' on open, no click needed.
    metas = [meta({ id: 'a', name: 'Alpha' }), meta({ id: 'z', name: 'Zeta' })]
    vialAPI.hubDownloadThemePost.mockResolvedValueOnce({ success: true, data: { name: 'Mu', version: '1', colorScheme: 'dark', colors: {} } })
    applyImport.mockResolvedValueOnce({ success: true, meta: meta({ id: 'm', name: 'Mu' }) })
    render(<ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />)

    fireEvent.click(screen.getByTestId('theme-packs-tab-hub'))
    await waitFor(() => expect(screen.getByTestId('theme-packs-search-input')).toBeTruthy())
    fireEvent.change(screen.getByTestId('theme-packs-search-input'), { target: { value: 'mu' } })
    vialAPI.hubListThemePosts.mockResolvedValueOnce({ success: true, data: { items: [{ id: 'hub-m', name: 'Mu', version: '1', uploaderName: 'someone' }] } })
    fireEvent.click(screen.getByTestId('theme-packs-search-button'))
    await waitFor(() => expect(screen.getByTestId('theme-packs-hub-download-hub-m')).toBeTruthy())

    fireEvent.click(screen.getByTestId('theme-packs-hub-download-hub-m'))
    await waitFor(() => expect(reorderFn).toHaveBeenCalledWith(['a', 'm', 'z']))
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
    await act(async () => { fireEvent.click(screen.getByTestId('theme-packs-tab-hub')) })
    vialAPI.hubListThemePosts.mockClear()
    await act(async () => {
      fireEvent.change(screen.getByTestId('theme-packs-search-input'), { target: { value: 'neon' } })
    })
    expect(vialAPI.hubListThemePosts).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(300) })
    vi.useRealTimers()
    await waitFor(() => expect(vialAPI.hubListThemePosts).toHaveBeenCalledWith({ q: 'neon' }))
  })

  it('shows hub results after search returns items', async () => {
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-tab-hub'))
    await waitFor(() => expect(vialAPI.hubListThemePosts).toHaveBeenCalledWith({ q: '' }))
    vialAPI.hubListThemePosts.mockResolvedValueOnce({
      success: true,
      data: {
        items: [
          { id: 'hub-1', name: 'Retro Theme', version: '2.0', uploaderName: 'alice', createdAt: '', updatedAt: '' },
        ],
      },
    })
    fireEvent.change(screen.getByTestId('theme-packs-search-input'), { target: { value: 'retro' } })
    fireEvent.click(screen.getByTestId('theme-packs-search-button'))
    await waitFor(() => {
      expect(screen.getByTestId('theme-packs-hub-row-hub-1')).toBeTruthy()
      expect(screen.getByText('Retro Theme')).toBeTruthy()
    })
  })

  it('hub download action calls hubDownloadThemePost and applyImport', async () => {
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-tab-hub'))
    await waitFor(() => expect(vialAPI.hubListThemePosts).toHaveBeenCalledWith({ q: '' }))
    vialAPI.hubListThemePosts.mockResolvedValueOnce({
      success: true,
      data: {
        items: [
          { id: 'hub-2', name: 'Dark Pro', version: '1.0', uploaderName: null, createdAt: '', updatedAt: '' },
        ],
      },
    })
    fireEvent.change(screen.getByTestId('theme-packs-search-input'), { target: { value: 'dark' } })
    fireEvent.click(screen.getByTestId('theme-packs-search-button'))
    await waitFor(() => expect(screen.getByTestId('theme-packs-hub-download-hub-2')).toBeTruthy())
    fireEvent.click(screen.getByTestId('theme-packs-hub-download-hub-2'))
    await waitFor(() => expect(vialAPI.hubDownloadThemePost).toHaveBeenCalledWith('hub-2'))
    await waitFor(() => expect(applyImport).toHaveBeenCalled())
  })

  it('hub row shows installed label when pack is already installed', async () => {
    metas = [meta({ id: 'local1', name: 'Existing', hubPostId: 'hub-3' })]
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-tab-hub'))
    await waitFor(() => expect(vialAPI.hubListThemePosts).toHaveBeenCalledWith({ q: '' }))
    vialAPI.hubListThemePosts.mockResolvedValueOnce({
      success: true,
      data: {
        items: [
          { id: 'hub-3', name: 'Existing', version: '1.0', uploaderName: null, createdAt: '', updatedAt: '' },
        ],
      },
    })
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
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-tab-hub'))
    await waitFor(() => expect(vialAPI.hubListThemePosts).toHaveBeenCalledWith({ q: '' }))
    vialAPI.hubListThemePosts.mockResolvedValueOnce({
      success: true,
      data: {
        items: [
          { id: 'hub-p', name: 'Preview Pack', version: '1.0', uploaderName: null, createdAt: '', updatedAt: '' },
        ],
      },
    })
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
    metas = [meta({ id: 'up1', name: 'Update Me', hubPostId: 'hp-up1', uploaderName: 'me' })]
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} hubCanWrite currentDisplayName="me" />,
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

  it('sync refreshes uploaderName/hubUpdatedAt via a name-matched Hub list lookup (Phase 3)', async () => {
    metas = [meta({ id: 'sy2', name: 'Sync Me', hubPostId: 'hp-sy2' })]
    vialAPI.hubDownloadThemePost.mockResolvedValueOnce({
      success: true,
      data: { name: 'Sync Me', version: '1', colorScheme: 'dark', colors: {} },
    })
    vialAPI.hubListThemePosts.mockResolvedValueOnce({
      success: true,
      data: { items: [{ id: 'hp-sy2', name: 'Sync Me', version: '1', uploaderName: 'alice', updatedAt: '2026-05-02T00:00:00.000Z' }] },
    })
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} hubCanWrite={false} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-sync-sy2'))
    await waitFor(() => expect(vialAPI.hubListThemePosts).toHaveBeenCalledWith({ name: 'Sync Me' }))
    await waitFor(() => expect(applyImport).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ uploaderName: 'alice', hubUpdatedAt: '2026-05-02T00:00:00.000Z' }),
    ))
  })

  it('remove action asks for confirmation', async () => {
    metas = [meta({ id: 'rm1', name: 'Remove Me', hubPostId: 'hp-rm1', uploaderName: 'me' })]
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} hubCanWrite currentDisplayName="me" />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-remove-rm1'))
    expect(screen.getByTestId('theme-packs-confirm-remove-rm1')).toBeTruthy()
    expect(screen.getByTestId('theme-packs-cancel-remove-rm1')).toBeTruthy()
  })

  it('confirmed remove calls hubDeleteThemePost', async () => {
    metas = [meta({ id: 'rm2', name: 'Remove Me', hubPostId: 'hp-rm2', uploaderName: 'me' })]
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} hubCanWrite currentDisplayName="me" />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-remove-rm2'))
    fireEvent.click(screen.getByTestId('theme-packs-confirm-remove-rm2'))
    await waitFor(() => expect(vialAPI.hubDeleteThemePost).toHaveBeenCalledWith('hp-rm2', 'rm2'))
  })

  it('cancel remove hides the confirmation', () => {
    metas = [meta({ id: 'rm3', name: 'Remove Me', hubPostId: 'hp-rm3', uploaderName: 'me' })]
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} hubCanWrite currentDisplayName="me" />,
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

  it('update and remove buttons are visible when hubCanWrite is true and the row is mine (isMine gate, Phase 3)', () => {
    metas = [meta({ id: 'w1', name: 'Write Hub', hubPostId: 'hp-w1', uploaderName: 'me' })]
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} hubCanWrite currentDisplayName="me" />,
    )
    expect(screen.getByTestId('theme-packs-update-w1')).toBeTruthy()
    expect(screen.getByTestId('theme-packs-remove-w1')).toBeTruthy()
    expect(screen.queryByTestId('theme-packs-sync-w1')).toBeNull()
  })

  it('shows Sync instead of Update/Remove for a hub-linked row uploaded by someone else, even with hubCanWrite (isMine gate, Phase 3)', () => {
    metas = [meta({ id: 'foreign1', name: 'Foreign Pack', hubPostId: 'hp-foreign1', uploaderName: 'someone-else' })]
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} hubCanWrite currentDisplayName="me" />,
    )
    expect(screen.queryByTestId('theme-packs-update-foreign1')).toBeNull()
    expect(screen.queryByTestId('theme-packs-remove-foreign1')).toBeNull()
    expect(screen.getByTestId('theme-packs-sync-foreign1')).toBeTruthy()
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

  it('delete cascades to Hub for a pack the user owns', async () => {
    metas = [meta({ id: 'hd1', name: 'Hub Delete', hubPostId: 'hp-hd1', uploaderName: 'me' })]
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} currentDisplayName="me" />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-delete-hd1'))
    fireEvent.click(screen.getByTestId('theme-packs-confirm-delete-hd1'))
    await waitFor(() => expect(vialAPI.hubDeleteThemePost).toHaveBeenCalledWith('hp-hd1', 'hd1'))
    await waitFor(() => expect(removeFn).toHaveBeenCalledWith('hd1'))
  })

  it('blocks the local delete and surfaces an error when hubDeleteThemePost fails for an owned pack, leaving the entry intact', async () => {
    metas = [meta({ id: 'hd2', name: 'Hub Delete Fail', hubPostId: 'hp-hd2', uploaderName: 'me' })]
    vialAPI.hubDeleteThemePost.mockResolvedValueOnce({ success: false, error: 'Hub rejected the delete' })
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} currentDisplayName="me" />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-delete-hd2'))
    fireEvent.click(screen.getByTestId('theme-packs-confirm-delete-hd2'))
    await waitFor(() => expect(vialAPI.hubDeleteThemePost).toHaveBeenCalledWith('hp-hd2', 'hd2'))
    await waitFor(() => expect(screen.getByTestId('theme-packs-result-hd2').textContent).toBe('Hub rejected the delete'))
    // A failed cascade must not proceed to the local delete — otherwise
    // the Hub post is orphaned under a name nobody can re-upload.
    expect(removeFn).not.toHaveBeenCalled()
    expect(screen.queryByTestId('theme-packs-confirm-delete-hd2')).toBeNull()
  })

  // --- regression: Delete must not cascade to Hub for packs the user
  // does not own (fix/delete-ownership-gate). A downloaded pack also
  // carries hubPostId (for Sync/freshness linkage) but is never
  // deletable on Hub by this user — the old code attempted the Hub
  // delete regardless of ownership, which failed for a foreign post
  // (or a deactivated uploader account) and then blocked the local
  // delete too, leaving the user unable to remove a downloaded pack at
  // all. See KeyLabelsModal / LanguagePacksModal for the same pattern. ---

  it('a pack downloaded from someone else deletes locally only — no Hub call at all (THE regression)', async () => {
    metas = [meta({ id: 'foreign-del', name: 'Foreign Pack', hubPostId: 'hp-foreign-del', uploaderName: 'pipette' })]
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} currentDisplayName="me" />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-delete-foreign-del'))
    fireEvent.click(screen.getByTestId('theme-packs-confirm-delete-foreign-del'))
    await waitFor(() => expect(removeFn).toHaveBeenCalledWith('foreign-del'))
    expect(vialAPI.hubDeleteThemePost).not.toHaveBeenCalled()
  })

  it('a legacy hub-linked pack with no cached uploaderName deletes locally only (conservative default, matches Update/Remove gating)', async () => {
    metas = [meta({ id: 'legacy-del', name: 'Legacy Hub Pack', hubPostId: 'hp-legacy-del' })]
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} currentDisplayName="me" />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-delete-legacy-del'))
    fireEvent.click(screen.getByTestId('theme-packs-confirm-delete-legacy-del'))
    await waitFor(() => expect(removeFn).toHaveBeenCalledWith('legacy-del'))
    expect(vialAPI.hubDeleteThemePost).not.toHaveBeenCalled()
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
    render(
      <ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-tab-hub'))
    await waitFor(() => expect(vialAPI.hubListThemePosts).toHaveBeenCalledWith({ q: '' }))
    vialAPI.hubListThemePosts.mockResolvedValueOnce({
      success: true,
      data: {
        items: [
          { id: 'hp-del1', name: 'Deleted', version: '1', uploaderName: null, createdAt: '', updatedAt: '' },
        ],
      },
    })
    fireEvent.change(screen.getByTestId('theme-packs-search-input'), { target: { value: 'deleted' } })
    fireEvent.click(screen.getByTestId('theme-packs-search-button'))
    await waitFor(() => expect(screen.getByTestId('theme-packs-hub-row-hp-del1')).toBeTruthy())
    expect(screen.getByTestId('theme-packs-hub-download-hp-del1')).toBeTruthy()
  })

  // --- Phase 2: drag reorder + Name sort -----------------------------------

  it('renders a drag grip for every installed pack row', () => {
    metas = [meta({ id: 'p1', name: 'My Theme' })]
    render(<ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />)
    expect(screen.getByTestId('theme-packs-grip-p1')).toBeTruthy()
    const row = screen.getByTestId('theme-packs-row-p1')
    expect(row.getAttribute('draggable')).toBe('true')
  })

  it('dragging a pack row persists the new order via store.reorder', async () => {
    metas = [meta({ id: 'p1', name: 'Alpha' }), meta({ id: 'p2', name: 'Beta' })]
    render(<ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />)
    const rowA = screen.getByTestId('theme-packs-row-p1')
    const rowB = screen.getByTestId('theme-packs-row-p2')

    fireEvent.dragStart(rowA, { dataTransfer: { effectAllowed: '', setData: vi.fn() } })
    fireEvent.dragOver(rowB)
    fireEvent.dragEnd(rowA)

    await waitFor(() => expect(reorderFn).toHaveBeenCalledWith(['p2', 'p1']))
  })

  it('the Name sort button sorts installed packs ascending on first click', async () => {
    metas = [meta({ id: 'z', name: 'Zeta' }), meta({ id: 'a', name: 'Alpha' })]
    render(<ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />)
    fireEvent.click(screen.getByTestId('theme-packs-sort-button'))
    await waitFor(() => expect(reorderFn).toHaveBeenCalledWith(['a', 'z']))
  })

  it('a second click on the Name sort button reverses the order', async () => {
    metas = [meta({ id: 'z', name: 'Zeta' }), meta({ id: 'a', name: 'Alpha' })]
    render(<ThemePacksModal open onClose={vi.fn()} onThemeChange={vi.fn()} />)
    fireEvent.click(screen.getByTestId('theme-packs-sort-button'))
    await waitFor(() => expect(reorderFn).toHaveBeenCalledWith(['a', 'z']))
    fireEvent.click(screen.getByTestId('theme-packs-sort-button'))
    await waitFor(() => expect(reorderFn).toHaveBeenLastCalledWith(['z', 'a']))
  })
})
