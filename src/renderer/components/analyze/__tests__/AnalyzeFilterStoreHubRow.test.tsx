// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Visual state coverage for the analyze save panel's Hub row. Mirrors
// LayoutStoreHubRow behaviour: switch between Upload / Update+Remove
// depending on whether the entry already has a hubPostId, propagate
// the in-flight "Uploading…" / "Updating…" labels, and surface the
// last result banner only when its entryId matches.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '../../../../../src/renderer/__tests__/setup'
import { I18nextProvider } from 'react-i18next'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '../../../i18n/locales/en.json'

import { AnalyzeFilterStoreHubRow } from '../AnalyzeFilterStoreHubRow'
import type { AnalyzeFilterSnapshotMeta } from '../../../../shared/types/analyze-filter-store'

if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  })
}

const ENTRY: AnalyzeFilterSnapshotMeta = {
  id: 'entry-1',
  label: 'My filter',
  filename: 'entry-1.json',
  savedAt: '2026-05-03T00:00:00.000Z',
}

function renderRow(overrides: Partial<React.ComponentProps<typeof AnalyzeFilterStoreHubRow>> = {}) {
  const props: React.ComponentProps<typeof AnalyzeFilterStoreHubRow> = {
    entry: ENTRY,
    confirmHubRemoveId: null,
    setConfirmHubRemoveId: vi.fn(),
    onUploadToHub: vi.fn(),
    onUpdateOnHub: vi.fn(),
    onRemoveFromHub: vi.fn(),
    ...overrides,
  }
  return {
    ...render(
      <I18nextProvider i18n={i18n}>
        <AnalyzeFilterStoreHubRow {...props} />
      </I18nextProvider>,
    ),
    props,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('AnalyzeFilterStoreHubRow', () => {
  it('renders an Upload button when the entry has no hubPostId', () => {
    const { props } = renderRow()
    const upload = screen.getByTestId('analyze-filter-store-upload-hub-entry-1')
    expect(upload).toHaveTextContent('Upload')
    fireEvent.click(upload)
    expect(props.onUploadToHub).toHaveBeenCalledWith('entry-1')
    expect(screen.queryByTestId('analyze-filter-store-update-hub-entry-1')).toBeNull()
    expect(screen.queryByTestId('analyze-filter-store-hub-share-link')).toBeNull()
  })

  it('switches to Update + Remove + share link once the entry has a hubPostId', () => {
    renderRow({ entry: { ...ENTRY, hubPostId: 'post-1' }, hubOrigin: 'https://hub.example' })
    expect(screen.getByTestId('analyze-filter-store-update-hub-entry-1')).toHaveTextContent('Update')
    expect(screen.getByTestId('analyze-filter-store-remove-hub-entry-1')).toHaveTextContent('Remove')
    const link = screen.getByTestId('analyze-filter-store-hub-share-link') as HTMLAnchorElement
    expect(link.href).toBe('https://hub.example/post/post-1')
  })

  it('shows the in-flight label and disables the button while uploading', () => {
    renderRow({ hubUploading: 'entry-1' })
    const upload = screen.getByTestId('analyze-filter-store-upload-hub-entry-1') as HTMLButtonElement
    expect(upload).toHaveTextContent('Uploading')
    expect(upload.disabled).toBe(true)
  })

  it('surfaces the last upload result only when the entryId matches', () => {
    const { rerender } = renderRow({
      hubUploadResult: { kind: 'success', message: 'Uploaded', entryId: 'entry-1' },
    })
    expect(screen.getByTestId('analyze-filter-store-hub-result-entry-1')).toHaveTextContent('Uploaded')

    rerender(
      <I18nextProvider i18n={i18n}>
        <AnalyzeFilterStoreHubRow
          entry={ENTRY}
          confirmHubRemoveId={null}
          setConfirmHubRemoveId={vi.fn()}
          hubUploadResult={{ kind: 'error', message: 'Boom', entryId: 'other' }}
        />
      </I18nextProvider>,
    )
    expect(screen.queryByTestId('analyze-filter-store-hub-result-entry-1')).toBeNull()
  })

  it('asks for confirmation before invoking onRemoveFromHub', () => {
    const setConfirm = vi.fn()
    const { props } = renderRow({
      entry: { ...ENTRY, hubPostId: 'post-1' },
      setConfirmHubRemoveId: setConfirm,
    })
    fireEvent.click(screen.getByTestId('analyze-filter-store-remove-hub-entry-1'))
    expect(setConfirm).toHaveBeenCalledWith('entry-1')
    expect(props.onRemoveFromHub).not.toHaveBeenCalled()
  })

  it('runs the remove handler when the user confirms', () => {
    const { props } = renderRow({
      entry: { ...ENTRY, hubPostId: 'post-1' },
      confirmHubRemoveId: 'entry-1',
    })
    fireEvent.click(screen.getByTestId('analyze-filter-store-hub-remove-confirm-entry-1'))
    expect(props.onRemoveFromHub).toHaveBeenCalledWith('entry-1')
  })
})
