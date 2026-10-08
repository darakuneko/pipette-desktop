// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later
// The goal card follows a sync merge of the shown keyboard's settings while
// keeping a goal draft the user has not committed.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { PipetteSettings } from '../../../../shared/types/pipette-settings'
import { StreakGoalCard } from '../StreakGoalCard'
import { dispatchSyncUnitApplied } from '../../../hooks/use-sync-unit-applied'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const getSpy = vi.fn<(uid: string) => Promise<PipetteSettings | null>>()
const patchSpy = vi.fn<(uid: string, partial: Partial<PipetteSettings>) => Promise<{ success: true }>>()

function settings(goalDays: number, goalKeystrokes: number): PipetteSettings {
  return { _rev: 1, keyboardLayout: 'qwerty', autoAdvance: true, layerNames: [], analyze: { goalDays, goalKeystrokes } }
}

beforeEach(() => {
  getSpy.mockReset()
  patchSpy.mockReset().mockResolvedValue({ success: true })
  Object.defineProperty(window, 'vialAPI', {
    value: {
      pipetteSettingsGet: (uid: string) => getSpy(uid),
      pipetteSettingsPatch: (uid: string, partial: Partial<PipetteSettings>) => patchSpy(uid, partial),
    },
    writable: true,
    configurable: true,
  })
})

function daysInput(): HTMLInputElement {
  return screen.getByTestId('analyze-streak-goal-days') as HTMLInputElement
}

function keystrokesInput(): HTMLInputElement {
  return screen.getByTestId('analyze-streak-goal-keystrokes') as HTMLInputElement
}

async function renderCard(initial: PipetteSettings): Promise<void> {
  getSpy.mockResolvedValueOnce(initial)
  render(<StreakGoalCard uid="selected" daily={[]} today="2026-10-08" />)
  await waitFor(() => expect(daysInput().value).toBe(String(initial.analyze?.goalDays)))
}

describe('StreakGoalCard sync reload', () => {
  it('re-reads the shown keyboard\'s goal only for its own settings unit', async () => {
    await renderCard(settings(3, 1000))

    act(() => { dispatchSyncUnitApplied('keyboards/connected/settings') })
    expect(getSpy).toHaveBeenCalledTimes(1)

    getSpy.mockResolvedValueOnce(settings(5, 1200))
    act(() => { dispatchSyncUnitApplied('keyboards/selected/settings') })
    await waitFor(() => expect(daysInput().value).toBe('5'))
    expect(keystrokesInput().value).toBe('1200')
    expect(getSpy).toHaveBeenLastCalledWith('selected')
    expect(screen.queryByTestId('analyze-streak-goal-warning')).toBeNull()
  })

  it('keeps a staged draft and follows the field the user did not change', async () => {
    await renderCard(settings(3, 1000))
    fireEvent.change(keystrokesInput(), { target: { value: '2000' } })
    fireEvent.keyDown(keystrokesInput(), { key: 'Enter' })
    expect(screen.getByTestId('analyze-streak-goal-warning')).toBeInTheDocument()

    getSpy.mockResolvedValueOnce(settings(7, 1500))
    act(() => { dispatchSyncUnitApplied('keyboards/selected/settings') })
    await waitFor(() => expect(daysInput().value).toBe('7'))
    expect(keystrokesInput().value).toBe('2000')
    expect(screen.getByTestId('analyze-streak-goal-warning')).toBeInTheDocument()
    expect(screen.getByTestId('analyze-streak-goal-keystrokes-confirm')).toBeInTheDocument()
  })

  it('keeps text typed but not yet staged', async () => {
    await renderCard(settings(3, 1000))
    fireEvent.change(daysInput(), { target: { value: '42' } })

    getSpy.mockResolvedValueOnce(settings(9, 1000))
    act(() => { dispatchSyncUnitApplied('keyboards/selected/settings') })
    await waitFor(() => expect(getSpy).toHaveBeenCalledTimes(2))
    await act(async () => { await Promise.resolve() })
    expect(daysInput().value).toBe('42')
  })

  it('keeps a committed goal when a reload started before the commit', async () => {
    await renderCard(settings(3, 1000))
    let resolveStale!: (prefs: PipetteSettings) => void
    getSpy.mockReturnValueOnce(new Promise((res) => { resolveStale = res }))
    act(() => { dispatchSyncUnitApplied('keyboards/selected/settings') })

    fireEvent.change(daysInput(), { target: { value: '4' } })
    fireEvent.keyDown(daysInput(), { key: 'Enter' })
    // persistGoal's own read, then the read repeated after the save.
    getSpy.mockResolvedValueOnce(settings(3, 1000)).mockResolvedValueOnce(settings(4, 1000))
    await act(async () => {
      fireEvent.mouseDown(screen.getByTestId('analyze-streak-goal-days-confirm'))
    })
    await waitFor(() => expect(patchSpy).toHaveBeenCalledTimes(1))
    await act(async () => { resolveStale(settings(3, 1000)) })
    await waitFor(() => expect(getSpy).toHaveBeenCalledTimes(4))
    expect(daysInput().value).toBe('4')
    expect(screen.queryByTestId('analyze-streak-goal-warning')).toBeNull()
  })
})
