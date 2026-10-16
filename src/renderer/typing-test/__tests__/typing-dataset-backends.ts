// SPDX-License-Identifier: GPL-2.0-or-later
// The two vialAPI implementations the word list and dataset tests run
// against, both answering from the same VialAPI-shaped spies: a
// preload-like mock (the spies themselves), and the Tauri shim's members
// over a mocked Tauri IPC, whose commands hand the spies their arguments
// in the members' order and answer what the spies answer.

import { vi } from 'vitest'
import { mockIPC } from '@tauri-apps/api/mocks'
import type { LanguageListEntry } from '../../../shared/types/language-store'
import { typingDatasetsApi } from '../../../tauri-shim/api/typing-datasets'

export function datasetSpies() {
  return {
    langList: vi.fn(async (_provider?: string): Promise<LanguageListEntry[]> => []),
    langGet: vi.fn(async (_name: string, _provider?: string): Promise<unknown> => null),
    langDownload: vi.fn(async (_name: string, _provider?: string) => ({ success: true }) as { success: boolean; error?: string }),
    langDelete: vi.fn(async (_name: string, _provider?: string) => ({ success: true }) as { success: boolean; error?: string }),
    checkTypingDatasetUpdate: vi.fn(async (provider?: string) => ({ provider: provider ?? 'monkeytype', updateAvailable: false })),
    updateTypingDataset: vi.fn(async (provider?: string) =>
      ({ provider: provider ?? 'monkeytype', changed: false, fromVersion: '' }) as {
        provider: string
        changed: boolean
        fromVersion: string
        toVersion?: string
      }),
  }
}

export type DatasetSpies = ReturnType<typeof datasetSpies>

export interface DatasetBackend {
  name: string
  install: (spies: DatasetSpies) => void
}

function installVialAPI(members: object): void {
  Object.defineProperty(window, 'vialAPI', { value: members, writable: true, configurable: true })
}

export const preloadLikeMock: DatasetBackend = {
  name: 'preload-like mock',
  install: (spies) => installVialAPI({ ...spies }),
}

export const shimOverMockIPC: DatasetBackend = {
  name: 'Tauri shim over mockIPC',
  install: (spies) => {
    mockIPC((cmd, payload) => {
      const { name, provider } = payload as { name: string; provider?: string }
      switch (cmd) {
        case 'lang_list': return spies.langList(provider)
        case 'lang_get': return spies.langGet(name, provider)
        case 'lang_download': return spies.langDownload(name, provider)
        case 'lang_delete': return spies.langDelete(name, provider)
        case 'typing_dataset_check': return spies.checkTypingDatasetUpdate(provider)
        case 'typing_dataset_update': return spies.updateTypingDataset(provider)
        default: throw new Error(`unexpected command ${cmd}`)
      }
    })
    installVialAPI({ ...typingDatasetsApi })
  },
}
