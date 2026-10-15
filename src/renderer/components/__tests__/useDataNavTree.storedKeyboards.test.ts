// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// useDataNavTree's stored keyboards against both vialAPI implementations: a
// preload-like mock, and the Tauri shim's keyboard data members over a
// mocked Tauri IPC. Both answer from the same spy, so the tests read the
// same for each.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { useDataNavTree, resetDataNavCache } from '../data-modal/useDataNavTree'
import { dispatchSyncUnitApplied } from '../../hooks/use-sync-unit-applied'
import { keyboardDataApi } from '../../../tauri-shim/api/keyboard-data'
import type { StoredKeyboardInfo } from '../../../shared/types/sync'

let listStoredKeyboards: Mock<() => Promise<StoredKeyboardInfo[]>>

function installVialAPI(members: object): void {
  Object.defineProperty(window, 'vialAPI', {
    value: { typingAnalyticsListKeyboards: vi.fn().mockResolvedValue([]), ...members },
    writable: true,
    configurable: true,
  })
}

const backends = [
  { name: 'preload-like mock', install: () => installVialAPI({ listStoredKeyboards }) },
  {
    name: 'Tauri shim over mockIPC',
    install: () => {
      mockIPC((cmd) => {
        if (cmd === 'list_stored_keyboards') return listStoredKeyboards()
        throw new Error(`unexpected command ${cmd}`)
      })
      installVialAPI({ ...keyboardDataApi })
    },
  },
]

beforeEach(() => {
  resetDataNavCache()
  listStoredKeyboards = vi.fn<() => Promise<StoredKeyboardInfo[]>>()
})

afterEach(() => {
  clearMocks()
})

describe.each(backends)('useDataNavTree stored keyboards ($name)', (backend) => {
  beforeEach(() => {
    backend.install()
  })

  it('shows the keyboards the backend lists, in its order', async () => {
    listStoredKeyboards.mockResolvedValue([{ uid: '0xB', name: 'Board B' }, { uid: '0xA', name: 'Board A' }])
    const { result } = renderHook(() => useDataNavTree({ showHubTab: false, syncEnabled: false }))
    await waitFor(() => {
      expect(result.current.storedKeyboards).toEqual([{ uid: '0xB', name: 'Board B' }, { uid: '0xA', name: 'Board A' }])
    })
  })

  it('reads the list again when the keyboard names change', async () => {
    listStoredKeyboards.mockResolvedValueOnce([{ uid: '0xA', name: '0xA' }])
    const { result } = renderHook(() => useDataNavTree({ showHubTab: false, syncEnabled: false }))
    await waitFor(() => expect(result.current.storedKeyboards).toEqual([{ uid: '0xA', name: '0xA' }]))

    listStoredKeyboards.mockResolvedValueOnce([{ uid: '0xA', name: 'Named' }])
    act(() => {
      dispatchSyncUnitApplied('meta/keyboard-names')
    })
    await waitFor(() => expect(result.current.storedKeyboards).toEqual([{ uid: '0xA', name: 'Named' }]))
  })
})
