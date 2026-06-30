// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { LanguageSelectorModal } from '../LanguageSelectorModal'
import type { LanguageListEntry } from '../../../shared/types/language-store'

const mockLanguages: LanguageListEntry[] = [
  { name: 'english', wordCount: 200, rightToLeft: false, fileSize: 5000, status: 'bundled' },
  { name: 'english_1k', wordCount: 1000, rightToLeft: false, fileSize: 15000, status: 'downloaded' },
  { name: 'german', wordCount: 5000, rightToLeft: false, fileSize: 50000, status: 'not-downloaded' },
  { name: 'arabic', wordCount: 3000, rightToLeft: true, fileSize: 30000, status: 'not-downloaded' },
]

beforeEach(() => {
  window.vialAPI = {
    langList: vi.fn().mockResolvedValue(mockLanguages),
    langGet: vi.fn().mockResolvedValue(null),
    langDownload: vi.fn().mockResolvedValue({ success: true }),
    langDelete: vi.fn().mockResolvedValue({ success: true }),
  } as unknown as typeof window.vialAPI
})

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

    expect(window.vialAPI.langDownload).toHaveBeenCalledWith('german')
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
})
