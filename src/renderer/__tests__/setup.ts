// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// jsdom doesn't implement ResizeObserver, but several components (e.g.
// BasicKeyboardView, MacroTileGrid) rely on it. A minimal no-op shim lets
// jsdom-backed tests render them without the polyfill touching browser behavior.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
}

// Default vialAPI shim so renderer tests that mount components which
// call into the Key Label store (Settings → Tools, KeymapEditor toolbox,
// LayoutComparisonView, …) do not need to repeat the mock per file.
// Tests that exercise the IPC paths override these via vi.mock or
// Object.defineProperty(window, 'vialAPI', { value: ..., writable: true }).
if (typeof window !== 'undefined') {
  const noopOk = async <T>(value?: T): Promise<{ success: true; data?: T }> => ({ success: true, data: value })
  const existing = (window as { vialAPI?: Record<string, unknown> }).vialAPI ?? {}
  const stub = {
    hubGetOrigin: async () => 'https://pipette-hub-test.example',
    openExternal: async () => undefined,
    // Surface a few legacy ids by default so component tests that still
    // select 'dvorak' / 'colemak' / 'japanese' from the layout dropdown
    // keep working without per-file IPC mocks. Tests that need a clean
    // store override `keyLabelStoreList` themselves.
    keyLabelStoreList: async () => ({
      success: true,
      data: [
        { id: 'dvorak', name: 'Dvorak', uploaderName: 'pipette', filename: '', savedAt: '', updatedAt: '' },
        { id: 'colemak', name: 'Colemak', uploaderName: 'pipette', filename: '', savedAt: '', updatedAt: '' },
        { id: 'japanese', name: 'Japanese (QWERTY)', uploaderName: 'pipette', filename: '', savedAt: '', updatedAt: '' },
      ],
    }),
    keyLabelStoreListAll: async () => ({ success: true, data: [] }),
    keyLabelStoreGet: async () => ({ success: false, errorCode: 'NOT_FOUND' }),
    keyLabelStoreRename: noopOk,
    keyLabelStoreDelete: noopOk,
    keyLabelStoreImport: noopOk,
    keyLabelStoreExport: noopOk,
    keyLabelStoreReorder: noopOk,
    keyLabelStoreSetHubPostId: noopOk,
    keyLabelStoreHasName: async () => ({ success: true, data: false }),
    keyLabelHubList: async () => ({ success: true, data: { items: [], total: 0, page: 1, per_page: 20 } }),
    keyLabelHubDetail: async () => ({ success: false, errorCode: 'NOT_FOUND' }),
    keyLabelHubDownload: noopOk,
    keyLabelHubUpload: noopOk,
    keyLabelHubUpdate: noopOk,
    keyLabelHubDelete: noopOk,
    typingAnalyticsListAppsForRange: async () => [],
    // i18n pack store: every renderer that mounts SettingsModal pulls in
    // LanguagePacksModal → useI18nPackStore, which calls i18nPackList on
    // mount. Stub the read paths to an empty list and the change-notifier
    // to a no-op so component tests do not need per-file IPC mocks.
    i18nPackList: async () => ({ success: true, data: [] }),
    i18nPackGet: async () => ({ success: false, errorCode: 'NOT_FOUND' }),
    i18nPackHasName: async () => ({ success: true, data: false }),
    i18nPackRename: noopOk,
    i18nPackSetEnabled: noopOk,
    i18nPackDelete: noopOk,
    i18nPackSetHubPostId: noopOk,
    i18nPackImport: async () => ({ canceled: true }),
    i18nPackImportApply: noopOk,
    i18nPackExport: noopOk,
    i18nPackOnChanged: () => () => undefined,
    hubListI18nPosts: async () => ({ success: true, data: { items: [], total: 0, page: 1, perPage: 20 } }),
    hubDownloadI18nPost: noopOk,
    hubUploadI18nPost: noopOk,
    hubUpdateI18nPost: noopOk,
    hubDeleteI18nPost: noopOk,
  }
  Object.defineProperty(window, 'vialAPI', {
    value: { ...stub, ...existing },
    writable: true,
    configurable: true,
  })
}

afterEach(() => {
  cleanup()
})
