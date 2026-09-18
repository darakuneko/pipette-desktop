// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import type { ComponentProps } from 'react'
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

function renderSettings(overrides: Partial<ComponentProps<typeof QmkSettings>> = {}) {
  return render(
    <QmkSettings
      tabName={TAB_NAME}
      supportedQsids={SUPPORTED}
      qmkSettingsGet={defaultGetMock()}
      qmkSettingsSet={vi.fn(async () => {})}
      qmkSettingsReset={vi.fn(async () => {})}
      {...overrides}
    />,
  )
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

// Clicks the given testid and drains the resulting microtask chain — the
// pattern every save/revert/reset confirmation needs to settle.
async function clickAndSettle(testId: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId(testId))
    await vi.advanceTimersByTimeAsync(0)
  })
}

// Shared arrange step for the tests that only differ in what they do once a
// failed save is showing: render with a qmkSettingsSet that always rejects,
// edit the one field these tests touch, save, and assert the failure text.
async function arrangeFailedSave(
  overrides: Partial<ComponentProps<typeof QmkSettings>> = {},
): Promise<void> {
  renderSettings({
    qmkSettingsSet: vi.fn(async () => {
      throw new Error('boom')
    }),
    ...overrides,
  })
  await flush()

  fireEvent.click(permissiveHoldCheckbox())
  await clickAndSettle('qmk-save')
  expect(screen.getByTestId('qmk-save-status')).toHaveTextContent('editor.keymap.qmkSettingsSaveFailed')
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('QmkSettings save status', () => {
  it('shows Saved after a successful save, clears hasChanges, and fades after 2s', async () => {
    renderSettings()
    await flush()

    fireEvent.click(permissiveHoldCheckbox())
    const saveBtn = screen.getByTestId('qmk-save')
    expect(saveBtn).not.toBeDisabled()

    await clickAndSettle('qmk-save')

    expect(screen.getByTestId('qmk-save-status')).toHaveTextContent('common.saved')
    expect(saveBtn).toBeDisabled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(screen.getByTestId('qmk-save-status')).toBeEmptyDOMElement()
  })

  it('shows a failure status, keeps the failed qsid editable, and applies the qsid that succeeded first', async () => {
    const setMock = vi.fn(async (qsid: number) => {
      if (qsid === 8) throw new Error('boom')
    })
    const onSettingsUpdate = vi.fn()
    renderSettings({ qmkSettingsSet: setMock, onSettingsUpdate })
    await flush()
    onSettingsUpdate.mockClear() // drop the 2 load-time calls (one per supported qsid)

    fireEvent.change(tappingTermInput(), { target: { value: '150' } })
    fireEvent.click(permissiveHoldCheckbox())

    await clickAndSettle('qmk-save')

    expect(screen.getByTestId('qmk-save-status')).toHaveTextContent('editor.keymap.qmkSettingsSaveFailed')
    expect(setMock).toHaveBeenCalledTimes(2)
    expect(onSettingsUpdate).toHaveBeenCalledTimes(1) // only the qsid that succeeded (7)
    expect(onSettingsUpdate).toHaveBeenCalledWith(7, expect.anything())

    // qsid 8's edit is still unsaved, so Save is enabled again.
    expect(screen.getByTestId('qmk-save')).not.toBeDisabled()
  })

  it('clears the failure display on the next value edit', async () => {
    await arrangeFailedSave()

    fireEvent.change(tappingTermInput(), { target: { value: '200' } })
    expect(screen.getByTestId('qmk-save-status')).toBeEmptyDOMElement()
  })

  it('clears the failure display when Revert is confirmed (arming alone does not clear it)', async () => {
    await arrangeFailedSave()

    const revertBtn = screen.getByTestId('qmk-revert')
    fireEvent.click(revertBtn) // arm the confirm — must not clear the failure yet
    expect(screen.getByTestId('qmk-save-status')).toHaveTextContent('editor.keymap.qmkSettingsSaveFailed')

    await clickAndSettle('qmk-revert') // confirm -> handleUndo
    expect(screen.getByTestId('qmk-save-status')).toBeEmptyDOMElement()
  })

  it('clears the failure display when Reset is confirmed', async () => {
    const resetMock = vi.fn(async () => {})
    await arrangeFailedSave({ qmkSettingsReset: resetMock })

    const resetBtn = screen.getByTestId('qmk-reset')
    fireEvent.click(resetBtn) // arm
    await clickAndSettle('qmk-reset') // confirm -> handleReset

    expect(screen.getByTestId('qmk-save-status')).toBeEmptyDOMElement()
    expect(resetMock).toHaveBeenCalledTimes(1)
  })

  it('does not let an old saved-flash timer clear a failure that starts within its 2s window', async () => {
    const setMock = vi.fn(async (qsid: number) => {
      // First save (qsid 8 only) succeeds. Second save (qsid 7 only) fails.
      if (qsid === 7) throw new Error('boom')
    })
    renderSettings({ qmkSettingsSet: setMock })
    await flush()

    fireEvent.click(permissiveHoldCheckbox())
    await clickAndSettle('qmk-save')
    expect(screen.getByTestId('qmk-save-status')).toHaveTextContent('common.saved')
    expect(setMock).toHaveBeenCalledTimes(1)

    // Within the still-running 2s saved-flash window, edit and save again —
    // this time it fails.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    fireEvent.change(tappingTermInput(), { target: { value: '150' } })
    await clickAndSettle('qmk-save')
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
    renderSettings({ qmkSettingsSet: setMock })
    await flush()

    fireEvent.change(tappingTermInput(), { target: { value: '150' } })
    fireEvent.click(permissiveHoldCheckbox())
    await clickAndSettle('qmk-save')
    expect(screen.getByTestId('qmk-save-status')).toHaveTextContent('editor.keymap.qmkSettingsSaveFailed')

    setMock.mockClear()
    shouldFail = false
    await clickAndSettle('qmk-save')

    expect(setMock).toHaveBeenCalledTimes(1)
    expect(setMock).toHaveBeenCalledWith(8, expect.anything())
    expect(screen.getByTestId('qmk-save-status')).toHaveTextContent('common.saved')
  })

  it('disables Save/Reset/Revert and shows Saving... while a save is in flight', async () => {
    let resolveSet: (() => void) | undefined
    const setMock = vi.fn(() => new Promise<void>((resolve) => {
      resolveSet = resolve
    }))
    renderSettings({ qmkSettingsSet: setMock })
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

  it('disables Save/Reset/Revert and shows nothing while a reset is in flight, then re-enables Reset/Revert', async () => {
    let resolveReset: (() => void) | undefined
    const resetMock = vi.fn(() => new Promise<void>((resolve) => {
      resolveReset = resolve
    }))
    renderSettings({ qmkSettingsReset: resetMock })
    await flush()

    const resetBtn = screen.getByTestId('qmk-reset')
    fireEvent.click(resetBtn) // arm
    fireEvent.click(resetBtn) // confirm -> handleReset, suspends at qmkSettingsReset()

    expect(resetBtn).toBeDisabled()
    expect(screen.getByTestId('qmk-save')).toBeDisabled()
    expect(screen.getByTestId('qmk-revert')).toBeDisabled()
    expect(screen.getByTestId('qmk-save-status')).toBeEmptyDOMElement()

    await act(async () => {
      resolveReset?.()
      await vi.advanceTimersByTimeAsync(0)
    })

    // Reset/Revert are no longer blocked by the resetting flag. Save stays
    // disabled — the reset overwrites edited values with the freshly
    // fetched ones, so there are no pending changes left to save.
    expect(resetBtn).not.toBeDisabled()
    expect(screen.getByTestId('qmk-revert')).not.toBeDisabled()
    expect(screen.getByTestId('qmk-save-status')).toBeEmptyDOMElement()
  })

  it('does not schedule the saved flash after unmounting mid-save', async () => {
    let resolveSet: (() => void) | undefined
    const setMock = vi.fn(() => new Promise<void>((resolve) => {
      resolveSet = resolve
    }))
    const { unmount } = renderSettings({ qmkSettingsSet: setMock })
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

    // Without the mountedRef guard, the resolved save would have called
    // setStatus('saved') post-unmount, which schedules the 2s saved-flash
    // timer. Nothing should be pending.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ends the save as failed (not stuck at saving) when onSettingsUpdate throws after a successful device write', async () => {
    const onSettingsUpdate = vi.fn()
    renderSettings({ onSettingsUpdate })
    await flush() // load-time calls succeed so values/editedValues populate normally

    // Only the save-time call (triggered below) should throw.
    onSettingsUpdate.mockImplementation(() => {
      throw new Error('boom')
    })

    fireEvent.click(permissiveHoldCheckbox())
    await clickAndSettle('qmk-save')

    // A throw past a successful device write is surfaced as 'failed'
    // (documented in handleSave) rather than leaving status stuck at
    // 'saving' — Save/Reset/Revert must re-enable either way.
    expect(screen.getByTestId('qmk-save-status')).toHaveTextContent('editor.keymap.qmkSettingsSaveFailed')
    expect(screen.getByTestId('qmk-reset')).not.toBeDisabled()
    expect(screen.getByTestId('qmk-revert')).not.toBeDisabled()
  })

  it('renders the saving status without font-medium and the saved status with it', async () => {
    let resolveSet: (() => void) | undefined
    const setMock = vi.fn(() => new Promise<void>((resolve) => {
      resolveSet = resolve
    }))
    renderSettings({ qmkSettingsSet: setMock })
    await flush()

    fireEvent.click(permissiveHoldCheckbox())
    fireEvent.click(screen.getByTestId('qmk-save'))

    const statusEl = screen.getByTestId('qmk-save-status')
    expect(statusEl.className).not.toContain('font-medium')

    await act(async () => {
      resolveSet?.()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(statusEl.className).toContain('font-medium')
  })
})
