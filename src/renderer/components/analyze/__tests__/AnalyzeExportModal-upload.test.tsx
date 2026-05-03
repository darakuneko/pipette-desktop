// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Coverage for the AnalyzeExportModal's upload mode. The export mode
// stays untested here (it predates the dual-mode refactor); this suite
// focuses on the new upload affordances: button label switch, status
// banner, and the categories Set forwarded to the onConfirm callback.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '../../../../../src/renderer/__tests__/setup'
import { I18nextProvider } from 'react-i18next'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '../../../i18n/locales/en.json'

import { AnalyzeExportModal, type AnalyzeUploadCallbacks } from '../AnalyzeExportModal'
import type { AnalyzeExportContext } from '../AnalyzeExportModal'

if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  })
}

const SNAPSHOT = {
  uid: 'kb-1',
  machineHash: 'm',
  productName: 'Test Board',
  savedAt: 1_000_000,
  layers: 1,
  matrix: { rows: 1, cols: 1 },
  keymap: [[['KC_NO']]],
  layout: { keys: [] },
}

const CTX: AnalyzeExportContext = {
  uid: 'kb-1',
  keyboardName: 'Test Board',
  machineHashOrAll: 'all',
  range: { fromMs: 0, toMs: 86_400_000 },
  deviceScope: 'all',
  appScopes: [],
  snapshot: SNAPSHOT as unknown as AnalyzeExportContext['snapshot'],
  heatmap: {
    selectedLayers: [0],
    groups: [[0]],
    frequentUsedN: 5,
    aggregateMode: 'cell',
    normalization: 'absolute',
    keyGroupFilter: 'all',
  },
  wpm: { granularity: 'auto', viewMode: 'timeSeries', minActiveMs: 60_000 },
  interval: { viewMode: 'timeSeries', granularity: 'auto' },
  activity: { metric: 'keystrokes', minActiveMs: 60_000 },
  layer: { baseLayer: 0 },
  layoutComparison: { sourceLayoutId: '', targetLayoutId: null },
  fingerOverrides: {},
  conditions: { device: 'All', app: 'All', keymap: '—', range: '7 days' },
}

function renderModal(overrides: Partial<React.ComponentProps<typeof AnalyzeExportModal>> = {}) {
  const upload: AnalyzeUploadCallbacks = {
    isUploading: false,
    uploadResult: null,
    isExisting: false,
    onConfirm: vi.fn(async () => ({ ok: true })),
  }
  const props: React.ComponentProps<typeof AnalyzeExportModal> = {
    isOpen: true,
    onClose: vi.fn(),
    ctx: CTX,
    mode: 'upload',
    upload,
    ...overrides,
  }
  const utils = render(
    <I18nextProvider i18n={i18n}>
      <AnalyzeExportModal {...props} />
    </I18nextProvider>,
  )
  return { ...utils, props, upload }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('AnalyzeExportModal (upload mode)', () => {
  it('labels the confirm button "Upload" for a fresh entry', () => {
    renderModal()
    expect(screen.getByTestId('analyze-export-confirm')).toHaveTextContent('Upload')
  })

  it('labels the confirm button "Update" for an entry that already lives on Hub', () => {
    renderModal({
      upload: {
        isUploading: false,
        uploadResult: null,
        isExisting: true,
        onConfirm: vi.fn(async () => ({ ok: true })),
      },
    })
    expect(screen.getByTestId('analyze-export-confirm')).toHaveTextContent('Update')
  })

  it('forwards the user category selection to onConfirm', async () => {
    const onConfirm = vi.fn(async () => ({ ok: true }))
    renderModal({
      upload: { isUploading: false, uploadResult: null, isExisting: false, onConfirm },
    })
    // Toggle off "wpm" — the rest stay enabled (allOn default).
    fireEvent.click(screen.getByTestId('analyze-export-toggle-wpm'))
    fireEvent.click(screen.getByTestId('analyze-export-confirm'))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
    const picked = onConfirm.mock.calls[0][0] as Set<string>
    expect(picked.has('wpm')).toBe(false)
    expect(picked.has('heatmap')).toBe(true)
    // Layout Comparison is intentionally never available in upload
    // mode (the renderer-side resolver isn't wired through), so it
    // never lands in the Set.
    expect(picked.has('layoutComparison')).toBe(false)
  })

  it('disables the confirm button while uploading and shows the busy label', () => {
    renderModal({
      upload: {
        isUploading: true,
        uploadResult: null,
        isExisting: false,
        onConfirm: vi.fn(async () => ({ ok: true })),
      },
    })
    const button = screen.getByTestId('analyze-export-confirm') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.textContent).toContain('Uploading')
  })

  it('renders the upload result banner when the parent reports a result', () => {
    renderModal({
      upload: {
        isUploading: false,
        uploadResult: { kind: 'success', message: 'Uploaded' },
        isExisting: false,
        onConfirm: vi.fn(async () => ({ ok: true })),
      },
    })
    expect(screen.getByTestId('analyze-export-upload-result')).toHaveTextContent('Uploaded')
  })

  it('keeps the modal open when onConfirm reports failure', async () => {
    const onConfirm = vi.fn(async () => ({ ok: false }))
    const { props } = renderModal({
      upload: { isUploading: false, uploadResult: null, isExisting: false, onConfirm },
    })
    fireEvent.click(screen.getByTestId('analyze-export-confirm'))
    await waitFor(() => expect(onConfirm).toHaveBeenCalled())
    // Parent's onClose stays untouched on failure — the modal lives on
    // so the user can read the error banner / retry.
    expect(props.onClose).not.toHaveBeenCalled()
  })
})
