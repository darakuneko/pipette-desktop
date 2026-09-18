// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

import { QmkSettings } from '../QmkSettings'

// "Tap-Hold" tab carries one integer field (qsid 7, "Tapping Term") and one
// multi-bit boolean field (qsid 8 — "Permissive Hold" at bit 0, plus three
// more bit rows for the same qsid). Restricting supportedQsids to {7, 8}
// gives exactly one spinbutton and four checkboxes (all bound to qsid 8),
// enough to exercise a two-field save without pulling in the rest of the
// settings catalog.
const TAB_NAME = 'Tap-Hold'
const SUPPORTED = new Set([7, 8])

function defaultGetMock() {
  return vi.fn(async (qsid: number) => (qsid === 7 ? [100, 0] : [0]))
}

function tappingTermInput(): HTMLInputElement {
  return screen.getByRole('spinbutton') as HTMLInputElement
}

function permissiveHoldCheckbox(): HTMLInputElement {
  return screen.getAllByRole('checkbox')[0] as HTMLInputElement
}

// Drains pending microtask chains (the load effect's sequential
// qmkSettingsGet awaits, handleSave/handleReset's internal awaits) under
// fake timers. advanceTimersByTimeAsync(0) yields to the microtask queue;
// looping a few times gives enough headroom for multi-await chains.
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(0)
    }
  })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('QmkSettings save status', () => {
  it('shows Saved after a successful save, clears hasChanges, and fades after 2s', async () => {
    const setMock = vi.fn(async () => {})
    render(
      <QmkSettings
        tabName={TAB_NAME}
        supportedQsids={SUPPORTED}
        qmkSettingsGet={defaultGetMock()}
        qmkSettingsSet={setMock}
        qmkSettingsReset={vi.fn(async () => {})}
      />,
    )
    await flush()

    fireEvent.click(permissiveHoldCheckbox())
    const saveBtn = screen.getByTestId('qmk-save')
    expect(saveBtn).not.toBeDisabled()

    await act(async () => {
      fireEvent.click(saveBtn)
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(screen.getByTestId('qmk-save-status')).toHaveTextContent('common.saved')
    expect(saveBtn).toBeDisabled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(screen.getByTestId('qmk-save-status')).toHaveTextContent('')
  })

  it('shows a failure status, keeps the failed qsid editable, and applies the qsid that succeeded first', async () => {
    const setMock = vi.fn(async (qsid: number) => {
      if (qsid === 8) throw new Error('boom')
    })
    const onSettingsUpdate = vi.fn()
    render(
      <QmkSettings
        tabName={TAB_NAME}
        supportedQsids={SUPPORTED}
        qmkSettingsGet={defaultGetMock()}
        qmkSettingsSet={setMock}
        qmkSettingsReset={vi.fn(async () => {})}
        onSettingsUpdate={onSettingsUpdate}
      />,
    )
    await flush()
    onSettingsUpdate.mockClear() // drop the 2 load-time calls (one per supported qsid)

    fireEvent.change(tappingTermInput(), { target: { value: '150' } })
    fireEvent.click(permissiveHoldCheckbox())

    const saveBtn = screen.getByTestId('qmk-save')
    await act(async () => {
      fireEvent.click(saveBtn)
      await vi.advanceTimersByTimeAsync(0)
    })

    const status = screen.getByTestId('qmk-save-status')
    expect(status).toHaveTextContent('editor.keymap.qmkSettingsSaveFailed')
    // No field name leaks into the failure text.
    expect(status.textContent).not.toMatch(/permissive|tapping|qsid|8/i)

    expect(setMock).toHaveBeenCalledTimes(2)
    expect(onSettingsUpdate).toHaveBeenCalledTimes(1) // only the qsid that succeeded (7)
    expect(onSettingsUpdate).toHaveBeenCalledWith(7, expect.anything())

    // qsid 8's edit is still unsaved, so Save is enabled again.
    expect(saveBtn).not.toBeDisabled()
  })

  it('clears the failure display on the next value edit', async () => {
    const setMock = vi.fn(async (qsid: number) => {
      if (qsid === 8) throw new Error('boom')
    })
    render(
      <QmkSettings
        tabName={TAB_NAME}
        supportedQsids={SUPPORTED}
        qmkSettingsGet={defaultGetMock()}
        qmkSettingsSet={setMock}
        qmkSettingsReset={vi.fn(async () => {})}
      />,
    )
    await flush()

    fireEvent.click(permissiveHoldCheckbox())
    await act(async () => {
      fireEvent.click(screen.getByTestId('qmk-save'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByTestId('qmk-save-status')).toHaveTextContent('editor.keymap.qmkSettingsSaveFailed')

    fireEvent.change(tappingTermInput(), { target: { value: '200' } })
    expect(screen.getByTestId('qmk-save-status')).toHaveTextContent('')
  })

  it('clears the failure display when Revert is confirmed (arming alone does not clear it)', async () => {
    const setMock = vi.fn(async () => {
      throw new Error('boom')
    })
    render(
      <QmkSettings
        tabName={TAB_NAME}
        supportedQsids={SUPPORTED}
        qmkSettingsGet={defaultGetMock()}
        qmkSettingsSet={setMock}
        qmkSettingsReset={vi.fn(async () => {})}
      />,
    )
    await flush()

    fireEvent.click(permissiveHoldCheckbox())
    await act(async () => {
      fireEvent.click(screen.getByTestId('qmk-save'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByTestId('qmk-save-status')).toHaveTextContent('editor.keymap.qmkSettingsSaveFailed')

    const revertBtn = screen.getByTestId('qmk-revert')
    fireEvent.click(revertBtn) // arm the confirm — must not clear the failure yet
    expect(screen.getByTestId('qmk-save-status')).toHaveTextContent('editor.keymap.qmkSettingsSaveFailed')

    await act(async () => {
      fireEvent.click(revertBtn) // confirm -> handleUndo
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByTestId('qmk-save-status')).toHaveTextContent('')
  })

  it('clears the failure display when Reset is confirmed', async () => {
    const setMock = vi.fn(async () => {
      throw new Error('boom')
    })
    const resetMock = vi.fn(async () => {})
    render(
      <QmkSettings
        tabName={TAB_NAME}
        supportedQsids={SUPPORTED}
        qmkSettingsGet={defaultGetMock()}
        qmkSettingsSet={setMock}
        qmkSettingsReset={resetMock}
      />,
    )
    await flush()

    fireEvent.click(permissiveHoldCheckbox())
    await act(async () => {
      fireEvent.click(screen.getByTestId('qmk-save'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByTestId('qmk-save-status')).toHaveTextContent('editor.keymap.qmkSettingsSaveFailed')

    const resetBtn = screen.getByTestId('qmk-reset')
    fireEvent.click(resetBtn) // arm

    await act(async () => {
      fireEvent.click(resetBtn) // confirm -> handleReset
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByTestId('qmk-save-status')).toHaveTextContent('')
    expect(resetMock).toHaveBeenCalledTimes(1)
  })

  it('does not let an old saved-flash timer clear a failure that starts within its 2s window', async () => {
    let calls = 0
    const setMock = vi.fn(async (qsid: number) => {
      calls++
      // First save (qsid 8 only) succeeds. Second save (qsid 7 only) fails.
      if (qsid === 7) throw new Error('boom')
    })
    render(
      <QmkSettings
        tabName={TAB_NAME}
        supportedQsids={SUPPORTED}
        qmkSettingsGet={defaultGetMock()}
        qmkSettingsSet={setMock}
        qmkSettingsReset={vi.fn(async () => {})}
      />,
    )
    await flush()

    fireEvent.click(permissiveHoldCheckbox())
    await act(async () => {
      fireEvent.click(screen.getByTestId('qmk-save'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByTestId('qmk-save-status')).toHaveTextContent('common.saved')
    expect(calls).toBe(1)

    // Within the still-running 2s saved-flash window, edit and save again —
    // this time it fails.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    fireEvent.change(tappingTermInput(), { target: { value: '150' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('qmk-save'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByTestId('qmk-save-status')).toHaveTextContent('editor.keymap.qmkSettingsSaveFailed')

    // Advance past when the ORIGINAL saved-timer would have fired (500ms
    // already elapsed + 1600ms here > the original 2000ms budget). The
    // failure must still be showing — a stale timer must not clear it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600)
    })
    expect(screen.getByTestId('qmk-save-status')).toHaveTextContent('editor.keymap.qmkSettingsSaveFailed')
  })

  it('retries only the previously failed qsid on the next Save and succeeds', async () => {
    let shouldFail = true
    const setMock = vi.fn(async (qsid: number) => {
      if (qsid === 8 && shouldFail) throw new Error('boom')
    })
    render(
      <QmkSettings
        tabName={TAB_NAME}
        supportedQsids={SUPPORTED}
        qmkSettingsGet={defaultGetMock()}
        qmkSettingsSet={setMock}
        qmkSettingsReset={vi.fn(async () => {})}
      />,
    )
    await flush()

    fireEvent.change(tappingTermInput(), { target: { value: '150' } })
    fireEvent.click(permissiveHoldCheckbox())
    await act(async () => {
      fireEvent.click(screen.getByTestId('qmk-save'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByTestId('qmk-save-status')).toHaveTextContent('editor.keymap.qmkSettingsSaveFailed')

    setMock.mockClear()
    shouldFail = false
    await act(async () => {
      fireEvent.click(screen.getByTestId('qmk-save'))
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(setMock).toHaveBeenCalledTimes(1)
    expect(setMock).toHaveBeenCalledWith(8, expect.anything())
    expect(screen.getByTestId('qmk-save-status')).toHaveTextContent('common.saved')
  })

  it('disables Save/Reset/Revert and shows Saving... while a save is in flight', async () => {
    let resolveSet: (() => void) | undefined
    const setMock = vi.fn(() => new Promise<void>((resolve) => {
      resolveSet = resolve
    }))
    render(
      <QmkSettings
        tabName={TAB_NAME}
        supportedQsids={SUPPORTED}
        qmkSettingsGet={defaultGetMock()}
        qmkSettingsSet={setMock}
        qmkSettingsReset={vi.fn(async () => {})}
      />,
    )
    await flush()

    fireEvent.click(permissiveHoldCheckbox())
    fireEvent.click(screen.getByTestId('qmk-save'))

    expect(screen.getByTestId('qmk-save-status')).toHaveTextContent('common.saving')
    expect(screen.getByTestId('qmk-save')).toBeDisabled()
    expect(screen.getByTestId('qmk-reset')).toBeDisabled()
    expect(screen.getByTestId('qmk-revert')).toBeDisabled()

    await act(async () => {
      resolveSet?.()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByTestId('qmk-save-status')).toHaveTextContent('common.saved')
  })

  it('disables Save/Reset/Revert while a reset is in flight', async () => {
    let resolveReset: (() => void) | undefined
    const resetMock = vi.fn(() => new Promise<void>((resolve) => {
      resolveReset = resolve
    }))
    render(
      <QmkSettings
        tabName={TAB_NAME}
        supportedQsids={SUPPORTED}
        qmkSettingsGet={defaultGetMock()}
        qmkSettingsSet={vi.fn(async () => {})}
        qmkSettingsReset={resetMock}
      />,
    )
    await flush()

    const resetBtn = screen.getByTestId('qmk-reset')
    fireEvent.click(resetBtn) // arm
    fireEvent.click(resetBtn) // confirm -> handleReset, suspends at qmkSettingsReset()

    expect(resetBtn).toBeDisabled()
    expect(screen.getByTestId('qmk-save')).toBeDisabled()
    expect(screen.getByTestId('qmk-revert')).toBeDisabled()

    await act(async () => {
      resolveReset?.()
      await vi.advanceTimersByTimeAsync(0)
    })
  })

  it('does not update state or throw after unmounting mid-save', async () => {
    let resolveSet: (() => void) | undefined
    const setMock = vi.fn(() => new Promise<void>((resolve) => {
      resolveSet = resolve
    }))
    const { unmount } = render(
      <QmkSettings
        tabName={TAB_NAME}
        supportedQsids={SUPPORTED}
        qmkSettingsGet={defaultGetMock()}
        qmkSettingsSet={setMock}
        qmkSettingsReset={vi.fn(async () => {})}
      />,
    )
    await flush()

    fireEvent.click(permissiveHoldCheckbox())
    fireEvent.click(screen.getByTestId('qmk-save'))

    unmount()

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => {
      resolveSet?.()
      await vi.advanceTimersByTimeAsync(0)
    })
    const actWarnings = consoleErrorSpy.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && msg.includes('not wrapped in act'),
    )
    expect(actWarnings).toHaveLength(0)
    consoleErrorSpy.mockRestore()
  })
})
