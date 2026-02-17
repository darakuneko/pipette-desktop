// SPDX-License-Identifier: GPL-2.0-or-later
// IPC origin validation wrappers — reject calls from untrusted origins

import { ipcMain } from 'electron'
import { log } from './logger'

const isDev = !!process.env.ELECTRON_RENDERER_URL

const LOCALHOST_RE = /^http:\/\/localhost(:\d+)?$/

export function isAllowedOrigin(origin: string | undefined | null, devMode = isDev): boolean {
  if (!origin) return false
  if (origin === 'file://') return true
  if (devMode && LOCALHOST_RE.test(origin)) return true
  return false
}

function rejectOrigin(channel: string, origin: string | undefined | null): void {
  log('warn', `IPC blocked: ${channel} from origin ${origin ?? '<null>'}`)
}

export function secureHandle(
  channel: string,
  handler: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isAllowedOrigin(event.senderFrame?.origin)) {
      rejectOrigin(channel, event.senderFrame?.origin)
      throw new Error('IPC origin rejected')
    }
    return handler(event, ...args)
  })
}

export function secureOn(
  channel: string,
  handler: (event: Electron.IpcMainEvent, ...args: unknown[]) => void,
): void {
  ipcMain.on(channel, (event, ...args) => {
    if (!isAllowedOrigin(event.senderFrame?.origin)) {
      rejectOrigin(channel, event.senderFrame?.origin)
      return
    }
    handler(event, ...args)
  })
}
