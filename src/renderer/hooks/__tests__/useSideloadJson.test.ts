// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSideloadJson } from '../useSideloadJson'
import { VALID_DEFINITION } from './fixtures/valid-definition'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

const mockSideloadJson = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  window.vialAPI = {
    ...(window.vialAPI ?? {}),
    sideloadJson: mockSideloadJson,
  } as unknown as typeof window.vialAPI
})

afterEach(() => {
  vi.restoreAllMocks()
})

function createHook() {
  const applyDefinition = vi.fn()
  const hook = renderHook(() => useSideloadJson(applyDefinition))
  return { applyDefinition, ...hook }
}

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

  it('sets error when data is undefined', async () => {
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
