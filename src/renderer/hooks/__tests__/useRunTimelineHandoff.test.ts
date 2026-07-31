// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useRunTimelineHandoff } from '../useRunTimelineHandoff'

function setup() {
  const setAnalyticsPageOpen = vi.fn()
  const setViewMode = vi.fn()
  const pendingTypingTestReentryRef = { current: false }
  const { result } = renderHook(() => useRunTimelineHandoff({
    setAnalyticsPageOpen, setViewMode, pendingTypingTestReentryRef,
  }))
  return { result, setAnalyticsPageOpen, setViewMode, pendingTypingTestReentryRef }
}

describe('useRunTimelineHandoff', () => {
  it('starts with no pending handoff', () => {
    const { result } = setup()
    expect(result.current.timelineHandoff).toBeNull()
  })

  it('opening a run arms the reentry ref and exposes the handoff immediately', () => {
    const { result, setAnalyticsPageOpen, setViewMode, pendingTypingTestReentryRef } = setup()

    act(() => result.current.openRunTimeline('run-1'))

    // Mirrors handleAnalyticsBack's typingTest branch: leave Analyze,
    // re-enter the typing test, and arm the same reentry ref App.tsx's
    // own remount effect already consumes.
    expect(setAnalyticsPageOpen).toHaveBeenCalledWith(false)
    expect(setViewMode).toHaveBeenCalledWith('typingTest')
    expect(pendingTypingTestReentryRef.current).toBe(true)
    // No parking step: the runId is plain state owned by this hook (which
    // belongs to App.tsx, never unmounted), so it's already the correct
    // value the moment KeymapEditor/TypingTestPane/HistoryToggle actually
    // mount — however many renders later that turns out to be.
    expect(result.current.timelineHandoff).toEqual({ runId: 'run-1', onConsumed: expect.any(Function) })
  })

  it('clears the handoff via its own onConsumed', () => {
    const { result } = setup()

    act(() => result.current.openRunTimeline('run-2'))
    expect(result.current.timelineHandoff?.runId).toBe('run-2')

    act(() => result.current.timelineHandoff?.onConsumed())
    expect(result.current.timelineHandoff).toBeNull()

    // A later History close (or any other consumer) calling clear again
    // once nothing is pending is a harmless no-op — there is nothing to
    // call, since `timelineHandoff` is already null.
    expect(result.current.timelineHandoff).toBeNull()
  })

  it('opening a second run replaces the first', () => {
    const { result } = setup()
    act(() => result.current.openRunTimeline('run-1'))
    act(() => result.current.openRunTimeline('run-2'))
    expect(result.current.timelineHandoff?.runId).toBe('run-2')
  })
})
