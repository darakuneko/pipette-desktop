// SPDX-License-Identifier: GPL-2.0-or-later
// The two vialAPI implementations the run log hooks' tests run against,
// both answering from the same VialAPI-shaped spies: a preload-like mock
// (the spies themselves), and the Tauri shim's run log members over a
// mocked Tauri IPC, whose commands hand the spies their arguments in the
// members' order, a saved log as the value of the JSON text the shim
// sends. `extra` holds the other members a test needs, the same in both.
// The test file clears the IPC mock after each test (`clearMocks`).

import { mockIPC } from '@tauri-apps/api/mocks'
import type { VialAPI } from '../../../shared/types/vial-api'
import { runLogsApi } from '../../../tauri-shim/api/run-logs'

type RunLogMember = Extract<keyof VialAPI, `typingRunLog${string}`>
/** A spy per member, called with the member's own arguments. */
export type RunLogSpies = { [K in RunLogMember]?: (...args: Parameters<VialAPI[K]>) => unknown }

export interface RunLogBackend {
  name: string
  install: () => void
}

function installVialAPI(members: object): void {
  Object.defineProperty(window, 'vialAPI', { value: members, writable: true, configurable: true })
}

function spy<K extends RunLogMember>(spies: RunLogSpies, member: K): NonNullable<RunLogSpies[K]> {
  const found = spies[member]
  if (!found) throw new Error(`no spy for ${member}`)
  return found
}

export function runLogBackends(spies: RunLogSpies, extra: object = {}): RunLogBackend[] {
  return [
    { name: 'preload-like mock', install: () => installVialAPI({ ...extra, ...spies }) },
    {
      name: 'Tauri shim over mockIPC',
      install: () => {
        mockIPC((cmd, payload) => {
          const a = payload as Record<string, unknown>
          switch (cmd) {
            case 'typing_run_log_save':
              return spy(spies, 'typingRunLogSave')(a.uid as string, typeof a.log === 'string' ? JSON.parse(a.log) : undefined)
            case 'typing_run_log_list': return spy(spies, 'typingRunLogList')(a.uid as string)
            case 'typing_run_log_get': return spy(spies, 'typingRunLogGet')(a.uid as string, a.runId as string)
            default: throw new Error(`unexpected command ${cmd}`)
          }
        })
        installVialAPI({ ...extra, ...runLogsApi })
      },
    },
  ]
}
