// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { AppErrorBanner } from '../AppErrorBanner'
import { ERROR_DISMISS_MS } from '../ui/DismissibleError'
import type { useFileIO } from '../../hooks/useFileIO'
import type { useSideloadJson } from '../../hooks/useSideloadJson'
import type { useLayoutStore } from '../../hooks/useLayoutStore'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

function makeProps(overrides: {
  fileIOError?: string | null
  sideloadError?: string | null
  layoutStoreError?: string | null
  fileIOClear?: () => void
  sideloadClear?: () => void
  layoutStoreClear?: () => void
} = {}) {
  return {
    fileIO: { error: overrides.fileIOError ?? null, clearError: overrides.fileIOClear ?? vi.fn() } as unknown as ReturnType<typeof useFileIO>,
    sideload: { error: overrides.sideloadError ?? null, clearError: overrides.sideloadClear ?? vi.fn() } as unknown as ReturnType<typeof useSideloadJson>,
    layoutStore: { error: overrides.layoutStoreError ?? null, clearError: overrides.layoutStoreClear ?? vi.fn() } as unknown as ReturnType<typeof useLayoutStore>,
  }
}

describe('AppErrorBanner', () => {
  it('renders nothing when all three sources are null', () => {
    const { container } = render(<AppErrorBanner {...makeProps()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders two independent banners when two sources are set, each with its own auto-dismiss clock', () => {
    const fileIOClear = vi.fn()
    const sideloadClear = vi.fn()
    const STAGGER_MS = 6_000

    // Start with only the file-IO banner mounted, then let 6s of its clock
    // elapse before the sideload banner appears. If the two banners shared
    // a single clock (e.g. keyed off first-mount time), the sideload
    // banner would inherit the elapsed 6s and fire 4s early below.
    const { rerender } = render(<AppErrorBanner {...makeProps({ fileIOError: 'File error', fileIOClear })} />)
    act(() => { vi.advanceTimersByTime(STAGGER_MS) })

    rerender(<AppErrorBanner {...makeProps({ fileIOError: 'File error', sideloadError: 'Sideload error', fileIOClear, sideloadClear })} />)

    expect(screen.getByTestId('file-io-error-banner')).toHaveTextContent('File error')
    expect(screen.getByTestId('sideload-error-banner')).toHaveTextContent('Sideload error')
    expect(screen.queryByTestId('layout-store-error-banner')).not.toBeInTheDocument()

    // File-IO's clock started at t=0, so it clears at t=10s — 4s from now.
    act(() => { vi.advanceTimersByTime(ERROR_DISMISS_MS - STAGGER_MS) })
    expect(fileIOClear).toHaveBeenCalledTimes(1)
    expect(sideloadClear).not.toHaveBeenCalled()

    // Sideload's own clock started at t=6s, so it clears at t=16s —
    // 5.999s from now. Confirm it hasn't fired a moment early…
    act(() => { vi.advanceTimersByTime(STAGGER_MS - 1) })
    expect(sideloadClear).not.toHaveBeenCalled()

    // …then fires exactly on its own independent schedule.
    act(() => { vi.advanceTimersByTime(1) })
    expect(sideloadClear).toHaveBeenCalledTimes(1)
  })

  it('close button clears only its own source', () => {
    const fileIOClear = vi.fn()
    const layoutStoreClear = vi.fn()
    render(<AppErrorBanner {...makeProps({ fileIOError: 'File error', layoutStoreError: 'Layout store error', fileIOClear, layoutStoreClear })} />)

    const fileBanner = screen.getByTestId('file-io-error-banner')
    fireEvent.click(fileBanner.querySelector('button')!)

    expect(fileIOClear).toHaveBeenCalledTimes(1)
    expect(layoutStoreClear).not.toHaveBeenCalled()
  })
})
