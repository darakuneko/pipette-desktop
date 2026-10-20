// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// Runs against both vialAPI implementations: a plain mock, and the
// Tauri shim's sideloadJson over a mocked Tauri IPC. The backend of the shim
// answers a file's text, so its command answers the mock's data as JSON
// text and the shim parses it back.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { useSideloadJson } from '../useSideloadJson'
import { filesApi } from '../../../tauri-shim/api/files'
import { VALID_DEFINITION } from './fixtures/valid-definition'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

const mockSideloadJson = vi.fn()

function installVialAPI(value: object): void {
  Object.defineProperty(window, 'vialAPI', { value, writable: true, configurable: true })
}

const plainMock = {
  name: 'plain mock',
  install: () => {
    installVialAPI({ sideloadJson: mockSideloadJson })
  },
}

const shimOverMockIPC = {
  name: 'Tauri shim over mockIPC',
  install: () => {
    mockIPC(async (cmd, payload) => {
      if (cmd !== 'file_sideload_json') throw new Error(`unexpected command ${cmd}`)
      const { title } = payload as { title?: string }
      const result = (await (title === undefined ? mockSideloadJson() : mockSideloadJson(title))) as
        | { success: boolean; data?: unknown }
        | undefined
      return result?.success ? { ...result, data: JSON.stringify(result.data) } : result
    })
    installVialAPI({ ...filesApi })
  },
}

afterEach(() => {
  vi.restoreAllMocks()
  clearMocks()
})

function createHook() {
  const applyDefinition = vi.fn()
  const hook = renderHook(() => useSideloadJson(applyDefinition))
  return { applyDefinition, ...hook }
}

describe.each([plainMock, shimOverMockIPC])('useSideloadJson ($name)', (backend) => {
  beforeEach(() => {
    vi.clearAllMocks()
    backend.install()
  })

  // ---------------------------------------------------------------------------
  // Success
  // ---------------------------------------------------------------------------

  describe('useSideloadJson – success', () => {
    it('calls applyDefinition with valid definition JSON', async () => {
      mockSideloadJson.mockResolvedValueOnce({
        success: true,
        data: VALID_DEFINITION,
      })
      const { result, applyDefinition } = createHook()

      await act(async () => {
        await result.current.sideloadJson()
      })

      expect(applyDefinition).toHaveBeenCalledOnce()
      expect(applyDefinition).toHaveBeenCalledWith(VALID_DEFINITION)
      expect(result.current.error).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // Cancel
  // ---------------------------------------------------------------------------

  describe('useSideloadJson – cancel', () => {
    it('does not set error when user cancels dialog', async () => {
      mockSideloadJson.mockResolvedValueOnce({
        success: false,
        error: 'cancelled',
      })
      const { result, applyDefinition } = createHook()

      await act(async () => {
        await result.current.sideloadJson()
      })

      expect(applyDefinition).not.toHaveBeenCalled()
      expect(result.current.error).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // IPC failure
  // ---------------------------------------------------------------------------

  describe('useSideloadJson – IPC failure', () => {
    it('sets error on IPC failure with error string', async () => {
      mockSideloadJson.mockResolvedValueOnce({
        success: false,
        error: 'read error',
      })
      const { result, applyDefinition } = createHook()

      await act(async () => {
        await result.current.sideloadJson()
      })

      expect(applyDefinition).not.toHaveBeenCalled()
      expect(result.current.error).toBe('error.sideloadFailed')
    })

    it('sets error on IPC exception', async () => {
      mockSideloadJson.mockRejectedValueOnce(new Error('IPC crash'))
      const { result, applyDefinition } = createHook()

      await act(async () => {
        await result.current.sideloadJson()
      })

      expect(applyDefinition).not.toHaveBeenCalled()
      expect(result.current.error).toBe('error.sideloadFailed')
    })
  })

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  describe('useSideloadJson – validation', () => {
    it('sets error when matrix is missing', async () => {
      mockSideloadJson.mockResolvedValueOnce({
        success: true,
        data: { layouts: { keymap: [] } },
      })
      const { result, applyDefinition } = createHook()

      await act(async () => {
        await result.current.sideloadJson()
      })

      expect(applyDefinition).not.toHaveBeenCalled()
      expect(result.current.error).toBe('error.sideloadInvalidDefinition')
    })

    it('sets error when layouts is missing', async () => {
      mockSideloadJson.mockResolvedValueOnce({
        success: true,
        data: { matrix: { rows: 2, cols: 3 } },
      })
      const { result, applyDefinition } = createHook()

      await act(async () => {
        await result.current.sideloadJson()
      })

      expect(applyDefinition).not.toHaveBeenCalled()
      expect(result.current.error).toBe('error.sideloadInvalidDefinition')
    })

    it('sets error when data is null', async () => {
      mockSideloadJson.mockResolvedValueOnce({
        success: true,
        data: null,
      })
      const { result, applyDefinition } = createHook()

      await act(async () => {
        await result.current.sideloadJson()
      })

      expect(applyDefinition).not.toHaveBeenCalled()
      expect(result.current.error).toBe('error.sideloadInvalidDefinition')
    })

    it('sets error when data is an array', async () => {
      mockSideloadJson.mockResolvedValueOnce({
        success: true,
        data: [1, 2, 3],
      })
      const { result, applyDefinition } = createHook()

      await act(async () => {
        await result.current.sideloadJson()
      })

      expect(applyDefinition).not.toHaveBeenCalled()
      expect(result.current.error).toBe('error.sideloadInvalidDefinition')
    })

    it('sets error when data is a string', async () => {
      mockSideloadJson.mockResolvedValueOnce({
        success: true,
        data: 'not an object',
      })
      const { result, applyDefinition } = createHook()

      await act(async () => {
        await result.current.sideloadJson()
      })

      expect(applyDefinition).not.toHaveBeenCalled()
      expect(result.current.error).toBe('error.sideloadInvalidDefinition')
    })

    // A file's text always parses to a value, so the Tauri backend never
    // answers success without data.
    it.runIf(backend === plainMock)('sets error when data is undefined', async () => {
      mockSideloadJson.mockResolvedValueOnce({
        success: true,
        data: undefined,
      })
      const { result, applyDefinition } = createHook()

      await act(async () => {
        await result.current.sideloadJson()
      })

      expect(applyDefinition).not.toHaveBeenCalled()
      expect(result.current.error).toBe('error.sideloadInvalidDefinition')
    })

    it('sets error when data is a number', async () => {
      mockSideloadJson.mockResolvedValueOnce({
        success: true,
        data: 42,
      })
      const { result, applyDefinition } = createHook()

      await act(async () => {
        await result.current.sideloadJson()
      })

      expect(applyDefinition).not.toHaveBeenCalled()
      expect(result.current.error).toBe('error.sideloadInvalidDefinition')
    })

    it('sets error when matrix has wrong type (not an object)', async () => {
      mockSideloadJson.mockResolvedValueOnce({
        success: true,
        data: { matrix: 1, layouts: { keymap: [] } },
      })
      const { result, applyDefinition } = createHook()

      await act(async () => {
        await result.current.sideloadJson()
      })

      expect(applyDefinition).not.toHaveBeenCalled()
      expect(result.current.error).toBe('error.sideloadInvalidDefinition')
    })

    it('sets error when matrix.rows is missing', async () => {
      mockSideloadJson.mockResolvedValueOnce({
        success: true,
        data: { matrix: { cols: 3 }, layouts: { keymap: [] } },
      })
      const { result, applyDefinition } = createHook()

      await act(async () => {
        await result.current.sideloadJson()
      })

      expect(applyDefinition).not.toHaveBeenCalled()
      expect(result.current.error).toBe('error.sideloadInvalidDefinition')
    })

    it('sets error when layouts.keymap is missing', async () => {
      mockSideloadJson.mockResolvedValueOnce({
        success: true,
        data: { matrix: { rows: 2, cols: 3 }, layouts: {} },
      })
      const { result, applyDefinition } = createHook()

      await act(async () => {
        await result.current.sideloadJson()
      })

      expect(applyDefinition).not.toHaveBeenCalled()
      expect(result.current.error).toBe('error.sideloadInvalidDefinition')
    })

    it('sets error when layouts.keymap is not an array', async () => {
      mockSideloadJson.mockResolvedValueOnce({
        success: true,
        data: { matrix: { rows: 2, cols: 3 }, layouts: { keymap: {} } },
      })
      const { result, applyDefinition } = createHook()

      await act(async () => {
        await result.current.sideloadJson()
      })

      expect(applyDefinition).not.toHaveBeenCalled()
      expect(result.current.error).toBe('error.sideloadInvalidDefinition')
    })

    it('sets error when layouts is a primitive', async () => {
      mockSideloadJson.mockResolvedValueOnce({
        success: true,
        data: { matrix: { rows: 2, cols: 3 }, layouts: true },
      })
      const { result, applyDefinition } = createHook()

      await act(async () => {
        await result.current.sideloadJson()
      })

      expect(applyDefinition).not.toHaveBeenCalled()
      expect(result.current.error).toBe('error.sideloadInvalidDefinition')
    })
  })

  // ---------------------------------------------------------------------------
  // Error management
  // ---------------------------------------------------------------------------

  describe('useSideloadJson – error management', () => {
    it('clears previous error on next call', async () => {
      // First call fails
      mockSideloadJson.mockResolvedValueOnce({
        success: false,
        error: 'read error',
      })
      const { result } = createHook()

      await act(async () => {
        await result.current.sideloadJson()
      })
      expect(result.current.error).toBe('error.sideloadFailed')

      // Second call succeeds — error should clear
      mockSideloadJson.mockResolvedValueOnce({
        success: true,
        data: VALID_DEFINITION,
      })
      await act(async () => {
        await result.current.sideloadJson()
      })
      expect(result.current.error).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // clearError
  // ---------------------------------------------------------------------------

  describe('useSideloadJson – clearError', () => {
    it('clears a set error', async () => {
      mockSideloadJson.mockResolvedValueOnce({
        success: false,
        error: 'read error',
      })
      const { result } = createHook()

      await act(async () => {
        await result.current.sideloadJson()
      })
      expect(result.current.error).toBe('error.sideloadFailed')

      act(() => {
        result.current.clearError()
      })

      expect(result.current.error).toBeNull()
    })
  })
})
