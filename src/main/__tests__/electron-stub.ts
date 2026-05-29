// SPDX-License-Identifier: GPL-2.0-or-later
// Vitest-only replacement for the `electron` module.
//
// The real `electron` npm package's `index.js` calls `getElectronPath()` at
// module-init time and throws "Electron failed to install correctly" when
// `path.txt` is missing — which it can be in CI when the postinstall script
// silently short-circuits. Tests that transitively import any main-process
// module (logger, ipc-guard, ...) hit this throw before any `vi.mock` runs.
//
// This stub is wired in via `vitest.config.ts#resolve.alias` so the throw is
// avoided in vitest. Tests that need specific electron behavior continue to
// override individual APIs through `vi.mock('electron', factory)`.

import { vi } from 'vitest'

export const app = {
  getPath: vi.fn((_name: string) => '/tmp/pipette-test'),
  getName: vi.fn(() => 'pipette-desktop-test'),
  getVersion: vi.fn(() => '0.0.0-test'),
  getAppPath: vi.fn(() => '/tmp/pipette-test/app'),
  isPackaged: false,
  on: vi.fn(),
  once: vi.fn(),
  off: vi.fn(),
  removeListener: vi.fn(),
  whenReady: vi.fn(() => Promise.resolve()),
  quit: vi.fn(),
  setPath: vi.fn(),
}

export const ipcMain = {
  handle: vi.fn(),
  removeHandler: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  once: vi.fn(),
  removeListener: vi.fn(),
  removeAllListeners: vi.fn(),
  emit: vi.fn(),
}

export const BrowserWindow = vi.fn().mockImplementation(() => ({
  loadURL: vi.fn(),
  loadFile: vi.fn(),
  on: vi.fn(),
  webContents: { send: vi.fn(), on: vi.fn() },
  close: vi.fn(),
  destroy: vi.fn(),
})) as unknown as {
  getAllWindows: () => unknown[]
  getFocusedWindow: () => unknown | null
  fromWebContents: (wc: unknown) => unknown | null
} & (new () => unknown)

;(BrowserWindow as unknown as { getAllWindows: () => unknown[] }).getAllWindows = vi.fn(() => [])
;(BrowserWindow as unknown as { getFocusedWindow: () => unknown | null }).getFocusedWindow = vi.fn(() => null)
;(BrowserWindow as unknown as { fromWebContents: (wc: unknown) => unknown | null }).fromWebContents = vi.fn(() => null)

export const dialog = {
  showOpenDialog: vi.fn(() => Promise.resolve({ canceled: true, filePaths: [] })),
  showSaveDialog: vi.fn(() => Promise.resolve({ canceled: true })),
  showMessageBox: vi.fn(() => Promise.resolve({ response: 0 })),
  showErrorBox: vi.fn(),
}

export const Menu = {
  setApplicationMenu: vi.fn(),
  buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })),
}

export const net = {
  request: vi.fn(),
  fetch: vi.fn(() => Promise.resolve(new Response())),
}

export const safeStorage = {
  isEncryptionAvailable: vi.fn(() => false),
  encryptString: vi.fn((s: string) => Buffer.from(s)),
  decryptString: vi.fn((b: Buffer) => b.toString('utf-8')),
}

export const screen = {
  getPrimaryDisplay: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })),
  getAllDisplays: vi.fn(() => []),
}

export const session = {
  defaultSession: { webRequest: { onBeforeRequest: vi.fn() } },
  fromPartition: vi.fn(),
}

export const shell = {
  openExternal: vi.fn(() => Promise.resolve()),
  openPath: vi.fn(() => Promise.resolve('')),
  showItemInFolder: vi.fn(),
}
