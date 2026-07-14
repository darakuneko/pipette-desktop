// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { AozoraCatalogTab, clearAozoraCatalogCache } from '../AozoraCatalogTab'
import type { LanguageListEntry } from '../../../shared/types/language-store'
import type { TypingTestTextMeta } from '../../../shared/types/typing-test-text-store'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

// jsdom has no IntersectionObserver. This mock captures the callback passed
// by the component so a test can fire a synthetic intersection entry for the
// sentinel, and tracks disconnect() calls so a test can assert cleanup.
let observerCallback: IntersectionObserverCallback | null = null
let observerDisconnect: ReturnType<typeof vi.fn>

class MockIntersectionObserver {
  constructor(callback: IntersectionObserverCallback) {
    observerCallback = callback
  }
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = observerDisconnect
}

function fireSentinelIntersection() {
  observerCallback?.([{ isIntersecting: true } as IntersectionObserverEntry], observerCallback as unknown as IntersectionObserver)
}

function makeCatalog(count: number): LanguageListEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `works/${i}.zip`,
    title: `Work Title ${i}`,
    author: i === 0 ? 'Distinctive Author' : `Author ${i}`,
    authorKana: 'だざい おさむ',
    wordCount: 1000 + i,
    rightToLeft: false,
    fileSize: 2000,
    status: 'not-downloaded' as const,
  }))
}

const emptyMetas: TypingTestTextMeta[] = []

beforeEach(() => {
  // The catalog tab caches the fetched list at module scope so a tab
  // remount doesn't re-fetch; each test needs a fresh fetch of its own mock.
  clearAozoraCatalogCache()
  window.vialAPI = {
    langList: vi.fn().mockResolvedValue(makeCatalog(60)),
    checkTypingDatasetUpdate: vi.fn().mockResolvedValue({ provider: 'aozora', updateAvailable: false }),
    updateTypingDataset: vi.fn().mockResolvedValue({ provider: 'aozora', changed: false, fromVersion: '' }),
    typingTestTextStoreList: vi.fn().mockResolvedValue({ success: true, data: emptyMetas }),
    typingTestTextStoreDelete: vi.fn().mockResolvedValue({ success: true }),
    aozoraImport: vi.fn(),
  } as unknown as typeof window.vialAPI

  observerCallback = null
  observerDisconnect = vi.fn()
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AozoraCatalogTab', () => {
  it('renders only the first page of the catalog initially', async () => {
    renderWithI18n(<AozoraCatalogTab onSelect={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getAllByTestId(/^aozora-row-/)).toHaveLength(50)
    })
    expect(screen.getByTestId('aozora-sentinel')).toBeInTheDocument()
  })

  it('appends the next page each time the sentinel intersects, and removes it once everything is rendered', async () => {
    window.vialAPI.langList = vi.fn().mockResolvedValue(makeCatalog(120))
    renderWithI18n(<AozoraCatalogTab onSelect={vi.fn()} />)

    await waitFor(() => expect(screen.getAllByTestId(/^aozora-row-/)).toHaveLength(50))

    fireSentinelIntersection()
    await waitFor(() => expect(screen.getAllByTestId(/^aozora-row-/)).toHaveLength(100))
    expect(screen.getByTestId('aozora-sentinel')).toBeInTheDocument()

    fireSentinelIntersection()
    await waitFor(() => expect(screen.getAllByTestId(/^aozora-row-/)).toHaveLength(120))
    expect(screen.queryByTestId('aozora-sentinel')).not.toBeInTheDocument()
  })

  it('resets to the first page when the query changes', async () => {
    window.vialAPI.langList = vi.fn().mockResolvedValue(makeCatalog(120))
    renderWithI18n(<AozoraCatalogTab onSelect={vi.fn()} />)

    await waitFor(() => expect(screen.getAllByTestId(/^aozora-row-/)).toHaveLength(50))
    fireSentinelIntersection()
    await waitFor(() => expect(screen.getAllByTestId(/^aozora-row-/)).toHaveLength(100))

    fireEvent.change(screen.getByTestId('aozora-search'), { target: { value: 'Work Title' } })

    await waitFor(() => {
      expect(screen.getAllByTestId(/^aozora-row-/)).toHaveLength(50)
    })
  })

  it('filters by case-insensitive substring match on title and author', async () => {
    renderWithI18n(<AozoraCatalogTab onSelect={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getAllByTestId(/^aozora-row-/).length).toBeGreaterThan(0)
    })

    fireEvent.change(screen.getByTestId('aozora-search'), { target: { value: 'distinctive' } })

    await waitFor(() => {
      const rows = screen.getAllByTestId(/^aozora-row-/)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toHaveTextContent('Distinctive Author')
    })
    expect(screen.queryByTestId('aozora-sentinel')).not.toBeInTheDocument()
  })

  it('imports an unimported work and selects the resulting text on success', async () => {
    const onSelect = vi.fn()
    vi.mocked(window.vialAPI.aozoraImport).mockResolvedValue({
      success: true,
      meta: { id: 'new-id', name: 'Work Title 0（Distinctive Author）', wordCount: 1000, filename: 'f.json', savedAt: '', updatedAt: '' },
    })

    renderWithI18n(<AozoraCatalogTab onSelect={onSelect} />)

    await waitFor(() => expect(screen.getByTestId('aozora-import-works/0.zip')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('aozora-import-works/0.zip'))

    await waitFor(() => {
      expect(window.vialAPI.aozoraImport).toHaveBeenCalledWith('works/0.zip')
      expect(onSelect).toHaveBeenCalledWith('new-id')
    })
  })

  it('shows a specific message for a DUPLICATE_NAME import failure', async () => {
    vi.mocked(window.vialAPI.aozoraImport).mockResolvedValue({
      success: false,
      errorCode: 'DUPLICATE_NAME',
      error: 'duplicate',
    })

    renderWithI18n(<AozoraCatalogTab onSelect={vi.fn()} />)

    await waitFor(() => expect(screen.getByTestId('aozora-import-works/0.zip')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('aozora-import-works/0.zip'))

    await waitFor(() => {
      expect(screen.getByTestId('aozora-error-works/0.zip')).toHaveTextContent('already exists')
    })
  })

  it('shows a generic download-failed message (with the code) for other errors', async () => {
    vi.mocked(window.vialAPI.aozoraImport).mockResolvedValue({
      success: false,
      errorCode: 'SIZE_MISMATCH',
      error: 'size mismatch',
    })

    renderWithI18n(<AozoraCatalogTab onSelect={vi.fn()} />)

    await waitFor(() => expect(screen.getByTestId('aozora-import-works/0.zip')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('aozora-import-works/0.zip'))

    await waitFor(() => {
      expect(screen.getByTestId('aozora-error-works/0.zip')).toHaveTextContent('SIZE_MISMATCH')
    })
  })

  it('shows a catalog-level error line instead of an empty result list when the initial load fails', async () => {
    window.vialAPI.langList = vi.fn().mockRejectedValue(new Error('network error'))

    renderWithI18n(<AozoraCatalogTab onSelect={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByTestId('aozora-catalog-error')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('aozora-row-works/0.zip')).not.toBeInTheDocument()
    expect(screen.queryByText(/no matching languages|no results/i)).not.toBeInTheDocument()
  })

  it('an already-imported work is clickable and calls onSelect with the linked text id', async () => {
    const onSelect = vi.fn()
    window.vialAPI.typingTestTextStoreList = vi.fn().mockResolvedValue({
      success: true,
      data: [{
        id: 'existing-id',
        name: 'Work Title 0（Distinctive Author）',
        wordCount: 1000,
        filename: 'f.json',
        savedAt: '',
        updatedAt: '',
        source: { provider: 'aozora', workId: 'works/0.zip' },
      }],
    })

    renderWithI18n(<AozoraCatalogTab onSelect={onSelect} />)

    await waitFor(() => expect(screen.getByTestId('aozora-row-works/0.zip')).toBeInTheDocument())
    // Already imported — no import button on that row.
    expect(screen.queryByTestId('aozora-import-works/0.zip')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('aozora-row-works/0.zip'))

    expect(onSelect).toHaveBeenCalledWith('existing-id')
  })

  it('shows the Romaji badge on an imported row whose text is kana-pure, and not on others', async () => {
    window.vialAPI.typingTestTextStoreList = vi.fn().mockResolvedValue({
      success: true,
      data: [
        {
          id: 'kana-id',
          name: 'Work Title 0（Distinctive Author）',
          wordCount: 1000,
          filename: 'f0.json',
          savedAt: '',
          updatedAt: '',
          source: { provider: 'aozora', workId: 'works/0.zip' },
          romajiCapable: true,
        },
        {
          id: 'kanji-id',
          name: 'Work Title 1（Author 1）',
          wordCount: 1000,
          filename: 'f1.json',
          savedAt: '',
          updatedAt: '',
          source: { provider: 'aozora', workId: 'works/1.zip' },
          romajiCapable: false,
        },
      ],
    })

    renderWithI18n(<AozoraCatalogTab onSelect={vi.fn()} />)

    await waitFor(() => expect(screen.getByTestId('aozora-row-works/0.zip')).toBeInTheDocument())
    expect(screen.getByTestId('aozora-row-works/0.zip')).toHaveTextContent('Romaji')
    expect(screen.getByTestId('aozora-row-works/1.zip')).not.toHaveTextContent('Romaji')
  })

  it('marks no row as current when no fileImport text is selected', async () => {
    // Regression: unimported rows have no textId, and outside fileImport mode
    // there is no currentTextId — undefined === undefined must not mark every
    // row as the selected one.
    renderWithI18n(<AozoraCatalogTab onSelect={vi.fn()} />)

    await waitFor(() => expect(screen.getAllByTestId(/^aozora-row-/).length).toBeGreaterThan(0))
    for (const row of screen.getAllByTestId(/^aozora-row-/)) {
      expect(row.className).not.toContain('bg-accent/10')
    }
  })

  it('marks only the row linked to the selected fileImport text as current', async () => {
    window.vialAPI.typingTestTextStoreList = vi.fn().mockResolvedValue({
      success: true,
      data: [{
        id: 'existing-id',
        name: 'Work Title 0（Distinctive Author）',
        wordCount: 1000,
        filename: 'f.json',
        savedAt: '',
        updatedAt: '',
        source: { provider: 'aozora', workId: 'works/0.zip' },
      }],
    })

    renderWithI18n(<AozoraCatalogTab currentTextId="existing-id" onSelect={vi.fn()} />)

    await waitFor(() => expect(screen.getByTestId('aozora-row-works/0.zip')).toBeInTheDocument())
    expect(screen.getByTestId('aozora-row-works/0.zip').className).toContain('bg-accent/10')
    expect(screen.getByTestId('aozora-row-works/1.zip').className).not.toContain('bg-accent/10')
  })
})

function makeSearchPartitionCatalog(): LanguageListEntry[] {
  return [
    { name: 'works/imported.zip', title: 'Shared Term Imported', author: 'Author A', wordCount: 1000, rightToLeft: false, fileSize: 2000, status: 'not-downloaded' },
    { name: 'works/avail.zip', title: 'Shared Term Available', author: 'Author B', wordCount: 1000, rightToLeft: false, fileSize: 2000, status: 'not-downloaded' },
    { name: 'works/other.zip', title: 'Unrelated Title', author: 'Author C', wordCount: 1000, rightToLeft: false, fileSize: 2000, status: 'not-downloaded' },
  ]
}

// Wraps a single imported meta (matching makeSearchPartitionCatalog's
// "imported" entry) in the typingTestTextStoreList result shape, for the
// tests below that only care about that one imported work.
function importedListResult() {
  return { success: true, data: [importedMeta('imported-id', 'Shared Term Imported（Author A）', 'works/imported.zip')] }
}

describe('AozoraCatalogTab sections and delete', () => {
  beforeEach(() => {
    window.vialAPI.langList = vi.fn().mockResolvedValue(makeSearchPartitionCatalog())
  })

  it('keeps an imported match under the Downloaded header instead of blending into Available during a search', async () => {
    window.vialAPI.typingTestTextStoreList = vi.fn().mockResolvedValue(importedListResult())

    renderWithI18n(<AozoraCatalogTab onSelect={vi.fn()} />)
    await waitFor(() => expect(screen.getAllByTestId(/^aozora-row-/)).toHaveLength(3))

    fireEvent.change(screen.getByTestId('aozora-search'), { target: { value: 'Shared Term' } })

    await waitFor(() => {
      expect(screen.getAllByTestId(/^aozora-row-/)).toHaveLength(2)
    })
    // Unrelated title is filtered out entirely.
    expect(screen.queryByTestId('aozora-row-works/other.zip')).not.toBeInTheDocument()

    // Both sections render with their sticky headers even mid-search.
    expect(screen.getByText('Downloaded')).toBeInTheDocument()
    expect(screen.getByText('Available')).toBeInTheDocument()

    // The imported match has no import button (it's already imported)...
    expect(screen.queryByTestId('aozora-import-works/imported.zip')).not.toBeInTheDocument()
    // ...while the non-imported match still offers one.
    expect(screen.getByTestId('aozora-import-works/avail.zip')).toBeInTheDocument()
  })

  it('deletes an imported work, returning it to the Available section once metas refresh', async () => {
    const emptyList = { success: true, data: emptyMetas }
    window.vialAPI.typingTestTextStoreList = vi.fn()
      .mockResolvedValueOnce(importedListResult())
      .mockResolvedValue(emptyList)

    renderWithI18n(<AozoraCatalogTab onSelect={vi.fn()} />)

    await waitFor(() => expect(screen.getByTestId('aozora-delete-works/imported.zip')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('aozora-delete-works/imported.zip'))

    await waitFor(() => {
      expect(window.vialAPI.typingTestTextStoreDelete).toHaveBeenCalledWith('imported-id')
    })
    await waitFor(() => {
      expect(screen.queryByTestId('aozora-delete-works/imported.zip')).not.toBeInTheDocument()
      expect(screen.getByTestId('aozora-import-works/imported.zip')).toBeInTheDocument()
    })
  })

  it('fires onDeleted with the deleted text id when the deleted work is the currently-selected text', async () => {
    window.vialAPI.typingTestTextStoreList = vi.fn().mockResolvedValue(importedListResult())
    const onDeleted = vi.fn()

    renderWithI18n(
      <AozoraCatalogTab currentTextId="imported-id" onSelect={vi.fn()} onDeleted={onDeleted} />,
    )

    await waitFor(() => expect(screen.getByTestId('aozora-delete-works/imported.zip')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('aozora-delete-works/imported.zip'))

    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('imported-id'))
  })

  it('fires onDeleted with the deleted text id even when it is not the currently-selected text', async () => {
    window.vialAPI.typingTestTextStoreList = vi.fn().mockResolvedValue(importedListResult())
    const onDeleted = vi.fn()

    renderWithI18n(
      <AozoraCatalogTab currentTextId="some-other-id" onSelect={vi.fn()} onDeleted={onDeleted} />,
    )

    await waitFor(() => expect(screen.getByTestId('aozora-delete-works/imported.zip')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('aozora-delete-works/imported.zip'))

    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('imported-id'))
  })
})

function kanaEntry(name: string, title: string, author: string, authorKana?: string): LanguageListEntry {
  return { name, title, author, authorKana, wordCount: 1000, rightToLeft: false, fileSize: 2000, status: 'not-downloaded' }
}

function importedMeta(id: string, name: string, workId: string): TypingTestTextMeta {
  return { id, name, wordCount: 1000, filename: 'f.json', savedAt: '', updatedAt: '', source: { provider: 'aozora', workId } }
}

function makeKanaCatalog(): LanguageListEntry[] {
  return [
    kanaEntry('works/dazai.zip', 'Run, Melos!', '太宰 治', 'だざい おさむ'), // タ row, タ column
    kanaEntry('works/mori.zip', 'The Dancing Girl', '森 鴎外', 'もり おうがい'), // マ row, モ column
    // No authorKana — display name is already katakana.
    kanaEntry('works/irving.zip', 'Rip Van Winkle', 'アーヴィング ワシントン'),
    // No authorKana, kanji display name — never matches a kana filter.
    kanaEntry('works/akutagawa.zip', 'Rashomon', '芥川 龍之介'),
  ]
}

describe('AozoraCatalogTab kana filter', () => {
  it('filters to a row and clears on re-click', async () => {
    window.vialAPI.langList = vi.fn().mockResolvedValue(makeKanaCatalog())
    renderWithI18n(<AozoraCatalogTab onSelect={vi.fn()} />)

    await waitFor(() => expect(screen.getAllByTestId(/^aozora-row-/)).toHaveLength(4))

    fireEvent.click(screen.getByTestId('aozora-kana-row-タ'))
    await waitFor(() => {
      const rows = screen.getAllByTestId(/^aozora-row-/)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toHaveTextContent('Run, Melos!')
    })

    fireEvent.click(screen.getByTestId('aozora-kana-row-タ'))
    await waitFor(() => expect(screen.getAllByTestId(/^aozora-row-/)).toHaveLength(4))
  })

  it('reveals the column tier only while a row is selected, and narrows the match on column pick', async () => {
    window.vialAPI.langList = vi.fn().mockResolvedValue(makeKanaCatalog())
    renderWithI18n(<AozoraCatalogTab onSelect={vi.fn()} />)

    await waitFor(() => expect(screen.getAllByTestId(/^aozora-row-/)).toHaveLength(4))
    expect(screen.queryByTestId('aozora-kana-columns')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('aozora-kana-row-マ'))
    await waitFor(() => expect(screen.getByTestId('aozora-kana-columns')).toBeInTheDocument())
    // マ row has both マミムメモ columns rendered — narrow to モ, the entry's actual column.
    fireEvent.click(screen.getByTestId('aozora-kana-col-モ'))

    await waitFor(() => {
      const rows = screen.getAllByTestId(/^aozora-row-/)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toHaveTextContent('The Dancing Girl')
    })

    // A different column under the same row narrows to zero matches.
    fireEvent.click(screen.getByTestId('aozora-kana-col-ミ'))
    await waitFor(() => expect(screen.queryAllByTestId(/^aozora-row-/)).toHaveLength(0))
  })

  it('clears the selected column when switching to a different row', async () => {
    window.vialAPI.langList = vi.fn().mockResolvedValue(makeKanaCatalog())
    renderWithI18n(<AozoraCatalogTab onSelect={vi.fn()} />)

    await waitFor(() => expect(screen.getAllByTestId(/^aozora-row-/)).toHaveLength(4))

    fireEvent.click(screen.getByTestId('aozora-kana-row-タ'))
    await waitFor(() => expect(screen.getByTestId('aozora-kana-columns')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('aozora-kana-col-タ'))
    await waitFor(() => expect(screen.getAllByTestId(/^aozora-row-/)).toHaveLength(1))

    fireEvent.click(screen.getByTestId('aozora-kana-row-マ'))
    await waitFor(() => {
      // Column narrowed to タ no longer applies — only the row filter does.
      const rows = screen.getAllByTestId(/^aozora-row-/)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toHaveTextContent('The Dancing Girl')
    })
    expect(screen.getByTestId('aozora-kana-col-モ').getAttribute('aria-pressed')).toBe('false')
  })

  it('combines the kana row filter with the text search as AND', async () => {
    window.vialAPI.langList = vi.fn().mockResolvedValue(makeKanaCatalog())
    renderWithI18n(<AozoraCatalogTab onSelect={vi.fn()} />)

    await waitFor(() => expect(screen.getAllByTestId(/^aozora-row-/)).toHaveLength(4))

    fireEvent.click(screen.getByTestId('aozora-kana-row-タ'))
    await waitFor(() => expect(screen.getAllByTestId(/^aozora-row-/)).toHaveLength(1))

    fireEvent.change(screen.getByTestId('aozora-search'), { target: { value: 'Rashomon' } })
    await waitFor(() => expect(screen.queryAllByTestId(/^aozora-row-/)).toHaveLength(0))
  })

  it('resets pagination to the first page when the kana filter changes', async () => {
    window.vialAPI.langList = vi.fn().mockResolvedValue(makeCatalog(120))
    renderWithI18n(<AozoraCatalogTab onSelect={vi.fn()} />)

    await waitFor(() => expect(screen.getAllByTestId(/^aozora-row-/)).toHaveLength(50))
    fireSentinelIntersection()
    await waitFor(() => expect(screen.getAllByTestId(/^aozora-row-/)).toHaveLength(100))

    // makeCatalog gives every entry the same authorKana (だざい おさむ, タ row),
    // so selecting タ still matches all 120 — but pagination must still reset.
    fireEvent.click(screen.getByTestId('aozora-kana-row-タ'))
    await waitFor(() => expect(screen.getAllByTestId(/^aozora-row-/)).toHaveLength(50))
  })

  it('hides an entry with no authorKana and a non-kana display name while a kana filter is active, but shows it unfiltered', async () => {
    window.vialAPI.langList = vi.fn().mockResolvedValue(makeKanaCatalog())
    renderWithI18n(<AozoraCatalogTab onSelect={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByTestId('aozora-row-works/akutagawa.zip')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('aozora-kana-row-タ'))
    await waitFor(() => {
      expect(screen.queryByTestId('aozora-row-works/akutagawa.zip')).not.toBeInTheDocument()
    })
  })

  it('falls back to a katakana display name for an entry with no authorKana', async () => {
    window.vialAPI.langList = vi.fn().mockResolvedValue(makeKanaCatalog())
    renderWithI18n(<AozoraCatalogTab onSelect={vi.fn()} />)

    await waitFor(() => expect(screen.getAllByTestId(/^aozora-row-/)).toHaveLength(4))

    fireEvent.click(screen.getByTestId('aozora-kana-row-ア'))
    await waitFor(() => {
      const rows = screen.getAllByTestId(/^aozora-row-/)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toHaveTextContent('Rip Van Winkle')
    })
  })

  it('applies the kana filter to the Imported section too', async () => {
    window.vialAPI.langList = vi.fn().mockResolvedValue(makeKanaCatalog())
    window.vialAPI.typingTestTextStoreList = vi.fn().mockResolvedValue({
      success: true,
      data: [importedMeta('dazai-id', 'Run, Melos!（太宰 治）', 'works/dazai.zip')],
    })
    renderWithI18n(<AozoraCatalogTab onSelect={vi.fn()} />)

    // Browsing: the imported dazai row sits in the Imported section.
    await waitFor(() => expect(screen.getAllByTestId(/^aozora-row-/)).toHaveLength(4))
    expect(screen.queryByTestId('aozora-import-works/dazai.zip')).not.toBeInTheDocument()

    // マ row matches only mori — the imported dazai work is hidden with it.
    fireEvent.click(screen.getByTestId('aozora-kana-row-マ'))
    await waitFor(() => {
      const rows = screen.getAllByTestId(/^aozora-row-/)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toHaveTextContent('The Dancing Girl')
    })

    // タ row matches dazai — the imported row comes back.
    fireEvent.click(screen.getByTestId('aozora-kana-row-タ'))
    await waitFor(() => {
      const rows = screen.getAllByTestId(/^aozora-row-/)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toHaveTextContent('Run, Melos!')
    })
  })
})
