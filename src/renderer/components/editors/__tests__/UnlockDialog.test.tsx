// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { UnlockDialog } from '../UnlockDialog'
import type { KleKey } from '../../../../shared/kle/types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'unlock.progress' && opts) return `${opts.current}/${opts.total}`
      const map: Record<string, string> = {
        'unlock.title': 'Unlock',
        'unlock.instructions': 'Press the highlighted keys',
        'unlock.cancel': 'Cancel',
        'editor.macro.unlockClickAgain': 'Click the macro key again after unlocking.',
        'editor.macro.unlockWarning': 'Do not store passwords or sensitive information in macros.',
      }
      return map[key] ?? key
    },
  }),
}))

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  keycodeLabel: (kc: string) => kc,
  isMask: () => false,
  findOuterKeycode: () => null,
  findInnerKeycode: () => null,
  isModifiableKeycode: () => false,
  extractModMask: () => 0,
  extractBasicKey: (code: number) => code & 0xff,
  buildModMaskKeycode: (mask: number, key: number) => (mask << 8) | key,
}))

function makeKey(row: number, col: number): KleKey {
  return {
    x: col, y: row, width: 1, height: 1,
    x2: 0, y2: 0, width2: 1, height2: 1,
    rotation: 0, rotationX: 0, rotationY: 0,
    color: '', labels: [], textColor: [], textSize: [],
    row, col, encoderIdx: -1, encoderDir: -1,
    layoutIndex: -1, layoutOption: -1,
    decal: false, nub: false, stepped: false, ghost: false,
  }
}

describe('UnlockDialog', () => {
  let unlockStart: ReturnType<typeof vi.fn>
  let unlockPoll: ReturnType<typeof vi.fn>
  let onComplete: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    unlockStart = vi.fn().mockResolvedValue(undefined)
    unlockPoll = vi.fn()
    onComplete = vi.fn()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const keys = [makeKey(0, 0), makeKey(0, 1), makeKey(1, 0)]
  const unlockKeys: [number, number][] = [[0, 0], [1, 0]]

  function renderDialog() {
    return render(
      <UnlockDialog
        keys={keys}
        unlockKeys={unlockKeys}
        unlockStart={unlockStart}
        unlockPoll={unlockPoll}
        onComplete={onComplete}
      />,
    )
  }

  it('highlights unlock keys with accent color and leaves others default', async () => {
    unlockPoll.mockResolvedValue([0, 0, 50])
    await act(async () => { renderDialog() })

    const rects = document.querySelectorAll('rect')
    // Key 0,0 (unlock key) → accent
    expect(rects[0].getAttribute('fill')).toBe('var(--accent-alt)')
    // Key 0,1 (not unlock key) → default
    expect(rects[1].getAttribute('fill')).toBe('var(--key-bg)')
    // Key 1,0 (unlock key) → accent
    expect(rects[2].getAttribute('fill')).toBe('var(--accent-alt)')
  })

  it('progresses from 0 to total as keys are pressed', async () => {
    // First poll: counter=50 (total captured as 50)
    unlockPoll.mockResolvedValueOnce([0, 0, 50])
    await act(async () => { renderDialog() })
    // setInterval fires first poll at t=200ms
    await act(async () => { vi.advanceTimersByTime(200) })
    await act(async () => {})

    // After first poll, total=50, counter=50, progress=0
    expect(screen.getByText('0/50')).toBeInTheDocument()

    // Second poll: counter=40 → progress = 50 - 40 = 10
    unlockPoll.mockResolvedValueOnce([0, 0, 40])
    await act(async () => { vi.advanceTimersByTime(200) })
    await act(async () => {})

    expect(screen.getByText('10/50')).toBeInTheDocument()

    // Third poll: counter=0 → progress = 50 - 0 = 50, but unlocked=0
    unlockPoll.mockResolvedValueOnce([0, 0, 0])
    await act(async () => { vi.advanceTimersByTime(200) })
    await act(async () => {})

    expect(screen.getByText('50/50')).toBeInTheDocument()
  })

  it('calls onComplete when unlocked=1', async () => {
    unlockPoll
      .mockResolvedValueOnce([0, 0, 50])
      .mockResolvedValueOnce([1, 0, 0])

    await act(async () => { renderDialog() })
    // First poll at t=200ms (counter=50)
    await act(async () => { vi.advanceTimersByTime(200) })
    await act(async () => {})

    // Second poll at t=400ms (unlocked=1)
    await act(async () => { vi.advanceTimersByTime(200) })
    await act(async () => {})

    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('does not render a cancel button', async () => {
    unlockPoll.mockResolvedValue([0, 0, 50])
    await act(async () => { renderDialog() })

    expect(screen.queryByText('Cancel')).not.toBeInTheDocument()
  })

  it('does not show macro warning by default', async () => {
    unlockPoll.mockResolvedValue([0, 0, 50])
    await act(async () => { renderDialog() })

    expect(screen.queryByTestId('macro-unlock-warning')).not.toBeInTheDocument()
  })

  it('shows macro warning when macroWarning is true', async () => {
    unlockPoll.mockResolvedValue([0, 0, 50])
    await act(async () => {
      render(
        <UnlockDialog
          keys={keys}
          unlockKeys={unlockKeys}
          unlockStart={unlockStart}
          unlockPoll={unlockPoll}
          onComplete={onComplete}
          macroWarning
        />,
      )
    })

    const warning = screen.getByTestId('macro-unlock-warning')
    expect(warning).toBeInTheDocument()
    expect(screen.getByText('Click the macro key again after unlocking.')).toBeInTheDocument()
    expect(screen.getByText('Do not store passwords or sensitive information in macros.')).toBeInTheDocument()
  })
})
