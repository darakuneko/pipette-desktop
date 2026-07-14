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

// Args is generic so each call site's handler can declare its own specific
// parameter types (matching what the renderer is expected to send) instead
// of the caller having to widen every handler to `...args: unknown[]`. The
// cast below is the same "trust the IPC boundary" contract every handler
// already relies on — the real `ipcMain.handle`/`ipcMain.on` signatures are
// untyped (`...args: any[]`), so this only narrows what's exposed to callers.
export function secureHandle<Args extends unknown[], Result>(
  channel: string,
  handler: (event: Electron.IpcMainInvokeEvent, ...args: Args) => Result,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isAllowedOrigin(event.senderFrame?.origin)) {
      rejectOrigin(channel, event.senderFrame?.origin)
      throw new Error('IPC origin rejected')
    }
    return handler(event, ...(args as Args))
  })
}

export function secureOn<Args extends unknown[]>(
  channel: string,
  handler: (event: Electron.IpcMainEvent, ...args: Args) => void,
): void {
  ipcMain.on(channel, (event, ...args) => {
    if (!isAllowedOrigin(event.senderFrame?.origin)) {
      rejectOrigin(channel, event.senderFrame?.origin)
      return
    }
    handler(event, ...(args as Args))
  })
}
