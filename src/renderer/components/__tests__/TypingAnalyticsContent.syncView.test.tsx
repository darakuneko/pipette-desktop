// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// The Data modal's Sync > Typing > Device view against both vialAPI
// implementations (typing-remote-backends.ts): it fetches the days Drive
// holds for the device that are not local, lists the device's days, and
// deletes the device's data.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { clearMocks } from '@tauri-apps/api/mocks'
import { TypingAnalyticsContent } from '../data-modal/TypingAnalyticsContent'
import { typingRemoteBackends, type TypingRemoteSpies } from './typing-remote-backends'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const summaries = [
  { date: '2026-10-01', keystrokes: 10, activeMs: 1_000 },
  { date: '2026-10-02', keystrokes: 20, activeMs: 2_000 },
]

const spies = {
  listStoredKeyboards: vi.fn(),
  typingAnalyticsListKeyboards: vi.fn(),
  typingAnalyticsListDeviceInfos: vi.fn(),
  typingAnalyticsListRemoteCloudHashes: vi.fn(),
  typingAnalyticsListRemoteCloudDays: vi.fn(),
  typingAnalyticsFetchRemoteDay: vi.fn(),
  typingAnalyticsListLocalDeviceDays: vi.fn(),
  typingAnalyticsListItemsForHash: vi.fn(),
  typingAnalyticsDeleteDeviceData: vi.fn(),
  syncScanRemote: vi.fn(),
} satisfies TypingRemoteSpies

beforeEach(() => {
  for (const spy of Object.values(spies)) spy.mockReset()
  spies.typingAnalyticsListRemoteCloudDays.mockResolvedValue(['2026-10-01', '2026-10-02', '2026-10-03'])
  spies.typingAnalyticsListLocalDeviceDays.mockResolvedValue(['2026-10-02'])
  spies.typingAnalyticsFetchRemoteDay.mockResolvedValue(true)
  spies.typingAnalyticsListItemsForHash.mockResolvedValue(summaries)
  spies.typingAnalyticsDeleteDeviceData.mockResolvedValue({ success: true })
})

afterEach(() => {
  clearMocks()
})

describe.each(typingRemoteBackends(spies))('TypingAnalyticsContent sync view ($name)', (backend) => {
  beforeEach(() => {
    backend.install()
  })

  it('fetches the days Drive has that are not local, one after another, then lists the device\'s days', async () => {
    render(<TypingAnalyticsContent uid="uid1" mode="sync" machineHash="hash1" />)

    expect(await screen.findAllByLabelText('dataModal.typing.selectRow')).toHaveLength(2)
    expect(spies.typingAnalyticsFetchRemoteDay.mock.calls).toEqual([
      ['uid1', 'hash1', '2026-10-01'],
      ['uid1', 'hash1', '2026-10-03'],
    ])
    expect(spies.typingAnalyticsListItemsForHash).toHaveBeenCalledWith('uid1', 'hash1')
  })

  it('still lists the local days when a fetch fails', async () => {
    spies.typingAnalyticsFetchRemoteDay.mockRejectedValue(new Error('sync.passwordMismatch'))
    render(<TypingAnalyticsContent uid="uid1" mode="sync" machineHash="hash1" />)

    expect(await screen.findAllByLabelText('dataModal.typing.selectRow')).toHaveLength(2)
    expect(spies.typingAnalyticsFetchRemoteDay).toHaveBeenCalledTimes(1)
  })

  it('deletes all of the device\'s data with one call', async () => {
    render(<TypingAnalyticsContent uid="uid1" mode="sync" machineHash="hash1" />)
    fireEvent.click(await screen.findByTestId('typing-delete-all'))
    fireEvent.click(screen.getByTestId('typing-delete-all-confirm'))

    await waitFor(() => expect(spies.typingAnalyticsDeleteDeviceData).toHaveBeenCalledTimes(1))
    expect(spies.typingAnalyticsDeleteDeviceData).toHaveBeenCalledWith('uid1', 'hash1', 'all')
  })

  it('deletes the selected days of the device, and shows a refused delete\'s message', async () => {
    spies.typingAnalyticsDeleteDeviceData.mockResolvedValueOnce({ success: false, error: 'sync.deleteBusy' })
    render(<TypingAnalyticsContent uid="uid1" mode="sync" machineHash="hash1" />)
    fireEvent.click((await screen.findAllByLabelText('dataModal.typing.selectRow'))[0])
    fireEvent.click(screen.getByTestId('typing-delete-selected'))
    fireEvent.click(screen.getByTestId('typing-delete-selected-confirm'))

    expect(await screen.findByTestId('typing-error')).toHaveTextContent('sync.deleteBusy')
    expect(spies.typingAnalyticsDeleteDeviceData).toHaveBeenCalledWith('uid1', 'hash1', ['2026-10-01'])
  })
})
