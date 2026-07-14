// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { LanguageSelectorModal } from '../LanguageSelectorModal'
import { clearAozoraCatalogCache } from '../AozoraCatalogTab'
import type { LanguageListEntry } from '../../../shared/types/language-store'

// Most tests in this file assert on testids/structure and don't need
// resolved i18n text, so the shared `render` is left as-is. The Romaji
// badge tests below check the badge's rendered label, which requires a
// real i18n instance (the default `render` leaves `t()` returning raw keys).
function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

const mockLanguages: LanguageListEntry[] = [
  { name: 'english', wordCount: 200, rightToLeft: false, fileSize: 5000, status: 'bundled' },
  { name: 'english_1k', wordCount: 1000, rightToLeft: false, fileSize: 15000, status: 'downloaded' },
  { name: 'german', wordCount: 5000, rightToLeft: false, fileSize: 50000, status: 'not-downloaded' },
  { name: 'arabic', wordCount: 3000, rightToLeft: true, fileSize: 30000, status: 'not-downloaded' },
  { name: 'japanese_hiragana', wordCount: 500, rightToLeft: false, fileSize: 8000, status: 'downloaded' },
]

beforeEach(() => {
  // The Aozora catalog tab caches its fetched list at module scope so a tab
  // remount doesn't re-fetch; each test needs a fresh fetch of its own mock.
  clearAozoraCatalogCache()
  window.vialAPI = {
    langList: vi.fn().mockResolvedValue(mockLanguages),
    langGet: vi.fn().mockResolvedValue(null),
    langDownload: vi.fn().mockResolvedValue({ success: true }),
    langDelete: vi.fn().mockResolvedValue({ success: true }),
    checkTypingDatasetUpdate: vi.fn().mockResolvedValue({ provider: 'monkeytype', updateAvailable: false }),
    updateTypingDataset: vi.fn().mockResolvedValue({ provider: 'monkeytype', changed: false, fromVersion: '' }),
    // The modal itself reads the text metas (initial-tab correction for
    // catalog-managed texts), so every render needs a list mock.
    typingTestTextStoreList: vi.fn().mockResolvedValue({ success: true, data: [] }),
    typingTestTextStoreDelete: vi.fn().mockResolvedValue({ success: true }),
  } as unknown as typeof window.vialAPI
})

function textMeta(id: string, name: string, source?: { provider: string; workId: string }) {
  return { id, name, wordCount: 10, filename: 'f.json', savedAt: '', updatedAt: '', source }
}

describe('LanguageSelectorModal', () => {
  it('renders with title and search input', async () => {
    render(
      <LanguageSelectorModal
        currentLanguage="english"
        onSelectLanguage={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('language-search')).toBeInTheDocument()
    })
    // No update by default → no banner.
    expect(screen.queryByTestId('typing-dataset-update-banner')).toBeNull()
  })

  it('shows the update banner and applies the update on click', async () => {
    vi.mocked(window.vialAPI.checkTypingDatasetUpdate).mockResolvedValue({ provider: 'monkeytype', updateAvailable: true })
    vi.mocked(window.vialAPI.updateTypingDataset).mockResolvedValue({ provider: 'monkeytype', changed: true, fromVersion: 'a', toVersion: 'b' })
    render(
      <LanguageSelectorModal
        currentLanguage="english"
        onSelectLanguage={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    await waitFor(() => expect(screen.getByTestId('typing-dataset-update-banner')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('typing-dataset-update-button'))

    await waitFor(() => {
      expect(window.vialAPI.updateTypingDataset).toHaveBeenCalledWith('monkeytype')
      expect(screen.queryByTestId('typing-dataset-update-banner')).toBeNull()
    })
  })

  it('keeps the banner when the update was not applied (offline retry path)', async () => {
    vi.mocked(window.vialAPI.checkTypingDatasetUpdate).mockResolvedValue({ provider: 'monkeytype', updateAvailable: true })
    vi.mocked(window.vialAPI.updateTypingDataset).mockResolvedValue({ provider: 'monkeytype', changed: false, fromVersion: 'a' })
    render(
      <LanguageSelectorModal
        currentLanguage="english"
        onSelectLanguage={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    await waitFor(() => expect(screen.getByTestId('typing-dataset-update-banner')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('typing-dataset-update-button'))

    await waitFor(() => expect(window.vialAPI.updateTypingDataset).toHaveBeenCalled())
    // Update not applied → banner stays so the user can retry.
    expect(screen.getByTestId('typing-dataset-update-banner')).toBeInTheDocument()
  })

  it('displays downloaded and available sections', async () => {
    render(
      <LanguageSelectorModal
        currentLanguage="english"
        onSelectLanguage={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('language-row-english')).toBeInTheDocument()
      expect(screen.getByTestId('language-row-english_1k')).toBeInTheDocument()
      expect(screen.getByTestId('language-row-german')).toBeInTheDocument()
    })
  })

  it('highlights current language', async () => {
    render(
      <LanguageSelectorModal
        currentLanguage="english"
        onSelectLanguage={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    await waitFor(() => {
      const englishRow = screen.getByTestId('language-row-english')
      expect(englishRow.className).toContain('bg-accent')
    })
  })

  it('filters languages by search', async () => {
    render(
      <LanguageSelectorModal
        currentLanguage="english"
        onSelectLanguage={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('language-row-german')).toBeInTheDocument()
    })

    fireEvent.change(screen.getByTestId('language-search'), { target: { value: 'ger' } })

    expect(screen.getByTestId('language-row-german')).toBeInTheDocument()
    expect(screen.queryByTestId('language-row-english')).not.toBeInTheDocument()
  })

  it('calls onSelectLanguage and onClose when clicking a downloaded language', async () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()

    render(
      <LanguageSelectorModal
        currentLanguage="english"
        onSelectLanguage={onSelect}
        onClose={onClose}
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('language-row-english_1k')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('language-row-english_1k'))

    expect(onSelect).toHaveBeenCalledWith('english_1k')
    expect(onClose).toHaveBeenCalled()
  })

  it('does not call onSelectLanguage when clicking a not-downloaded language row', async () => {
    const onSelect = vi.fn()

    render(
      <LanguageSelectorModal
        currentLanguage="english"
        onSelectLanguage={onSelect}
        onClose={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('language-row-german')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('language-row-german'))

    expect(onSelect).not.toHaveBeenCalled()
  })

  it('calls langDownload when clicking download button', async () => {
    render(
      <LanguageSelectorModal
        currentLanguage="english"
        onSelectLanguage={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('language-download-german')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('language-download-german'))

    expect(window.vialAPI.langDownload).toHaveBeenCalledWith('german', 'monkeytype')
  })

  it('lists the tatoeba provider and version-checks it when its tab is shown', async () => {
    render(
      <LanguageSelectorModal
        currentLanguage="english"
        onSelectLanguage={vi.fn()}
        onSelectImport={vi.fn()}
        onSelectTatoeba={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTestId('language-tab-tatoeba'))

    await waitFor(() => {
      expect(window.vialAPI.langList).toHaveBeenCalledWith('tatoeba')
      expect(window.vialAPI.checkTypingDatasetUpdate).toHaveBeenCalledWith('tatoeba')
    })
  })

  it('picks a tatoeba pack → onSelectTatoeba + onClose', async () => {
    const onSelectTatoeba = vi.fn()
    const onClose = vi.fn()

    render(
      <LanguageSelectorModal
        currentLanguage="english"
        onSelectLanguage={vi.fn()}
        onSelectImport={vi.fn()}
        onSelectTatoeba={onSelectTatoeba}
        onClose={onClose}
      />,
    )

    fireEvent.click(screen.getByTestId('language-tab-tatoeba'))
    await waitFor(() => expect(screen.getByTestId('language-row-english_1k')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('language-row-english_1k'))

    expect(onSelectTatoeba).toHaveBeenCalledWith('english_1k')
    expect(onClose).toHaveBeenCalled()
  })

  it('opens on the tatoeba tab when a tatoeba pack is active', async () => {
    render(
      <LanguageSelectorModal
        currentLanguage="english"
        currentTatoebaLanguage="english_1k"
        onSelectLanguage={vi.fn()}
        onSelectImport={vi.fn()}
        onSelectTatoeba={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    await waitFor(() =>
      expect(screen.getByTestId('language-tab-tatoeba')).toHaveAttribute('aria-selected', 'true'),
    )
  })

  it('shows delete button for downloaded (non-bundled) languages', async () => {
    render(
      <LanguageSelectorModal
        currentLanguage="english"
        onSelectLanguage={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('language-delete-english_1k')).toBeInTheDocument()
    })

    // Bundled english should not have delete button
    expect(screen.queryByTestId('language-delete-english')).not.toBeInTheDocument()
  })

  it('closes modal on Escape key', async () => {
    const onClose = vi.fn()

    render(
      <LanguageSelectorModal
        currentLanguage="english"
        onSelectLanguage={vi.fn()}
        onClose={onClose}
      />,
    )

    // Search input auto-focuses on mount; blur it so Escape is not treated as
    // input-in-progress.
    ;(document.activeElement as HTMLElement | null)?.blur()
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onClose).toHaveBeenCalled()
  })

  it('does not update state after unmount when langList resolves late', async () => {
    let resolveLangList: (value: LanguageListEntry[]) => void
    const langListPromise = new Promise<LanguageListEntry[]>((resolve) => { resolveLangList = resolve })
    vi.mocked(window.vialAPI.langList).mockReturnValue(langListPromise)

    const { unmount } = render(
      <LanguageSelectorModal
        currentLanguage="english"
        onSelectLanguage={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    // Unmount before langList resolves
    unmount()

    // Resolve after unmount — should not throw or update state
    resolveLangList!(mockLanguages)
    await langListPromise
  })

  it('shows RTL badge for right-to-left languages', async () => {
    render(
      <LanguageSelectorModal
        currentLanguage="english"
        onSelectLanguage={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('language-row-arabic')).toBeInTheDocument()
    })

    const arabicRow = screen.getByTestId('language-row-arabic')
    expect(arabicRow.textContent).toContain('RTL')
  })

  it('shows the Romaji badge for a kana word-language pack but not for a non-kana one', async () => {
    renderWithI18n(
      <LanguageSelectorModal
        currentLanguage="english"
        onSelectLanguage={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('language-row-japanese_hiragana')).toBeInTheDocument()
    })

    expect(screen.getByTestId('language-row-japanese_hiragana').textContent).toContain('Romaji')
    expect(screen.getByTestId('language-row-english').textContent).not.toContain('Romaji')
  })

  it('shows the Romaji badge for a kana tatoeba pack', async () => {
    renderWithI18n(
      <LanguageSelectorModal
        currentLanguage="english"
        onSelectLanguage={vi.fn()}
        onSelectImport={vi.fn()}
        onSelectTatoeba={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTestId('language-tab-tatoeba'))

    await waitFor(() => {
      expect(screen.getByTestId('language-row-japanese_hiragana')).toBeInTheDocument()
    })

    expect(screen.getByTestId('language-row-japanese_hiragana').textContent).toContain('Romaji')
  })

  it('deleting the selected imported text then closing fires onCurrentTextDeleted', async () => {
    window.vialAPI = {
      ...window.vialAPI,
      typingTestTextStoreList: vi.fn().mockResolvedValue({
        success: true,
        data: [{ id: 'x', name: 'My Text', wordCount: 3, filename: 'x.json', savedAt: '', updatedAt: '' }],
      }),
      typingTestTextStoreDelete: vi.fn().mockResolvedValue({ success: true }),
    } as unknown as typeof window.vialAPI

    const onCurrentTextDeleted = vi.fn()
    const onClose = vi.fn()
    render(
      <LanguageSelectorModal
        currentLanguage="english"
        currentFileImportTextId="x"
        onSelectLanguage={vi.fn()}
        onSelectImport={vi.fn()}
        onCurrentTextDeleted={onCurrentTextDeleted}
        onClose={onClose}
      />,
    )

    // Modal opens on the Import tab because a fileImport text is selected.
    await waitFor(() => expect(screen.getByTestId('typing-text-delete-x')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('typing-text-delete-x'))
    await waitFor(() => expect(window.vialAPI.typingTestTextStoreDelete).toHaveBeenCalledWith('x'))

    fireEvent.click(screen.getByTestId('language-modal-close'))
    expect(onCurrentTextDeleted).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('lists the aozora catalog and version-checks it when its tab is shown', async () => {
    window.vialAPI = {
      ...window.vialAPI,
      typingTestTextStoreList: vi.fn().mockResolvedValue({ success: true, data: [] }),
    } as unknown as typeof window.vialAPI

    render(
      <LanguageSelectorModal
        currentLanguage="english"
        onSelectLanguage={vi.fn()}
        onSelectImport={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTestId('language-tab-aozora'))

    await waitFor(() => {
      expect(window.vialAPI.langList).toHaveBeenCalledWith('aozora')
      expect(window.vialAPI.checkTypingDatasetUpdate).toHaveBeenCalledWith('aozora')
    })
  })

  it('picks an already-imported aozora work → onSelectImport + onClose', async () => {
    const onSelectImport = vi.fn()
    const onClose = vi.fn()
    const workId = '001257/files/59898.zip'
    window.vialAPI = {
      ...window.vialAPI,
      langList: vi.fn((provider?: string) => {
        if (provider === 'aozora') {
          return Promise.resolve([
            { name: workId, title: 'Sample Work', author: 'Sample Author', wordCount: 1000, rightToLeft: false, fileSize: 2000 },
          ])
        }
        return Promise.resolve(mockLanguages)
      }),
      typingTestTextStoreList: vi.fn().mockResolvedValue({
        success: true,
        data: [{
          id: 'aozora-1',
          name: 'Sample Work（Sample Author）',
          wordCount: 1000,
          filename: 'a.json',
          savedAt: '',
          updatedAt: '',
          source: { provider: 'aozora', workId },
        }],
      }),
    } as unknown as typeof window.vialAPI

    render(
      <LanguageSelectorModal
        currentLanguage="english"
        onSelectLanguage={vi.fn()}
        onSelectImport={onSelectImport}
        onClose={onClose}
      />,
    )

    fireEvent.click(screen.getByTestId('language-tab-aozora'))
    await waitFor(() => expect(screen.getByTestId(`aozora-row-${workId}`)).toBeInTheDocument())

    fireEvent.click(screen.getByTestId(`aozora-row-${workId}`))

    expect(onSelectImport).toHaveBeenCalledWith('aozora-1')
    expect(onClose).toHaveBeenCalled()
  })

  it('deleting a non-current aozora work then closing does not fire onCurrentTextDeleted', async () => {
    const workId = '001257/files/59898.zip'
    window.vialAPI = {
      ...window.vialAPI,
      langList: vi.fn((provider?: string) => {
        if (provider === 'aozora') {
          return Promise.resolve([
            { name: workId, title: 'Sample Work', author: 'Sample Author', wordCount: 1000, rightToLeft: false, fileSize: 2000 },
          ])
        }
        return Promise.resolve(mockLanguages)
      }),
      typingTestTextStoreList: vi.fn().mockResolvedValue({
        success: true,
        data: [{
          id: 'aozora-1',
          name: 'Sample Work（Sample Author）',
          wordCount: 1000,
          filename: 'a.json',
          savedAt: '',
          updatedAt: '',
          source: { provider: 'aozora', workId },
        }],
      }),
      typingTestTextStoreDelete: vi.fn().mockResolvedValue({ success: true }),
    } as unknown as typeof window.vialAPI

    const onCurrentTextDeleted = vi.fn()
    const onClose = vi.fn()
    render(
      <LanguageSelectorModal
        currentLanguage="english"
        currentFileImportTextId="some-other-id"
        onSelectLanguage={vi.fn()}
        onSelectImport={vi.fn()}
        onCurrentTextDeleted={onCurrentTextDeleted}
        onClose={onClose}
      />,
    )

    // currentFileImportTextId is set, so the modal opens on the Import tab;
    // switch to Aozora to reach the deletable imported row.
    fireEvent.click(screen.getByTestId('language-tab-aozora'))
    await waitFor(() => expect(screen.getByTestId(`aozora-delete-${workId}`)).toBeInTheDocument())
    fireEvent.click(screen.getByTestId(`aozora-delete-${workId}`))
    await waitFor(() => expect(window.vialAPI.typingTestTextStoreDelete).toHaveBeenCalledWith('aozora-1'))

    fireEvent.click(screen.getByTestId('language-modal-close'))
    expect(onCurrentTextDeleted).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('excludes catalog-managed texts (with a `source`) from the File Import list', async () => {
    window.vialAPI = {
      ...window.vialAPI,
      typingTestTextStoreList: vi.fn().mockResolvedValue({
        success: true,
        data: [
          { id: 'file-id', name: 'My File Import', wordCount: 5, filename: 'file.json', savedAt: '', updatedAt: '' },
          {
            id: 'catalog-id',
            name: 'Aozora Work',
            wordCount: 5,
            filename: 'catalog.json',
            savedAt: '',
            updatedAt: '',
            source: { provider: 'aozora', workId: 'works/0.zip' },
          },
        ],
      }),
    } as unknown as typeof window.vialAPI

    render(
      <LanguageSelectorModal
        currentLanguage="english"
        onSelectLanguage={vi.fn()}
        onSelectImport={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTestId('language-tab-import'))

    await waitFor(() => expect(screen.getByTestId('typing-text-row-file-id')).toBeInTheDocument())
    expect(screen.queryByTestId('typing-text-row-catalog-id')).not.toBeInTheDocument()
  })

  it('shows the Romaji badge only for a kana-pure imported text', async () => {
    window.vialAPI = {
      ...window.vialAPI,
      typingTestTextStoreList: vi.fn().mockResolvedValue({
        success: true,
        data: [
          { id: 'kana-id', name: 'Kana Text', wordCount: 5, filename: 'k.json', savedAt: '', updatedAt: '', romajiCapable: true },
          { id: 'mixed-id', name: 'Mixed Text', wordCount: 5, filename: 'm.json', savedAt: '', updatedAt: '', romajiCapable: false },
        ],
      }),
    } as unknown as typeof window.vialAPI

    renderWithI18n(
      <LanguageSelectorModal
        currentLanguage="english"
        onSelectLanguage={vi.fn()}
        onSelectImport={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTestId('language-tab-import'))

    await waitFor(() => expect(screen.getByTestId('typing-text-row-kana-id')).toBeInTheDocument())
    expect(screen.getByTestId('typing-text-row-kana-id').textContent).toContain('Romaji')
    expect(screen.getByTestId('typing-text-row-mixed-id').textContent).not.toContain('Romaji')
  })

  it('does not fire onCurrentTextDeleted when nothing was deleted', async () => {
    const onCurrentTextDeleted = vi.fn()
    const onClose = vi.fn()
    render(
      <LanguageSelectorModal
        currentLanguage="english"
        onSelectLanguage={vi.fn()}
        onSelectImport={vi.fn()}
        onCurrentTextDeleted={onCurrentTextDeleted}
        onClose={onClose}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('language-search')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('language-modal-close'))
    expect(onCurrentTextDeleted).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('hops from the File Import tab to Aozora when the current text is a catalog import', async () => {
    window.vialAPI.typingTestTextStoreList = vi.fn().mockResolvedValue({
      success: true,
      data: [textMeta('az-1', '船旅（アーヴィング ワシントン）', { provider: 'aozora', workId: 'works/az.zip' })],
    })
    render(
      <LanguageSelectorModal
        currentLanguage="english"
        currentFileImportTextId="az-1"
        onSelectLanguage={vi.fn()}
        onSelectImport={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('language-tab-aozora')).toHaveAttribute('aria-selected', 'true')
    })
  })

  it('stays on the File Import tab when the current text is a plain file import', async () => {
    window.vialAPI.typingTestTextStoreList = vi.fn().mockResolvedValue({
      success: true,
      data: [textMeta('file-1', 'My Notes')],
    })
    render(
      <LanguageSelectorModal
        currentLanguage="english"
        currentFileImportTextId="file-1"
        onSelectLanguage={vi.fn()}
        onSelectImport={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    await waitFor(() => expect(screen.getByText('My Notes')).toBeInTheDocument())
    expect(screen.getByTestId('language-tab-import')).toHaveAttribute('aria-selected', 'true')
  })
})
