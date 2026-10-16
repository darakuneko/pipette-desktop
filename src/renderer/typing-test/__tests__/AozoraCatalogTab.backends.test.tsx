// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// The catalog tab's import of a work against both vialAPI implementations:
// a preload-like mock, and the Tauri shim's members over a mocked Tauri IPC
// (./typing-dataset-backends.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { clearMocks } from '@tauri-apps/api/mocks'
import i18n from '../../i18n'
import { AozoraCatalogTab, clearAozoraCatalogCache } from '../AozoraCatalogTab'
import type { LanguageListEntry } from '../../../shared/types/language-store'
import type { TypingTestTextMeta } from '../../../shared/types/typing-test-text-store'
import { type DatasetSpies, datasetSpies, preloadLikeMock, shimOverMockIPC } from './typing-dataset-backends'

const WORK_ID = '000001/files/1_ruby_1.zip'

const CATALOG: LanguageListEntry[] = [{
  name: WORK_ID,
  title: '作品',
  author: '著者',
  authorKana: 'ちょしゃ',
  wordCount: 100,
  rightToLeft: false,
  fileSize: 2000,
  status: 'not-downloaded',
}]

const META: TypingTestTextMeta = {
  id: '00000000-0000-4000-8000-000000000001',
  name: '作品（著者）',
  wordCount: 100,
  lineCount: 3,
  filename: '00000000-0000-4000-8000-000000000001_2026-10-16T12-00-00.000Z.json',
  savedAt: '2026-10-16T12:00:00.000Z',
  updatedAt: '2026-10-16T12:00:00.000Z',
  source: { provider: 'aozora', workId: WORK_ID },
}

/** jsdom has no IntersectionObserver; the tab's paging is not under test. */
class NoIntersections {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

afterEach(() => {
  clearMocks()
  vi.unstubAllGlobals()
})

describe.each([preloadLikeMock, shimOverMockIPC])('AozoraCatalogTab import ($name)', (backend) => {
  let spies: DatasetSpies

  beforeEach(() => {
    clearAozoraCatalogCache()
    vi.stubGlobal('IntersectionObserver', NoIntersections)
    spies = datasetSpies()
    spies.langList.mockResolvedValue(CATALOG)
    backend.install(spies)
  })

  /** Renders the tab and clicks the work's import button once it is
   *  listed, after `beforeClick`. */
  async function clickImport(onSelect = vi.fn(), beforeClick = (): void => {}): Promise<void> {
    render(<I18nextProvider i18n={i18n}><AozoraCatalogTab onSelect={onSelect} /></I18nextProvider>)
    await waitFor(() => expect(screen.getByTestId(`aozora-import-${WORK_ID}`)).toBeInTheDocument())
    beforeClick()
    fireEvent.click(screen.getByTestId(`aozora-import-${WORK_ID}`))
  }

  it('imports a work, lists it as imported and selects it', async () => {
    spies.aozoraImport.mockResolvedValue({ success: true, meta: META })
    const onSelect = vi.fn()
    await clickImport(onSelect, () => spies.typingTestTextStoreList.mockResolvedValue({ success: true, data: [META] }))
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(META.id))
    expect(spies.aozoraImport).toHaveBeenCalledWith(WORK_ID)
    expect(spies.langList).toHaveBeenCalledWith('aozora')
    // An imported work has no import button.
    await waitFor(() => expect(screen.queryByTestId(`aozora-import-${WORK_ID}`)).not.toBeInTheDocument())
    expect(screen.getByTestId(`aozora-row-${WORK_ID}`)).toBeInTheDocument()
  })

  it('shows the duplicate-name message for a work saved under a taken name', async () => {
    spies.aozoraImport.mockResolvedValue({
      success: false,
      errorCode: 'DUPLICATE_NAME',
      error: 'A text with the same name already exists',
    })
    await clickImport()
    await waitFor(() => expect(screen.getByTestId(`aozora-error-${WORK_ID}`)).toHaveTextContent('already exists'))
  })

  it('shows the error code of any other failure', async () => {
    spies.aozoraImport.mockResolvedValue({ success: false, errorCode: 'SIZE_MISMATCH', error: 'expected 2000 bytes, got 1999' })
    await clickImport()
    await waitFor(() => expect(screen.getByTestId(`aozora-error-${WORK_ID}`)).toHaveTextContent('SIZE_MISMATCH'))
    expect(screen.getByTestId(`aozora-import-${WORK_ID}`)).not.toBeDisabled()
  })
})
