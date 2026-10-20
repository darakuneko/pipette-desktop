// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from '@testing-library/react'
import { UPDATE_CHECK_DELAY_MS, useUpdateCheck } from '../useUpdateCheck'
import { setupAppConfigMock, renderHookWithConfig, vialAPIMock } from './test-helpers'
import type { UpdateCheckResult, UpdateFailure } from '../../../shared/types/update'

const AVAILABLE: UpdateCheckResult = {
  status: 'available',
  version: '0.5.0-beta.3',
  currentVersion: '0.5.0-beta.2',
  releaseUrl: 'https://github.com/darakuneko/pipette-desktop/releases/tag/v0.5.0-beta.3',
  skipped: false,
}

let updateCheck: ReturnType<typeof vi.fn<() => Promise<UpdateCheckResult>>>
let updateTakeFailure: ReturnType<typeof vi.fn<() => Promise<UpdateFailure | null>>>
let visibilityListener: ((visible: boolean) => void) | null
let windowVisible: boolean

function install(): ReturnType<typeof setupAppConfigMock> {
  const mocks = setupAppConfigMock()
  Object.assign(vialAPIMock(), {
    updateCheck,
    updateTakeFailure,
    windowIsVisible: vi.fn(() => Promise.resolve(windowVisible)),
    onWindowVisibilityChanged: vi.fn((callback: (visible: boolean) => void) => {
      visibilityListener = callback
      return () => { visibilityListener = null }
    }),
  })
  return mocks
}

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

/** Lets the window's visibility arrive, then waits out the delay. */
async function untilChecked(): Promise<void> {
  await flush()
  await flush(UPDATE_CHECK_DELAY_MS)
}

describe('useUpdateCheck', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    updateCheck = vi.fn(() => Promise.resolve(AVAILABLE))
    updateTakeFailure = vi.fn(() => Promise.resolve(null))
    visibilityListener = null
    windowVisible = true
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('checks once the notices are done and closed, after the delay, then offers the update', async () => {
    install()
    const { result, rerender } = renderHookWithConfig(
      (notice: { settled: boolean; visible: boolean } = { settled: false, visible: false }) => useUpdateCheck(notice),
    )
    await flush(UPDATE_CHECK_DELAY_MS * 2)
    expect(updateCheck).not.toHaveBeenCalled()

    rerender({ settled: true, visible: true })
    await flush(UPDATE_CHECK_DELAY_MS * 2)
    expect(updateCheck).not.toHaveBeenCalled()

    rerender({ settled: true, visible: false })
    await flush(UPDATE_CHECK_DELAY_MS - 1)
    expect(updateCheck).not.toHaveBeenCalled()
    await flush(1)
    expect(updateCheck).toHaveBeenCalledTimes(1)
    expect(result.current.prompt).toEqual({
      kind: 'available',
      version: AVAILABLE.version,
      currentVersion: '0.5.0-beta.2',
      releaseUrl: AVAILABLE.releaseUrl,
    })

    rerender({ settled: true, visible: true })
    rerender({ settled: true, visible: false })
    await flush(UPDATE_CHECK_DELAY_MS * 2)
    expect(updateCheck).toHaveBeenCalledTimes(1)
  })

  it('waits for the window to be shown when the launch started in the tray', async () => {
    windowVisible = false
    install()
    renderHookWithConfig(() => useUpdateCheck({ settled: true, visible: false }))
    await flush(UPDATE_CHECK_DELAY_MS * 2)
    expect(updateCheck).not.toHaveBeenCalled()
    act(() => visibilityListener?.(true))
    await flush(UPDATE_CHECK_DELAY_MS)
    expect(updateCheck).toHaveBeenCalledTimes(1)
  })

  it('does not offer a version the user skipped', async () => {
    updateCheck = vi.fn(() => Promise.resolve({ ...AVAILABLE, skipped: true }))
    install()
    const { result } = renderHookWithConfig(() => useUpdateCheck({ settled: true, visible: false }))
    await untilChecked()
    expect(updateCheck).toHaveBeenCalledTimes(1)
    expect(result.current.prompt).toBeNull()
  })

  it('shows nothing when the check fails or the build does not update', async () => {
    for (const answer of [{ status: 'failed', code: 'network' }, { status: 'disabled' }, { status: 'upToDate' }] as const) {
      updateCheck = vi.fn(() => Promise.resolve(answer))
      install()
      const { result, unmount } = renderHookWithConfig(() => useUpdateCheck({ settled: true, visible: false }))
      await flush(UPDATE_CHECK_DELAY_MS)
      expect(result.current.prompt).toBeNull()
      unmount()
    }
  })

  it('shows the failure the last update left instead of checking', async () => {
    const failure: UpdateFailure = { version: '0.5.0-beta.3', code: 'permission', releaseUrl: AVAILABLE.releaseUrl }
    updateTakeFailure = vi.fn(() => Promise.resolve(failure))
    install()
    const { result } = renderHookWithConfig(() => useUpdateCheck({ settled: true, visible: false }))
    await untilChecked()
    expect(updateCheck).not.toHaveBeenCalled()
    expect(result.current.prompt).toEqual({ kind: 'failed', ...failure })
  })

  it('saves the skipped version and closes', async () => {
    const { mockAppConfigSet } = install()
    const { result } = renderHookWithConfig(() => useUpdateCheck({ settled: true, visible: false }))
    await untilChecked()
    act(() => result.current.skip())
    expect(result.current.prompt).toBeNull()
    expect(mockAppConfigSet).toHaveBeenCalledWith('updateSkippedVersion', AVAILABLE.version)
  })

  it('closes without saving on Not now', async () => {
    const { mockAppConfigSet } = install()
    const { result } = renderHookWithConfig(() => useUpdateCheck({ settled: true, visible: false }))
    await untilChecked()
    act(() => result.current.close())
    expect(result.current.prompt).toBeNull()
    expect(mockAppConfigSet).not.toHaveBeenCalledWith('updateSkippedVersion', expect.anything())
  })
})
