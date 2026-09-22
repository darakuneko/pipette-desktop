// SPDX-License-Identifier: GPL-2.0-or-later
// Shared "send to every open window" helper.

import { BrowserWindow } from 'electron'

/**
 * Send `channel` (with optional `args`) to every open `BrowserWindow`.
 * `i18n-startup-sync.ts`, `theme-pack-ipc.ts`, and `sync-ipc.ts`'s
 * progress-event emitter are unified onto this helper too — the only
 * intentional holdout is `sync-ipc.ts`'s `getDialogWindow()` fallback
 * (`BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]`),
 * which anchors a native save/open DIALOG to one window and is not a
 * broadcast at all.
 *
 * Guards against a window closing between `getAllWindows()` enumerating
 * it and this loop reaching it (a real window-close race, not
 * hypothetical — several call sites here run after an `await`, e.g. a
 * sync merge's disk write, during which the user can close a window)
 * — `win.webContents.send` on an already-destroyed window/webContents
 * throws synchronously, which would otherwise abort the loop partway
 * through and skip broadcasting to any windows still open after it.
 */
export function broadcastToAllWindows(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    win.webContents.send(channel, ...args)
  }
}
