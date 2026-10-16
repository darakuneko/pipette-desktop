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

type Spy = (...args: unknown[]) => unknown
type RunLogMember = Extract<keyof VialAPI, `typingRunLog${string}`>
export type RunLogSpies = Partial<Record<RunLogMember, Spy>>

export interface RunLogBackend {
  name: string
  install: () => void
}

function installVialAPI(members: object): void {
  Object.defineProperty(window, 'vialAPI', { value: members, writable: true, configurable: true })
}

function spy(spies: RunLogSpies, member: RunLogMember): Spy {
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
              return spy(spies, 'typingRunLogSave')(a.uid, typeof a.log === 'string' ? JSON.parse(a.log) : undefined)
            case 'typing_run_log_list': return spy(spies, 'typingRunLogList')(a.uid)
            case 'typing_run_log_get': return spy(spies, 'typingRunLogGet')(a.uid, a.runId)
            default: throw new Error(`unexpected command ${cmd}`)
          }
        })
        installVialAPI({ ...extra, ...runLogsApi })
      },
    },
  ]
}
