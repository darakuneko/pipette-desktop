// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// Runs against both vialAPI implementations: a plain mock, and the
// Tauri shim's dataset members over a mocked Tauri IPC
// (./typing-dataset-backends.ts).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { clearMocks } from '@tauri-apps/api/mocks'
import { useTypingDatasetUpdate } from '../useTypingDatasetUpdate'
import { type DatasetSpies, datasetSpies, plainMock, shimOverMockIPC } from './typing-dataset-backends'

afterEach(() => {
  clearMocks()
})

describe.each([plainMock, shimOverMockIPC])('useTypingDatasetUpdate ($name)', (backend) => {
  let spies: DatasetSpies

  beforeEach(() => {
    spies = datasetSpies()
    backend.install(spies)
  })

  it('checks the provider once mounted and reports an available update', async () => {
    spies.checkTypingDatasetUpdate.mockResolvedValue({ provider: 'tatoeba', updateAvailable: true })
    const { result } = renderHook(() => useTypingDatasetUpdate('tatoeba'))
    await waitFor(() => expect(result.current.updateAvailable).toBe(true))
    expect(spies.checkTypingDatasetUpdate).toHaveBeenCalledWith('tatoeba')
  })

  it('clears the update once it is applied', async () => {
    spies.checkTypingDatasetUpdate.mockResolvedValue({ provider: 'monkeytype', updateAvailable: true })
    spies.updateTypingDataset.mockResolvedValue({ provider: 'monkeytype', changed: true, fromVersion: 'a', toVersion: 'b' })
    const { result } = renderHook(() => useTypingDatasetUpdate('monkeytype'))
    await waitFor(() => expect(result.current.updateAvailable).toBe(true))

    let changed = false
    await act(async () => {
      changed = await result.current.applyUpdate()
    })
    expect(changed).toBe(true)
    expect(spies.updateTypingDataset).toHaveBeenCalledWith('monkeytype')
    expect(result.current.updateAvailable).toBe(false)
    expect(result.current.updating).toBe(false)
  })

  it('keeps the update when the Hub could not be reached', async () => {
    spies.checkTypingDatasetUpdate.mockResolvedValue({ provider: 'monkeytype', updateAvailable: true })
    const { result } = renderHook(() => useTypingDatasetUpdate('monkeytype'))
    await waitFor(() => expect(result.current.updateAvailable).toBe(true))

    let changed = true
    await act(async () => {
      changed = await result.current.applyUpdate()
    })
    expect(changed).toBe(false)
    expect(result.current.updateAvailable).toBe(true)
  })

  it('reports no update when the check fails', async () => {
    spies.checkTypingDatasetUpdate.mockRejectedValue(new Error('Unknown typing-test provider: x'))
    const { result } = renderHook(() => useTypingDatasetUpdate('x'))
    await waitFor(() => expect(spies.checkTypingDatasetUpdate).toHaveBeenCalled())
    expect(result.current.updateAvailable).toBe(false)
  })
})
