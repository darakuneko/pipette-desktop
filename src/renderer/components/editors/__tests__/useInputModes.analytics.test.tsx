// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useInputModes } from '../useInputModes'

const mockTypingAnalyticsEvent = vi.fn<(event: unknown) => Promise<void>>()
const mockTypingAnalyticsFlush = vi.fn<(uid: string) => Promise<void>>()

beforeEach(() => {
  mockTypingAnalyticsEvent.mockReset()
  mockTypingAnalyticsFlush.mockReset()
  mockTypingAnalyticsEvent.mockResolvedValue(undefined)
  mockTypingAnalyticsFlush.mockResolvedValue(undefined)
  Object.defineProperty(window, 'vialAPI', {
    value: {
      typingAnalyticsEvent: mockTypingAnalyticsEvent,
      typingAnalyticsFlush: mockTypingAnalyticsFlush,
    },
    writable: true,
    configurable: true,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

function buildKeymap(): Map<string, number> {
  // layer 0: (0,0) = 0x04 (KC_A basic keycode value)
  const m = new Map<string, number>()
  m.set('0,0,0', 0x04)
  return m
}

const sampleKeyboard = {
  uid: '0xAABB',
  vendorId: 0xFEED,
  productId: 0x0000,
  productName: 'Pipette Keyboard',
}

function renderUseInputModes(overrides: Partial<Parameters<typeof useInputModes>[0]>) {
  return renderHook(() => useInputModes({
    rows: 1,
    cols: 1,
    keymap: buildKeymap(),
    typingTestMode: true,
    typingTestViewOnly: true,
    typingRecordKeyboard: sampleKeyboard,
    ...overrides,
  }))
}

describe('useInputModes — typing analytics dispatch', () => {
  it('dispatches a matrix event with the active keyboard attached', () => {
    const { result } = renderUseInputModes({ typingRecordEnabled: true })

    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(['0,0']), buildKeymap())
    })

    expect(mockTypingAnalyticsEvent).toHaveBeenCalledTimes(1)
    expect(mockTypingAnalyticsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'matrix', row: 0, col: 0, keyboard: sampleKeyboard }),
    )
  })

  it('does not dispatch analytics events when recording is disabled', () => {
    const { result } = renderUseInputModes({ typingRecordEnabled: false })

    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(['0,0']), buildKeymap())
    })

    expect(mockTypingAnalyticsEvent).not.toHaveBeenCalled()
  })

  it('does not dispatch analytics events in regular typing-test mode (not view-only)', () => {
    const { result } = renderUseInputModes({
      typingRecordEnabled: true,
      typingTestViewOnly: false,
    })

    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(['0,0']), buildKeymap())
    })

    expect(mockTypingAnalyticsEvent).not.toHaveBeenCalled()
  })

  it('does not dispatch when the active keyboard is unknown', () => {
    const { result } = renderUseInputModes({
      typingRecordEnabled: true,
      typingRecordKeyboard: undefined,
    })

    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(['0,0']), buildKeymap())
    })

    expect(mockTypingAnalyticsEvent).not.toHaveBeenCalled()
  })

  it('resets press-edge tracking so the next ON toggle re-emits held keys', () => {
    const { result, rerender } = renderHook(
      ({ typingRecordEnabled }: { typingRecordEnabled: boolean }) => useInputModes({
        rows: 1,
        cols: 1,
        keymap: buildKeymap(),
        typingTestMode: true,
        typingTestViewOnly: true,
        typingRecordKeyboard: sampleKeyboard,
        typingRecordEnabled,
      }),
      { initialProps: { typingRecordEnabled: true } },
    )

    // Record ON → first press edge emits.
    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(['0,0']), buildKeymap())
    })
    expect(mockTypingAnalyticsEvent).toHaveBeenCalledTimes(1)

    // Record OFF → further frames are dropped.
    rerender({ typingRecordEnabled: false })
    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(['0,0']), buildKeymap())
    })
    expect(mockTypingAnalyticsEvent).toHaveBeenCalledTimes(1)

    // Record ON again → the reset effect clears prevPressed, so the same held
    // key is treated as a new edge and emitted.
    rerender({ typingRecordEnabled: true })
    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(['0,0']), buildKeymap())
    })
    expect(mockTypingAnalyticsEvent).toHaveBeenCalledTimes(2)
  })

  it('calls typingAnalyticsFlush when recording transitions from on to off', () => {
    const { rerender } = renderHook(
      ({ typingRecordEnabled }: { typingRecordEnabled: boolean }) => useInputModes({
        rows: 1,
        cols: 1,
        keymap: buildKeymap(),
        typingTestMode: true,
        typingTestViewOnly: true,
        typingRecordKeyboard: sampleKeyboard,
        typingRecordEnabled,
      }),
      { initialProps: { typingRecordEnabled: true } },
    )

    expect(mockTypingAnalyticsFlush).not.toHaveBeenCalled()

    rerender({ typingRecordEnabled: false })

    expect(mockTypingAnalyticsFlush).toHaveBeenCalledTimes(1)
    expect(mockTypingAnalyticsFlush).toHaveBeenCalledWith(sampleKeyboard.uid)
  })

  it('swallows IPC rejection silently (fire-and-forget)', async () => {
    mockTypingAnalyticsEvent.mockRejectedValueOnce(new Error('ipc down'))
    const handler = vi.fn()
    process.on('unhandledRejection', handler)

    const { result } = renderUseInputModes({ typingRecordEnabled: true })
    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(['0,0']), buildKeymap())
    })
    await new Promise((resolve) => setImmediate(resolve))

    process.off('unhandledRejection', handler)
    expect(handler).not.toHaveBeenCalled()
  })
})
