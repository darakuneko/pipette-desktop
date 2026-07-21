// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (params && 'name' in params) return `${key}:${String(params.name)}`
      // Surfaces the toolbar import summary's success/failure counts so
      // tests can assert on them without a real i18next pluralization
      // pipeline.
      if (params && 'success' in params && 'failure' in params) {
        return `${key}:${String(params.count)}:${String(params.success)}:${String(params.failure)}`
      }
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
const reorderFn = vi.fn()

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
    reorder: reorderFn,
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
  uploaderName: string
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
    ...(over.uploaderName ? { uploaderName: over.uploaderName } : {}),
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
    reorderFn.mockResolvedValue({ success: true })
    importFromDialog.mockResolvedValue({ canceled: true, files: [] })
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
    importFromDialog.mockResolvedValueOnce({ canceled: false, files: [{ filePath: 'test.json', raw }] })
    applyImport.mockResolvedValueOnce({ success: true, meta: meta({ id: 'imp1', name: 'Imported' }) })
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('language-packs-import-button'))
    await waitFor(() => expect(applyImport).toHaveBeenCalled())
  })

  it('import shows error on parse failure, using the actual parseError message (P2b)', async () => {
    importFromDialog.mockResolvedValueOnce({ canceled: false, files: [{ filePath: 'bad.json', parseError: 'EACCES: permission denied' }] })
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('language-packs-import-button'))
    await waitFor(() => {
      expect(screen.getByTestId('language-packs-error')).toBeTruthy()
    })
    // The real read/parse error is surfaced verbatim — not replaced by
    // the generic "invalid JSON" placeholder, which would be wrong for
    // e.g. a permission error.
    expect(screen.getByTestId('language-packs-error').textContent).toContain('EACCES: permission denied')
    expect(screen.getByTestId('language-packs-error').textContent).toContain('bad.json')
  })

  it('import shows error for invalid pack validation', async () => {
    const raw = { name: 'Bad', version: 'not-semver', __invalid: true }
    importFromDialog.mockResolvedValueOnce({ canceled: false, files: [{ filePath: 'test.json', raw }] })
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
    importFromDialog.mockResolvedValueOnce({ canceled: false, files: [{ filePath: 'test.json', raw }] })
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
    importFromDialog.mockResolvedValueOnce({ canceled: false, files: [{ filePath: 'test.json', raw }] })
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

  // --- Import/download placement + toolbar feedback + auto-scroll ---

  it('asc state: a new import is inserted at its sorted position via reorder', async () => {
    // Already ascending — detected as 'asc' on open, no click needed.
    storeMetas = [
      meta({ id: 'a', name: 'Alpha', matchedBaseVersion: '0.1.0' }),
      meta({ id: 'z', name: 'Zeta', matchedBaseVersion: '0.1.0' }),
    ]
    const raw = { name: 'Mu', version: '0.1.0', common: {} }
    importFromDialog.mockResolvedValueOnce({ canceled: false, files: [{ filePath: 'test.json', raw }] })
    applyImport.mockResolvedValueOnce({ success: true, meta: meta({ id: 'm', name: 'Mu' }) })
    render(<LanguagePacksModal open onClose={vi.fn()} />)

    fireEvent.click(screen.getByTestId('language-packs-import-button'))
    await waitFor(() => expect(reorderFn).toHaveBeenCalledWith(['a', 'm', 'z']))
  })

  it('desc state: a new import is inserted at its sorted position via reorder', async () => {
    // Already descending — detected as 'desc' on open, no click needed.
    storeMetas = [
      meta({ id: 'z', name: 'Zeta', matchedBaseVersion: '0.1.0' }),
      meta({ id: 'a', name: 'Alpha', matchedBaseVersion: '0.1.0' }),
    ]
    const raw = { name: 'Mu', version: '0.1.0', common: {} }
    importFromDialog.mockResolvedValueOnce({ canceled: false, files: [{ filePath: 'test.json', raw }] })
    applyImport.mockResolvedValueOnce({ success: true, meta: meta({ id: 'm', name: 'Mu' }) })
    render(<LanguagePacksModal open onClose={vi.fn()} />)

    fireEvent.click(screen.getByTestId('language-packs-import-button'))
    await waitFor(() => expect(reorderFn).toHaveBeenCalledWith(['z', 'm', 'a']))
  })

  it('free state (shuffled list): a new import does not call reorder — the store appends it at the bottom on its own', async () => {
    storeMetas = [
      meta({ id: 'm', name: 'Mu', matchedBaseVersion: '0.1.0' }),
      meta({ id: 'z', name: 'Zeta', matchedBaseVersion: '0.1.0' }),
      meta({ id: 'a', name: 'Alpha', matchedBaseVersion: '0.1.0' }),
    ]
    const raw = { name: 'Beta', version: '0.1.0', common: {} }
    importFromDialog.mockResolvedValueOnce({ canceled: false, files: [{ filePath: 'test.json', raw }] })
    applyImport.mockResolvedValueOnce({ success: true, meta: meta({ id: 'b', name: 'Beta' }) })
    render(<LanguagePacksModal open onClose={vi.fn()} />)

    fireEvent.click(screen.getByTestId('language-packs-import-button'))
    await waitFor(() => expect(applyImport).toHaveBeenCalled())
    expect(reorderFn).not.toHaveBeenCalled()
  })

  it('overwrite (same id already installed) keeps its position — no reorder call, "Updated" feedback', async () => {
    storeMetas = [
      meta({ id: 'a', name: 'Alpha', matchedBaseVersion: '0.1.0' }),
      meta({ id: 'z', name: 'Zeta', matchedBaseVersion: '0.1.0' }),
    ]
    const raw = { name: 'Alpha', version: '0.1.0', common: {} }
    importFromDialog.mockResolvedValueOnce({ canceled: false, files: [{ filePath: 'test.json', raw }] })
    // Overwrite: the store reuses the existing 'a' id.
    applyImport.mockResolvedValueOnce({ success: true, meta: meta({ id: 'a', name: 'Alpha' }) })
    render(<LanguagePacksModal open onClose={vi.fn()} />)

    fireEvent.click(screen.getByTestId('language-packs-import-button'))
    await waitFor(() => expect(applyImport).toHaveBeenCalled())
    expect(reorderFn).not.toHaveBeenCalled()
    expect(screen.getByTestId('language-packs-import-feedback').textContent).toBe('common.updatedNamed:Alpha')
  })

  it('new import shows "Imported {{name}}" feedback next to the Name button, and it auto-clears after ~5s', async () => {
    // `waitFor`'s own internal polling relies on real timers, so this
    // uses `vi.advanceTimersByTimeAsync` (which flushes pending
    // microtasks/promises between ticks) instead of `waitFor` once fake
    // timers are active — the auto-clear timer itself is already
    // exercised precisely in useImportFeedback.test.ts.
    vi.useFakeTimers()
    try {
      storeMetas = [meta({ id: 'a', name: 'Alpha', matchedBaseVersion: '0.1.0' })]
      const raw = { name: 'Beta', version: '0.1.0', common: {} }
      importFromDialog.mockResolvedValueOnce({ canceled: false, files: [{ filePath: 'test.json', raw }] })
      applyImport.mockResolvedValueOnce({ success: true, meta: meta({ id: 'b', name: 'Beta' }) })
      render(<LanguagePacksModal open onClose={vi.fn()} />)

      fireEvent.click(screen.getByTestId('language-packs-import-button'))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(screen.getByTestId('language-packs-import-feedback').textContent).toBe('common.importedNamed:Beta')

      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      expect(screen.queryByTestId('language-packs-import-feedback')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a second import replaces the feedback message immediately instead of stacking', async () => {
    storeMetas = [meta({ id: 'a', name: 'Alpha', matchedBaseVersion: '0.1.0' })]
    importFromDialog
      .mockResolvedValueOnce({ canceled: false, files: [{ filePath: 'beta.json', raw: { name: 'Beta', version: '0.1.0', common: {} } }] })
      .mockResolvedValueOnce({ canceled: false, files: [{ filePath: 'gamma.json', raw: { name: 'Gamma', version: '0.1.0', common: {} } }] })
    applyImport
      .mockResolvedValueOnce({ success: true, meta: meta({ id: 'b', name: 'Beta' }) })
      .mockResolvedValueOnce({ success: true, meta: meta({ id: 'g', name: 'Gamma' }) })
    render(<LanguagePacksModal open onClose={vi.fn()} />)

    fireEvent.click(screen.getByTestId('language-packs-import-button'))
    await waitFor(() => expect(screen.getByTestId('language-packs-import-feedback').textContent).toBe('common.importedNamed:Beta'))

    fireEvent.click(screen.getByTestId('language-packs-import-button'))
    await waitFor(() => expect(screen.getByTestId('language-packs-import-feedback').textContent).toBe('common.importedNamed:Gamma'))
  })

  it('scrolls the imported row into view', async () => {
    storeMetas = [meta({ id: 'a', name: 'Alpha', matchedBaseVersion: '0.1.0' })]
    const raw = { name: 'Beta', version: '0.1.0', common: {} }
    importFromDialog.mockResolvedValueOnce({ canceled: false, files: [{ filePath: 'test.json', raw }] })
    // The mocked store doesn't simulate a metas re-fetch on its own —
    // append the new meta to `storeMetas` here so the row actually
    // renders (and can be found by testid) on the next render, the way
    // a real `refresh()` would.
    const newMeta = meta({ id: 'b', name: 'Beta' })
    applyImport.mockImplementationOnce(async () => {
      storeMetas = [...storeMetas, newMeta]
      return { success: true, meta: newMeta }
    })
    render(<LanguagePacksModal open onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByTestId('language-packs-row-a')).toBeTruthy())
    // Row for 'b' does not exist until after the import; spy on the
    // shared prototype method so it's stubbed for whatever row appears
    // with that testid once the import lands.
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    try {
      fireEvent.click(screen.getByTestId('language-packs-import-button'))
      await waitFor(() => expect(screen.getByTestId('language-packs-row-b')).toBeTruthy())
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' }))
    } finally {
      scrollIntoView.mockRestore()
    }
  })

  it('multi-file import: every selected file is saved and each row gets its own "Saved" badge', async () => {
    storeMetas = [meta({ id: 'a', name: 'Alpha', matchedBaseVersion: '0.1.0' })]
    const rawB = { name: 'Beta', version: '0.1.0', common: {} }
    const rawC = { name: 'Gamma', version: '0.1.0', common: {} }
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
        storeMetas = [...storeMetas, metaB]
        return { success: true, meta: metaB }
      })
      .mockImplementationOnce(async () => {
        storeMetas = [...storeMetas, metaC]
        return { success: true, meta: metaC }
      })
    render(<LanguagePacksModal open onClose={vi.fn()} />)

    fireEvent.click(screen.getByTestId('language-packs-import-button'))
    await waitFor(() => expect(screen.getByTestId('language-packs-result-b').textContent).toBe('common.saved'))
    expect(screen.getByTestId('language-packs-result-c').textContent).toBe('common.saved')
  })

  it('multi-file import (2+ files): does not auto-scroll, does not auto-select, and shows the toolbar summary instead of per-name feedback', async () => {
    storeMetas = [meta({ id: 'a', name: 'Alpha', matchedBaseVersion: '0.1.0' })]
    const rawB = { name: 'Beta', version: '0.1.0', common: {} }
    const rawC = { name: 'Gamma', version: '0.1.0', common: {} }
    importFromDialog.mockResolvedValueOnce({
      canceled: false,
      files: [
        { filePath: 'beta.json', raw: rawB },
        { filePath: 'gamma.json', raw: rawC },
      ],
    })
    const metaB = meta({ id: 'b', name: 'Beta' })
    const metaC = meta({ id: 'c', name: 'Gamma' })
    applyImport
      .mockImplementationOnce(async () => {
        storeMetas = [...storeMetas, metaB]
        return { success: true, meta: metaB }
      })
      .mockImplementationOnce(async () => {
        storeMetas = [...storeMetas, metaC]
        return { success: true, meta: metaC }
      })
    render(<LanguagePacksModal open onClose={vi.fn()} />)

    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    try {
      fireEvent.click(screen.getByTestId('language-packs-import-button'))
      await waitFor(() => expect(screen.getByTestId('language-packs-result-c').textContent).toBe('common.saved'))

      // 2+ batch: no auto-scroll to an arbitrary one of the new rows.
      expect(scrollIntoView).not.toHaveBeenCalled()
      // 2+ batch: no auto-activation of an arbitrary one of the new packs.
      expect(mockAppConfigSet).not.toHaveBeenCalled()
      // The toolbar headline supersedes the per-name "Imported {{name}}"
      // feedback for a 2+ batch: 2 processed, both saved, none failed.
      expect(screen.getByTestId('language-packs-import-feedback').textContent).toBe('common.importSummary:2:2:0')
    } finally {
      scrollIntoView.mockRestore()
    }
  })

  it('partial-failure batch: a hub-sync failure still counts as a success in the summary headline, but appears in the failure banner', async () => {
    storeMetas = [meta({ id: 'a', name: 'Alpha', matchedBaseVersion: '0.1.0' })]
    // `__invalid` triggers the mocked `validatePack`'s failure branch —
    // this file never reaches `applyImport`, so it counts toward the
    // headline's "failure" (not saved).
    const rawBad = { name: 'Bad Pack', version: 'not-semver', __invalid: true }
    const rawGood = { name: 'Existing Pack', version: '0.1.0', common: {} }
    importFromDialog.mockResolvedValueOnce({
      canceled: false,
      files: [
        { filePath: 'bad.json', raw: rawBad },
        { filePath: 'my-upload.json', raw: rawGood },
      ],
    })
    const savedMeta = meta({ id: 'e', name: 'Existing Pack', hubPostId: 'hub-1', matchedBaseVersion: '0.1.0' })
    applyImport.mockImplementationOnce(async () => {
      storeMetas = [...storeMetas, savedMeta]
      return { success: true, meta: savedMeta }
    })
    vialAPI.hubUpdateI18nPost.mockResolvedValueOnce({ success: false, error: 'network error' })
    render(<LanguagePacksModal open onClose={vi.fn()} />)

    fireEvent.click(screen.getByTestId('language-packs-import-button'))
    await waitFor(() => expect(screen.getByTestId('language-packs-result-e').textContent).toBe('common.saved'))

    // Headline: 1 saved (the hub-sync failure doesn't reduce this — the
    // file itself landed on disk) and 1 not-saved (the parse/validate
    // failure) — 2 processed total.
    expect(screen.getByTestId('language-packs-import-feedback').textContent).toBe('common.importSummary:2:1:1')

    // The hub-sync failure still shows up in the failure banner text,
    // alongside the parse failure.
    const banner = screen.getByTestId('language-packs-error')
    expect(banner.textContent).toContain('bad.json')
    expect(banner.textContent).toContain('my-upload.json')
    expect(banner.textContent).toContain('network error')
  })

  it('locks the Import button and existing row actions while a batch import is in flight', async () => {
    storeMetas = [meta({ id: 'a', name: 'Alpha', matchedBaseVersion: '0.1.0' })]
    let resolveDialog!: (value: { canceled: boolean; files: Array<{ filePath: string; raw?: unknown; parseError?: string }> }) => void
    importFromDialog.mockImplementationOnce(() => new Promise((resolve) => { resolveDialog = resolve }))
    render(<LanguagePacksModal open onClose={vi.fn()} />)

    fireEvent.click(screen.getByTestId('language-packs-import-button'))
    await waitFor(() => expect(importFromDialog).toHaveBeenCalled())

    // Mid-batch: the toolbar Import button and every existing row's
    // controls lock via the `importing` prop propagating into `busy`.
    expect((screen.getByTestId('language-packs-import-button') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('language-packs-sort-button') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('language-packs-select-a') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('language-packs-export-a') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('language-packs-delete-a') as HTMLButtonElement).disabled).toBe(true)
    // `draggable={false}` renders with no `draggable` attribute at all
    // (see `PackListRow`'s `dragProps`), same as the pre-load fallback's
    // non-draggable row.
    expect(screen.getByTestId('language-packs-row-a').getAttribute('draggable')).toBeNull()

    // A second click while in flight is a no-op (the in-flight ref
    // guard) — the dialog is not opened a second time.
    fireEvent.click(screen.getByTestId('language-packs-import-button'))
    expect(importFromDialog).toHaveBeenCalledTimes(1)

    resolveDialog({ canceled: true, files: [] })
    await waitFor(() => expect((screen.getByTestId('language-packs-import-button') as HTMLButtonElement).disabled).toBe(false))
  })

  it('partial-failure batch: the good file keeps its badge while the bad file is aggregated into one banner', async () => {
    storeMetas = [meta({ id: 'a', name: 'Alpha', matchedBaseVersion: '0.1.0' })]
    const rawGood = { name: 'Good Pack', version: '0.1.0', common: {} }
    // `__invalid` triggers the mocked `validatePack`'s failure branch —
    // this file never reaches `applyImport`.
    const rawBad = { name: 'Bad Pack', version: 'not-semver', __invalid: true }
    importFromDialog.mockResolvedValueOnce({
      canceled: false,
      files: [
        { filePath: 'bad.json', raw: rawBad },
        { filePath: 'good.json', raw: rawGood },
      ],
    })
    // `matchedBaseVersion` matching BASE_REVISION keeps this pack out of
    // the "stale pack auto-update" effect above — otherwise its own
    // background `applyImport` call would double-count against the
    // assertion below, which is unrelated to what this test verifies.
    const goodMeta = meta({ id: 'g', name: 'Good Pack', matchedBaseVersion: '0.1.0' })
    applyImport.mockImplementationOnce(async () => {
      storeMetas = [...storeMetas, goodMeta]
      return { success: true, meta: goodMeta }
    })
    render(<LanguagePacksModal open onClose={vi.fn()} />)

    fireEvent.click(screen.getByTestId('language-packs-import-button'))
    await waitFor(() => expect(screen.getByTestId('language-packs-result-g').textContent).toBe('common.saved'))

    // Only the good file ever reached the store.
    expect(applyImport).toHaveBeenCalledTimes(1)
    const banner = screen.getByTestId('language-packs-error')
    expect(banner.textContent).toContain('bad.json')
  })

  it('P1 fix: importing files that interleave with existing rows (existing A,D; import B,C) lands fully sorted A,B,C,D in one reorder call', async () => {
    storeMetas = [
      meta({ id: 'a', name: 'Alpha', matchedBaseVersion: '0.1.0' }),
      meta({ id: 'd', name: 'Delta', matchedBaseVersion: '0.1.0' }),
    ]
    const rawB = { name: 'Beta', version: '0.1.0', common: {} }
    const rawC = { name: 'Charlie', version: '0.1.0', common: {} }
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
    render(<LanguagePacksModal open onClose={vi.fn()} />)

    fireEvent.click(screen.getByTestId('language-packs-import-button'))
    await waitFor(() => expect(reorderFn).toHaveBeenCalled())
    // Without the fix, Charlie's position would be computed against a
    // stale [Alpha, Delta] snapshot that never saw Beta's insert,
    // persisting ['a', 'c', 'd'] and silently dropping Beta.
    expect(reorderFn).toHaveBeenCalledTimes(1)
    expect(reorderFn).toHaveBeenCalledWith(['a', 'b', 'c', 'd'])
  })

  it('hub-sync failure after import is reported against the originating filename, not the pack name (P2a)', async () => {
    storeMetas = [meta({ id: 'a', name: 'Alpha', matchedBaseVersion: '0.1.0' })]
    const raw = { name: 'Existing Pack', version: '0.1.0', common: {} }
    importFromDialog.mockResolvedValueOnce({
      canceled: false,
      files: [{ filePath: 'my-upload.json', raw }],
    })
    const savedMeta = meta({ id: 'e', name: 'Existing Pack', hubPostId: 'hub-1', matchedBaseVersion: '0.1.0' })
    applyImport.mockResolvedValueOnce({ success: true, meta: savedMeta })
    vialAPI.hubUpdateI18nPost.mockResolvedValueOnce({ success: false, error: 'network error' })
    render(<LanguagePacksModal open onClose={vi.fn()} />)

    fireEvent.click(screen.getByTestId('language-packs-import-button'))
    await waitFor(() => {
      expect(screen.getByTestId('language-packs-error')).toBeTruthy()
    })
    const banner = screen.getByTestId('language-packs-error')
    expect(banner.textContent).toContain('my-upload.json')
    expect(banner.textContent).toContain('network error')
  })

  it('hub download parity: a new Hub download is inserted at its sorted position via reorder', async () => {
    // Already ascending — detected as 'asc' on open, no click needed.
    storeMetas = [
      meta({ id: 'a', name: 'Alpha', matchedBaseVersion: '0.1.0' }),
      meta({ id: 'z', name: 'Zeta', matchedBaseVersion: '0.1.0' }),
    ]
    vialAPI.hubDownloadI18nPost.mockResolvedValueOnce({ success: true, data: { pack: { name: 'Mu', version: '0.1.0', common: {} } } })
    applyImport.mockResolvedValueOnce({ success: true, meta: meta({ id: 'm', name: 'Mu' }) })
    render(<LanguagePacksModal open onClose={vi.fn()} />)

    fireEvent.click(screen.getByTestId('language-packs-tab-hub'))
    await waitFor(() => expect(screen.getByTestId('language-packs-search-input')).toBeTruthy())
    fireEvent.change(screen.getByTestId('language-packs-search-input'), { target: { value: 'mu' } })
    vialAPI.hubListI18nPosts.mockResolvedValueOnce({ success: true, data: { items: [{ id: 'hub-m', name: 'Mu', version: '0.1.0', uploader_name: 'someone' }] } })
    fireEvent.click(screen.getByTestId('language-packs-search-button'))
    await waitFor(() => expect(screen.getByTestId('language-packs-hub-download-hub-m')).toBeTruthy())

    fireEvent.click(screen.getByTestId('language-packs-hub-download-hub-m'))
    await waitFor(() => expect(reorderFn).toHaveBeenCalledWith(['a', 'm', 'z']))
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

  it('delete cascades to Hub for a pack the user owns', async () => {
    storeMetas = [meta({ id: 'hd1', name: 'Hub Delete', hubPostId: 'hp-hd1', uploaderName: 'me' })]
    render(
      <LanguagePacksModal open onClose={vi.fn()} currentDisplayName="me" />,
    )
    fireEvent.click(screen.getByTestId('language-packs-delete-hd1'))
    fireEvent.click(screen.getByTestId('language-packs-confirm-delete-hd1'))
    await waitFor(() => expect(vialAPI.hubDeleteI18nPost).toHaveBeenCalledWith('hp-hd1', 'hd1'))
    await waitFor(() => expect(removeFn).toHaveBeenCalledWith('hd1'))
  })

  it('blocks the local delete and surfaces an error when hubDeleteI18nPost fails for an owned pack, leaving the entry intact', async () => {
    storeMetas = [meta({ id: 'hd2', name: 'Hub Delete Fail', hubPostId: 'hp-hd2', uploaderName: 'me' })]
    vialAPI.hubDeleteI18nPost.mockResolvedValueOnce({ success: false, error: 'Hub rejected the delete' })
    render(
      <LanguagePacksModal open onClose={vi.fn()} currentDisplayName="me" />,
    )
    fireEvent.click(screen.getByTestId('language-packs-delete-hd2'))
    fireEvent.click(screen.getByTestId('language-packs-confirm-delete-hd2'))
    await waitFor(() => expect(vialAPI.hubDeleteI18nPost).toHaveBeenCalledWith('hp-hd2', 'hd2'))
    await waitFor(() => expect(screen.getByTestId('language-packs-result-hd2').textContent).toBe('Hub rejected the delete'))
    // A failed cascade must not proceed to the local delete — otherwise
    // the Hub post is orphaned under a name nobody can re-upload.
    expect(removeFn).not.toHaveBeenCalled()
    expect(screen.queryByTestId('language-packs-confirm-delete-hd2')).toBeNull()
  })

  // --- regression: Delete must not cascade to Hub for packs the user
  // does not own (fix/delete-ownership-gate). A downloaded pack also
  // carries hubPostId (for Sync/freshness linkage) but is never
  // deletable on Hub by this user — the old code attempted the Hub
  // delete regardless of ownership, which failed for a foreign post
  // (or a deactivated uploader account) and then blocked the local
  // delete too, leaving the user unable to remove a downloaded pack at
  // all. See KeyLabelsModal / ThemePacksModal for the same pattern. ---

  it('a pack downloaded from someone else deletes locally only — no Hub call at all (THE regression)', async () => {
    storeMetas = [meta({ id: 'foreign-del', name: 'Foreign Pack', hubPostId: 'hp-foreign-del', uploaderName: 'pipette' })]
    render(
      <LanguagePacksModal open onClose={vi.fn()} currentDisplayName="me" />,
    )
    fireEvent.click(screen.getByTestId('language-packs-delete-foreign-del'))
    fireEvent.click(screen.getByTestId('language-packs-confirm-delete-foreign-del'))
    await waitFor(() => expect(removeFn).toHaveBeenCalledWith('foreign-del'))
    expect(vialAPI.hubDeleteI18nPost).not.toHaveBeenCalled()
  })

  it('a legacy hub-linked pack with no cached uploaderName deletes locally only (conservative default, matches Update/Remove gating)', async () => {
    storeMetas = [meta({ id: 'legacy-del', name: 'Legacy Hub Pack', hubPostId: 'hp-legacy-del' })]
    render(
      <LanguagePacksModal open onClose={vi.fn()} currentDisplayName="me" />,
    )
    fireEvent.click(screen.getByTestId('language-packs-delete-legacy-del'))
    fireEvent.click(screen.getByTestId('language-packs-confirm-delete-legacy-del'))
    await waitFor(() => expect(removeFn).toHaveBeenCalledWith('legacy-del'))
    expect(vialAPI.hubDeleteI18nPost).not.toHaveBeenCalled()
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
    storeMetas = [meta({ id: 'up1', name: 'Update Me', hubPostId: 'hp-up1', uploaderName: 'me' })]
    render(
      <LanguagePacksModal open onClose={vi.fn()} hubCanWrite currentDisplayName="me" />,
    )
    fireEvent.click(screen.getByTestId('language-packs-update-up1'))
    await waitFor(() => expect(vialAPI.i18nPackGet).toHaveBeenCalledWith('up1'))
    await waitFor(() => expect(vialAPI.hubUpdateI18nPost).toHaveBeenCalled())
  })

  it('update and remove buttons are visible when hubCanWrite is true and the row is mine (isMine gate, Phase 3)', () => {
    storeMetas = [meta({ id: 'w1', name: 'Write Hub', hubPostId: 'hp-w1', uploaderName: 'me' })]
    render(
      <LanguagePacksModal open onClose={vi.fn()} hubCanWrite currentDisplayName="me" />,
    )
    expect(screen.getByTestId('language-packs-update-w1')).toBeTruthy()
    expect(screen.getByTestId('language-packs-remove-w1')).toBeTruthy()
    expect(screen.queryByTestId('language-packs-sync-w1')).toBeNull()
  })

  it('shows Sync instead of Update/Remove for a hub-linked row uploaded by someone else, even with hubCanWrite (isMine gate, Phase 3)', () => {
    storeMetas = [meta({ id: 'foreign1', name: 'Foreign Pack', hubPostId: 'hp-foreign1', uploaderName: 'someone-else' })]
    render(
      <LanguagePacksModal open onClose={vi.fn()} hubCanWrite currentDisplayName="me" />,
    )
    expect(screen.queryByTestId('language-packs-update-foreign1')).toBeNull()
    expect(screen.queryByTestId('language-packs-remove-foreign1')).toBeNull()
    expect(screen.getByTestId('language-packs-sync-foreign1')).toBeTruthy()
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

  it('sync refreshes uploaderName/hubUpdatedAt via a name-matched Hub list lookup (Phase 3)', async () => {
    storeMetas = [meta({ id: 'sy2', name: 'Sync Me', hubPostId: 'hp-sy2' })]
    vialAPI.hubDownloadI18nPost.mockResolvedValueOnce({
      success: true,
      data: { pack: { name: 'Sync Me', version: '0.1.0', common: {} } },
    })
    vialAPI.hubListI18nPosts.mockResolvedValueOnce({
      success: true,
      data: { items: [{ id: 'hp-sy2', name: 'Sync Me', version: '0.1.0', uploaderName: 'alice', updatedAt: '2026-05-02T00:00:00.000Z' }] },
    })
    render(
      <LanguagePacksModal open onClose={vi.fn()} hubCanWrite={false} />,
    )
    fireEvent.click(screen.getByTestId('language-packs-sync-sy2'))
    await waitFor(() => expect(vialAPI.hubListI18nPosts).toHaveBeenCalledWith({ name: 'Sync Me' }))
    await waitFor(() => expect(applyImport).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ uploaderName: 'alice', hubUpdatedAt: '2026-05-02T00:00:00.000Z' }),
    ))
  })

  it('remove action asks for confirmation', () => {
    storeMetas = [meta({ id: 'rm1', name: 'Remove Me', hubPostId: 'hp-rm1', uploaderName: 'me' })]
    render(
      <LanguagePacksModal open onClose={vi.fn()} hubCanWrite currentDisplayName="me" />,
    )
    fireEvent.click(screen.getByTestId('language-packs-remove-rm1'))
    expect(screen.getByTestId('language-packs-confirm-remove-rm1')).toBeTruthy()
    expect(screen.getByTestId('language-packs-cancel-remove-rm1')).toBeTruthy()
  })

  it('confirmed remove calls hubDeleteI18nPost', async () => {
    storeMetas = [meta({ id: 'rm2', name: 'Remove Me', hubPostId: 'hp-rm2', uploaderName: 'me' })]
    render(
      <LanguagePacksModal open onClose={vi.fn()} hubCanWrite currentDisplayName="me" />,
    )
    fireEvent.click(screen.getByTestId('language-packs-remove-rm2'))
    fireEvent.click(screen.getByTestId('language-packs-confirm-remove-rm2'))
    await waitFor(() => expect(vialAPI.hubDeleteI18nPost).toHaveBeenCalledWith('hp-rm2', 'rm2'))
  })

  it('cancel remove hides the confirmation', () => {
    storeMetas = [meta({ id: 'rm3', name: 'Remove Me', hubPostId: 'hp-rm3', uploaderName: 'me' })]
    render(
      <LanguagePacksModal open onClose={vi.fn()} hubCanWrite currentDisplayName="me" />,
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
    vialAPI.hubListI18nPosts.mockClear()
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

  it('hub initial hint: auto-fetches hub list on tab open', async () => {
    render(
      <LanguagePacksModal open onClose={vi.fn()} />,
    )
    await switchToHubTab()
    expect(vialAPI.hubListI18nPosts).toHaveBeenCalledWith({ q: '' })
    await waitFor(() => {
      expect(screen.getByTestId('language-packs-hub-empty')).toBeTruthy()
      expect(screen.getByText('i18n.hubEmpty')).toBeTruthy()
    })
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

  it('Author column shows the cached uploaderName for a hub-linked pack', () => {
    storeMetas = [meta({ id: 'auth1', name: 'Authored', hubPostId: 'hp-auth1', uploaderName: 'alice' })]
    render(<LanguagePacksModal open onClose={vi.fn()} />)
    expect(screen.getByTestId('language-packs-author-auth1').textContent).toBe('alice')
  })

  it('Author column is blank for a never-uploaded local pack (no uploaderName)', () => {
    storeMetas = [meta({ id: 'local1', name: 'Local Only' })]
    render(<LanguagePacksModal open onClose={vi.fn()} />)
    expect(screen.getByTestId('language-packs-author-local1').textContent).toBe('')
  })

  it('Author column shows "pipette" for built-in English', () => {
    render(<LanguagePacksModal open onClose={vi.fn()} />)
    expect(screen.getByTestId('language-packs-author-builtin:en').textContent).toBe('pipette')
  })

  it('Updated column shows the Hub-side hubUpdatedAt, not the local updatedAt', () => {
    storeMetas = [meta({ id: 'hu1', name: 'Hub Updated', hubPostId: 'hp-hu1', hubUpdatedAt: '2026-05-01T00:00:00.000Z' })]
    render(<LanguagePacksModal open onClose={vi.fn()} />)
    expect(screen.getByTestId('language-packs-timestamp-hu1').textContent).toBe('2026-05-01T00:00:00.000Z')
  })

  it('Updated column is blank for a pack with no hubUpdatedAt (legacy row or never uploaded)', () => {
    storeMetas = [meta({ id: 'legacy1', name: 'Legacy' })]
    render(<LanguagePacksModal open onClose={vi.fn()} />)
    expect(screen.getByTestId('language-packs-timestamp-legacy1').textContent).toBe('')
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

  // --- Phase 2: drag reorder + Name sort -----------------------------------

  // These two only exercise the pre-load fallback: `storeMetas` here has
  // no real `builtin-english` entry (the mocked store never runs
  // `ensureBuiltinEnglishEntry`), so the modal falls back to a
  // synthesized, non-draggable row — same as the brief window before a
  // real store's metas have arrived. See the "real builtin-english
  // entry" block below for the now-orderable case.
  it('pre-load fallback: renders a drag grip for imported packs but not for the not-yet-loaded built-in English row', () => {
    storeMetas = [meta({ id: 'p1', name: 'Japanese' })]
    render(<LanguagePacksModal open onClose={vi.fn()} />)
    expect(screen.getByTestId('language-packs-grip-p1')).toBeTruthy()
    expect(screen.queryByTestId('language-packs-grip-builtin:en')).toBeNull()
  })

  it('pre-load fallback: built-in English is not draggable before ensureBuiltinEnglishEntry has materialized it', () => {
    storeMetas = [meta({ id: 'p1', name: 'Japanese' })]
    render(<LanguagePacksModal open onClose={vi.fn()} />)
    const builtinRow = screen.getByTestId('language-packs-row-builtin:en')
    expect(builtinRow.getAttribute('draggable')).toBeNull()
    const packRow = screen.getByTestId('language-packs-row-p1')
    expect(packRow.getAttribute('draggable')).toBe('true')
  })

  it('dragging a pack row persists the new order via store.reorder', async () => {
    storeMetas = [meta({ id: 'p1', name: 'Alpha' }), meta({ id: 'p2', name: 'Beta' })]
    render(<LanguagePacksModal open onClose={vi.fn()} />)
    const rowA = screen.getByTestId('language-packs-row-p1')
    const rowB = screen.getByTestId('language-packs-row-p2')

    fireEvent.dragStart(rowA, { dataTransfer: { effectAllowed: '', setData: vi.fn() } })
    fireEvent.dragOver(rowB)
    fireEvent.dragEnd(rowA)

    await waitFor(() => expect(reorderFn).toHaveBeenCalledWith(['p2', 'p1']))
  })

  it('the Name sort button sorts imported packs ascending on first click', async () => {
    storeMetas = [meta({ id: 'z', name: 'Zeta' }), meta({ id: 'a', name: 'Alpha' })]
    render(<LanguagePacksModal open onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('language-packs-sort-button'))
    await waitFor(() => expect(reorderFn).toHaveBeenCalledWith(['a', 'z']))
  })

  it('a second click on the Name sort button reverses the order', async () => {
    storeMetas = [meta({ id: 'z', name: 'Zeta' }), meta({ id: 'a', name: 'Alpha' })]
    render(<LanguagePacksModal open onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('language-packs-sort-button'))
    await waitFor(() => expect(reorderFn).toHaveBeenCalledWith(['a', 'z']))
    fireEvent.click(screen.getByTestId('language-packs-sort-button'))
    await waitFor(() => expect(reorderFn).toHaveBeenLastCalledWith(['z', 'a']))
  })

  // --- Built-in English as a real, orderable store entry -------------------
  // (ensureBuiltinEnglishEntry materializes id 'builtin-english'; see
  // main/i18n-pack-store.ts. These mock it directly in `storeMetas` the
  // way the real main-side store always does once ensured.)

  it('shows a drag grip and is draggable once built-in English is a real store entry', () => {
    storeMetas = [meta({ id: 'builtin-english', name: 'English' }), meta({ id: 'p1', name: 'Japanese' })]
    render(<LanguagePacksModal open onClose={vi.fn()} />)
    expect(screen.getByTestId('language-packs-grip-builtin:en')).toBeTruthy()
    const builtinRow = screen.getByTestId('language-packs-row-builtin:en')
    expect(builtinRow.getAttribute('draggable')).toBe('true')
  })

  it('dragging built-in English persists its new position via store.reorder using its real store id', async () => {
    storeMetas = [
      meta({ id: 'builtin-english', name: 'English' }),
      meta({ id: 'p1', name: 'Japanese' }),
      meta({ id: 'p2', name: 'French' }),
    ]
    render(<LanguagePacksModal open onClose={vi.fn()} />)
    const builtinRow = screen.getByTestId('language-packs-row-builtin:en')
    const rowP2 = screen.getByTestId('language-packs-row-p2')

    fireEvent.dragStart(builtinRow, { dataTransfer: { effectAllowed: '', setData: vi.fn() } })
    fireEvent.dragOver(rowP2)
    fireEvent.dragEnd(builtinRow)

    await waitFor(() => expect(reorderFn).toHaveBeenCalledWith(['p1', 'p2', 'builtin-english']))
  })

  it('the Name sort button sorts built-in English alphabetically alongside imported packs', async () => {
    storeMetas = [
      meta({ id: 'z', name: 'Zeta' }),
      meta({ id: 'builtin-english', name: 'English' }),
      meta({ id: 'a', name: 'Alpha' }),
    ]
    render(<LanguagePacksModal open onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('language-packs-sort-button'))
    // Alpha < English < Zeta
    await waitFor(() => expect(reorderFn).toHaveBeenCalledWith(['a', 'builtin-english', 'z']))
  })

  it('a new import is inserted at its sorted position relative to built-in English', async () => {
    // Already ascending (Alpha, English, Zeta) — detected 'asc' on open.
    storeMetas = [
      meta({ id: 'a', name: 'Alpha', matchedBaseVersion: '0.1.0' }),
      meta({ id: 'builtin-english', name: 'English' }),
      meta({ id: 'z', name: 'Zeta', matchedBaseVersion: '0.1.0' }),
    ]
    const raw = { name: 'Charlie', version: '0.1.0', common: {} }
    importFromDialog.mockResolvedValueOnce({ canceled: false, files: [{ filePath: 'test.json', raw }] })
    applyImport.mockResolvedValueOnce({ success: true, meta: meta({ id: 'c', name: 'Charlie' }) })
    render(<LanguagePacksModal open onClose={vi.fn()} />)

    fireEvent.click(screen.getByTestId('language-packs-import-button'))
    // Alpha < Charlie < English < Zeta
    await waitFor(() => expect(reorderFn).toHaveBeenCalledWith(['a', 'c', 'builtin-english', 'z']))
  })
})
