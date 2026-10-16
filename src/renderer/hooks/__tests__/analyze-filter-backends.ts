// SPDX-License-Identifier: GPL-2.0-or-later
// The two vialAPI implementations the Analyze filter hooks' tests run
// against, both answering from the same VialAPI-shaped spies: a
// preload-like mock (the spies themselves), and the Tauri shim's Analyze
// filter members over a mocked Tauri IPC, whose commands hand the spies
// their arguments in the members' order, a private Hub link as the value of
// the JSON text the shim sends. `extra` holds the other members a test
// needs, the same in both. The test file clears the IPC mock after each
// test (`clearMocks`).

import { mockIPC } from '@tauri-apps/api/mocks'
import type { VialAPI } from '../../../shared/types/vial-api'
import { analyzeFiltersApi } from '../../../tauri-shim/api/analyze-filters'

type Spy = (...args: unknown[]) => unknown
type AnalyzeFilterMember = Extract<keyof VialAPI, `analyzeFilterStore${string}`>
export type AnalyzeFilterSpies = Partial<Record<AnalyzeFilterMember, Spy>>

export interface AnalyzeFilterBackend {
  name: string
  install: () => void
}

function installVialAPI(members: object): void {
  Object.defineProperty(window, 'vialAPI', { value: members, writable: true, configurable: true })
}

function spy(spies: AnalyzeFilterSpies, member: AnalyzeFilterMember): Spy {
  const found = spies[member]
  if (!found) throw new Error(`no spy for ${member}`)
  return found
}

export function analyzeFilterBackends(spies: AnalyzeFilterSpies, extra: object = {}): AnalyzeFilterBackend[] {
  return [
    { name: 'preload-like mock', install: () => installVialAPI({ ...extra, ...spies }) },
    {
      name: 'Tauri shim over mockIPC',
      install: () => {
        mockIPC((cmd, payload) => {
          const a = payload as Record<string, unknown>
          switch (cmd) {
            case 'analyze_filter_store_list': return spy(spies, 'analyzeFilterStoreList')(a.uid)
            case 'analyze_filter_store_save':
              return spy(spies, 'analyzeFilterStoreSave')(a.uid, a.json, a.label, a.summary)
            case 'analyze_filter_store_load': return spy(spies, 'analyzeFilterStoreLoad')(a.uid, a.entryId)
            case 'analyze_filter_store_update': return spy(spies, 'analyzeFilterStoreUpdate')(a.uid, a.entryId, a.json)
            case 'analyze_filter_store_rename':
              return spy(spies, 'analyzeFilterStoreRename')(a.uid, a.entryId, a.newLabel)
            case 'analyze_filter_store_delete': return spy(spies, 'analyzeFilterStoreDelete')(a.uid, a.entryId)
            case 'analyze_filter_store_set_hub_post_id':
              return spy(spies, 'analyzeFilterStoreSetHubPostId')(a.uid, a.entryId, a.hubPostId)
            case 'analyze_filter_store_set_hub_private':
              return spy(spies, 'analyzeFilterStoreSetHubPrivate')(a.uid, a.entryId, JSON.parse(String(a.link)))
            default: throw new Error(`unexpected command ${cmd}`)
          }
        })
        installVialAPI({ ...extra, ...analyzeFiltersApi })
      },
    },
  ]
}
