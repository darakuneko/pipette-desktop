// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// The word list tab's calls against both vialAPI implementations: a
// plain mock, and the Tauri shim's members over a mocked Tauri IPC
// (./typing-dataset-backends.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { clearMocks } from '@tauri-apps/api/mocks'
import { LanguagePackTab } from '../LanguagePackTab'
import type { LanguageListEntry } from '../../../shared/types/language-store'
import { type DatasetSpies, datasetSpies, plainMock, shimOverMockIPC } from './typing-dataset-backends'

const LANGUAGES: LanguageListEntry[] = [
  { name: 'english', wordCount: 200, rightToLeft: false, fileSize: 5000, status: 'bundled' },
  { name: 'german', wordCount: 5000, rightToLeft: false, fileSize: 50000, status: 'not-downloaded' },
  { name: 'french', wordCount: 300, rightToLeft: false, fileSize: 3000, status: 'downloaded' },
]

afterEach(() => {
  clearMocks()
})

describe.each([plainMock, shimOverMockIPC])('LanguagePackTab ($name)', (backend) => {
  let spies: DatasetSpies

  beforeEach(() => {
    spies = datasetSpies()
    spies.langList.mockResolvedValue(LANGUAGES)
    backend.install(spies)
  })

  function renderTab(provider = 'monkeytype') {
    return render(<LanguagePackTab provider={provider} onSelect={vi.fn()} />)
  }

  it('lists the provider’s word lists', async () => {
    renderTab('tatoeba')
    await waitFor(() => expect(screen.getByTestId('language-row-german')).toBeInTheDocument())
    expect(spies.langList).toHaveBeenCalledWith('tatoeba')
    expect(screen.getByTestId('language-row-english')).toBeInTheDocument()
  })

  it('downloads a word list and shows it as downloaded', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByTestId('language-download-german')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('language-download-german'))
    await waitFor(() => expect(screen.queryByTestId('language-download-german')).not.toBeInTheDocument())
    expect(spies.langDownload).toHaveBeenCalledWith('german', 'monkeytype')
  })

  it('keeps a word list available when its download fails', async () => {
    spies.langDownload.mockResolvedValue({ success: false, error: 'HTTP 404' })
    renderTab()
    await waitFor(() => expect(screen.getByTestId('language-download-german')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('language-download-german'))
    await waitFor(() => expect(spies.langDownload).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByTestId('language-download-german')).not.toBeDisabled())
  })

  it('deletes a downloaded word list', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByTestId('language-delete-french')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('language-delete-french'))
    await waitFor(() => expect(screen.getByTestId('language-download-french')).toBeInTheDocument())
    expect(spies.langDelete).toHaveBeenCalledWith('french', 'monkeytype')
  })

  it('lists again after an applied dataset update', async () => {
    spies.checkTypingDatasetUpdate.mockResolvedValue({ provider: 'monkeytype', updateAvailable: true })
    spies.updateTypingDataset.mockResolvedValue({ provider: 'monkeytype', changed: true, fromVersion: 'a', toVersion: 'b' })
    renderTab()
    await waitFor(() => expect(screen.getByTestId('typing-dataset-update-button')).toBeInTheDocument())
    spies.langList.mockResolvedValue([{ name: 'spanish', wordCount: 1, rightToLeft: false, fileSize: 1, status: 'not-downloaded' }])
    fireEvent.click(screen.getByTestId('typing-dataset-update-button'))
    await waitFor(() => expect(screen.getByTestId('language-row-spanish')).toBeInTheDocument())
    expect(screen.queryByTestId('typing-dataset-update-banner')).not.toBeInTheDocument()
  })
})
