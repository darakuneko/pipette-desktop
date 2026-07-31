// SPDX-License-Identifier: GPL-2.0-or-later
// IPC wiring for the per-run raw keystroke log store — see
// typing-run-log-store.ts for the actual read/write logic.

import { IpcChannels } from '../shared/ipc/channels'
import { secureHandle } from './ipc-guard'
import { getRunLog, listRunLogs, saveRunLog } from './typing-run-log-store'

export function setupTypingRunLogStore(): void {
  secureHandle(
    IpcChannels.TYPING_RUN_LOG_SAVE,
    async (_event, uid: string, log: unknown) => saveRunLog(uid, log),
  )

  secureHandle(
    IpcChannels.TYPING_RUN_LOG_LIST,
    async (_event, uid: string) => listRunLogs(uid),
  )

  secureHandle(
    IpcChannels.TYPING_RUN_LOG_GET,
    async (_event, uid: string, runId: string) => getRunLog(uid, runId),
  )
}
