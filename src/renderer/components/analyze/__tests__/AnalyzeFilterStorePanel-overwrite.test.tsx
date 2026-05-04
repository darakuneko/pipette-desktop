// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Coverage for the duplicate-name overwrite flow on the analyze save
// panel. Mirrors LayoutStoreContent's pattern: first submit detects a
// duplicate label and switches the submit button to "Overwrite?" +
// Cancel; second submit invokes onOverwriteSave (or falls back to
// delete + save when no overwrite handler is wired in).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '../../../../../src/renderer/__tests__/setup'
import { I18nextProvider } from 'react-i18next'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '../../../i18n/locales/en.json'

import { AnalyzeFilterStorePanel } from '../AnalyzeFilterStorePanel'
import type { AnalyzeFilterSnapshotMeta } from '../../../../shared/types/analyze-filter-store'

if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  })
}

const ENTRIES: AnalyzeFilterSnapshotMeta[] = [
  { id: 'entry-1', label: 'Daily', filename: 'a.json', savedAt: '2026-05-01T00:00:00.000Z' },
  { id: 'entry-2', label: 'Weekly', filename: 'b.json', savedAt: '2026-05-02T00:00:00.000Z' },
]

function renderPanel(overrides: Partial<React.ComponentProps<typeof AnalyzeFilterStorePanel>> = {}) {
  const props: React.ComponentProps<typeof AnalyzeFilterStorePanel> = {
    uidSelected: true,
    entries: ENTRIES,
    saving: false,
    loading: false,
    onSave: vi.fn(async () => 'new-id'),
    onOverwriteSave: vi.fn(async () => 'new-id'),
    onLoad: vi.fn(async () => true),
    onRename: vi.fn(async () => true),
    onDelete: vi.fn(async () => true),
    onExportCurrentCsv: null,
    onExportEntryCsv: null,
    hubActions: null,
    ...overrides,
  }
  const utils = render(
    <I18nextProvider i18n={i18n}>
      <AnalyzeFilterStorePanel {...props} />
    </I18nextProvider>,
  )
  return { ...utils, props }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('AnalyzeFilterStorePanel overwrite flow', () => {
  it('shows the Save button by default', () => {
    renderPanel()
    expect(screen.getByTestId('analyze-filter-store-save-submit')).toBeInTheDocument()
    expect(screen.queryByTestId('analyze-filter-store-overwrite-confirm')).toBeNull()
  })

  it('switches to Overwrite? + Cancel when the typed label matches an existing entry', () => {
    renderPanel()
    const input = screen.getByTestId('analyze-filter-store-save-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Daily' } })
    fireEvent.submit(input.closest('form')!)
    expect(screen.queryByTestId('analyze-filter-store-save-submit')).toBeNull()
    expect(screen.getByTestId('analyze-filter-store-overwrite-confirm')).toHaveTextContent('Overwrite')
    expect(screen.getByTestId('analyze-filter-store-overwrite-cancel')).toBeInTheDocument()
  })

  it('invokes onOverwriteSave with the existing entry id when the user confirms', async () => {
    const { props } = renderPanel()
    const input = screen.getByTestId('analyze-filter-store-save-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Daily' } })
    fireEvent.submit(input.closest('form')!)
    fireEvent.click(screen.getByTestId('analyze-filter-store-overwrite-confirm'))
    await waitFor(() => expect(props.onOverwriteSave).toHaveBeenCalledTimes(1))
    expect(props.onOverwriteSave).toHaveBeenCalledWith('entry-1', 'Daily')
    expect(props.onSave).not.toHaveBeenCalled()
  })

  it('falls back to onDelete + onSave when no onOverwriteSave is provided', async () => {
    const { props } = renderPanel({ onOverwriteSave: undefined })
    const input = screen.getByTestId('analyze-filter-store-save-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Daily' } })
    fireEvent.submit(input.closest('form')!)
    fireEvent.click(screen.getByTestId('analyze-filter-store-overwrite-confirm'))
    await waitFor(() => expect(props.onDelete).toHaveBeenCalledWith('entry-1'))
    await waitFor(() => expect(props.onSave).toHaveBeenCalledWith('Daily'))
  })

  it('cancels the overwrite when the Cancel button is clicked', () => {
    renderPanel()
    const input = screen.getByTestId('analyze-filter-store-save-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Daily' } })
    fireEvent.submit(input.closest('form')!)
    fireEvent.click(screen.getByTestId('analyze-filter-store-overwrite-cancel'))
    expect(screen.getByTestId('analyze-filter-store-save-submit')).toBeInTheDocument()
    expect(screen.queryByTestId('analyze-filter-store-overwrite-confirm')).toBeNull()
  })

  it('clears the pending overwrite confirmation when the user edits the label', () => {
    renderPanel()
    const input = screen.getByTestId('analyze-filter-store-save-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Daily' } })
    fireEvent.submit(input.closest('form')!)
    expect(screen.getByTestId('analyze-filter-store-overwrite-confirm')).toBeInTheDocument()
    fireEvent.change(input, { target: { value: 'Daily 2' } })
    expect(screen.queryByTestId('analyze-filter-store-overwrite-confirm')).toBeNull()
    expect(screen.getByTestId('analyze-filter-store-save-submit')).toBeInTheDocument()
  })

  it('saves directly when the typed label is unique', async () => {
    const { props } = renderPanel()
    const input = screen.getByTestId('analyze-filter-store-save-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Brand new' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(props.onSave).toHaveBeenCalledWith('Brand new'))
    expect(props.onOverwriteSave).not.toHaveBeenCalled()
  })
})
