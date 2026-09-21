// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { DismissibleError, ERROR_DISMISS_MS } from '../DismissibleError'

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

describe('DismissibleError', () => {
  it('renders nothing when message is null', () => {
    const { container } = render(<DismissibleError message={null} onDismiss={vi.fn()} className="bg-danger/10" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('fires onDismiss once at 10000ms and not at 9999ms', () => {
    const onDismiss = vi.fn()
    render(<DismissibleError message="Something failed" onDismiss={onDismiss} className="bg-danger/10" />)

    act(() => { vi.advanceTimersByTime(ERROR_DISMISS_MS - 1) })
    expect(onDismiss).not.toHaveBeenCalled()

    act(() => { vi.advanceTimersByTime(1) })
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('close button fires onDismiss immediately and the timer does not fire again once message is null', () => {
    const onDismiss = vi.fn()
    const { rerender } = render(<DismissibleError message="Something failed" onDismiss={onDismiss} className="bg-danger/10" />)

    fireEvent.click(screen.getByRole('button', { name: 'common.close' }))
    expect(onDismiss).toHaveBeenCalledTimes(1)

    // A real caller reacts to onDismiss by clearing its error state, which
    // flows back in as message=null — that's what clears the timer.
    rerender(<DismissibleError message={null} onDismiss={onDismiss} className="bg-danger/10" />)

    act(() => { vi.advanceTimersByTime(ERROR_DISMISS_MS) })
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('restarts the timer when the message changes', () => {
    const onDismiss = vi.fn()
    const { rerender } = render(<DismissibleError message="First error" onDismiss={onDismiss} className="bg-danger/10" />)

    act(() => { vi.advanceTimersByTime(6000) })
    rerender(<DismissibleError message="Second error" onDismiss={onDismiss} className="bg-danger/10" />)

    // Original 10s window (6000 + 4000) has elapsed, but the timer restarted
    // when the message changed, so it should not have fired yet.
    act(() => { vi.advanceTimersByTime(4000) })
    expect(onDismiss).not.toHaveBeenCalled()

    act(() => { vi.advanceTimersByTime(ERROR_DISMISS_MS - 4000) })
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('re-shows and restarts the timer when the same text reappears after going null', () => {
    const onDismiss = vi.fn()
    const { rerender } = render(<DismissibleError message="Same error" onDismiss={onDismiss} className="bg-danger/10" />)

    act(() => { vi.advanceTimersByTime(9000) })
    rerender(<DismissibleError message={null} onDismiss={onDismiss} className="bg-danger/10" />)
    rerender(<DismissibleError message="Same error" onDismiss={onDismiss} className="bg-danger/10" />)

    act(() => { vi.advanceTimersByTime(9999) })
    expect(onDismiss).not.toHaveBeenCalled()

    act(() => { vi.advanceTimersByTime(1) })
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('clears the timer on unmount (onDismiss never fires)', () => {
    const onDismiss = vi.fn()
    const { unmount } = render(<DismissibleError message="Something failed" onDismiss={onDismiss} className="bg-danger/10" />)

    unmount()
    act(() => { vi.advanceTimersByTime(ERROR_DISMISS_MS) })
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('does not restart the timer when onDismiss identity changes, and calls the latest one', () => {
    const firstOnDismiss = vi.fn()
    const secondOnDismiss = vi.fn()
    const { rerender } = render(<DismissibleError message="Something failed" onDismiss={firstOnDismiss} className="bg-danger/10" />)

    act(() => { vi.advanceTimersByTime(9000) })
    rerender(<DismissibleError message="Something failed" onDismiss={secondOnDismiss} className="bg-danger/10" />)

    // If the timer had restarted, this wouldn't be enough to reach 10s from
    // the rerender. It should fire because the original timer (9000 elapsed
    // + 1000 more = 10000) is still the one running.
    act(() => { vi.advanceTimersByTime(1000) })
    expect(firstOnDismiss).not.toHaveBeenCalled()
    expect(secondOnDismiss).toHaveBeenCalledTimes(1)
  })

  it('sets role="alert" and an accessible name on the close button', () => {
    render(<DismissibleError message="Something failed" onDismiss={vi.fn()} className="bg-danger/10" />)
    expect(screen.getByRole('alert')).toHaveTextContent('Something failed')
    expect(screen.getByRole('button', { name: 'common.close' })).toBeInTheDocument()
  })
})
