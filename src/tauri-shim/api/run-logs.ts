// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI Typing Test run log members for the Tauri build
// (src-tauri/src/store_commands/run_logs.rs). A save is queued under the
// keyboard's uid, the key its other store writes share, so it reaches the
// backend in the order the renderer made it, and also waits for the app
// config sets made before it: the backend reads the recording consent when
// the save runs, so a consent withdrawn just before a save refuses it, as
// in Electron. The list and the get read without waiting, as the Electron
// handlers do. The log crosses as the text of JSON.stringify(log), taken
// when the member is called (as Electron's IPC copies its arguments then),
// so the backend saves the same text the Electron store writes: the keys in
// their order, a NaN or Infinity as null, and an undefined field left out.

import type { RunKeystrokeLog, RunLogMeta } from '../../shared/types/typing-run-log'
import type { VialAPI } from '../../shared/types/vial-api'
import { call } from '../ipc'
import { enqueue } from '../key-queue'
import { afterAppConfigSets } from './app-config'

export const runLogsApi = {
  typingRunLogSave: (uid, log) => {
    const text = JSON.stringify(log) as string | undefined
    const configSet = afterAppConfigSets()
    return enqueue(uid, async () => {
      await configSet
      return call<{ success: boolean; entry?: RunLogMeta; error?: string }>('typing_run_log_save', { uid, log: text })
    })
  },
  typingRunLogList: (uid) =>
    call<{ success: boolean; entries?: RunLogMeta[]; error?: string }>('typing_run_log_list', { uid }),
  typingRunLogGet: (uid, runId) =>
    call<{ success: boolean; data?: RunKeystrokeLog; error?: string }>('typing_run_log_get', { uid, runId }),
} satisfies Partial<VialAPI>
