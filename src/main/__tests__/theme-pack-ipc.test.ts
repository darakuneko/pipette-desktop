// SPDX-License-Identifier: GPL-2.0-or-later
// Covers only the THEME_PACK_IMPORT dialog handler (multi-select read +
// per-file parse). The store-backed handlers (savePack, renamePack, ...)
// are covered in theme-pack-store.test.ts; this suite stubs the store
// module entirely so importing theme-pack-ipc.ts does not construct
// electron-store / app-config.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

vi.mock('electron', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
      }),
      _handlers: handlers,
    },
    dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
    BrowserWindow: {
      fromWebContents: vi.fn(),
      getAllWindows: vi.fn(() => []),
    },
  }
})

vi.mock('../ipc-guard', async () => {
  const { ipcMain } = await import('electron')
  return { secureHandle: ipcMain.handle }
})

vi.mock('../theme-pack-store', () => ({
  listMetas: vi.fn(),
  getPack: vi.fn(),
  savePack: vi.fn(),
  renamePack: vi.fn(),
  deletePack: vi.fn(),
  setHubPostId: vi.fn(),
  hasActiveName: vi.fn(),
  exportPackToDialog: vi.fn(),
  reorderActive: vi.fn(),
}))

import { dialog, BrowserWindow, ipcMain } from 'electron'
import { IpcChannels } from '../../shared/ipc/channels'
import { setupThemePackStore } from '../theme-pack-ipc'

interface FakeIpcMain {
  _handlers: Map<string, (...args: unknown[]) => unknown>
}

interface ImportFileResult {
  filePath: string
  raw?: unknown
  fileSizeBytes?: number
  parseError?: string
}

interface ImportDialogResult {
  canceled: boolean
  files: ImportFileResult[]
}

function getImportHandler(): (event: unknown) => Promise<ImportDialogResult> {
  const handlers = (ipcMain as unknown as FakeIpcMain)._handlers
  const handler = handlers.get(IpcChannels.THEME_PACK_IMPORT)
  if (!handler) throw new Error('THEME_PACK_IMPORT handler not registered')
  return handler as (event: unknown) => Promise<ImportDialogResult>
}

describe('theme-pack-ipc THEME_PACK_IMPORT', () => {
  let dir = ''

  beforeEach(async () => {
    vi.clearAllMocks()
    dir = await mkdtemp(join(tmpdir(), 'theme-pack-ipc-test-'))
    setupThemePackStore()
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue({ id: 1 } as unknown as Electron.BrowserWindow)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('requests multiSelections and returns one entry per selected file', async () => {
    const pathA = join(dir, 'a.json')
    const pathB = join(dir, 'b.json')
    await writeFile(pathA, JSON.stringify({ name: 'A', version: '1', colorScheme: 'dark', colors: {} }), 'utf-8')
    await writeFile(pathB, JSON.stringify({ name: 'B', version: '1', colorScheme: 'dark', colors: {} }), 'utf-8')
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [pathA, pathB] })

    const result = await getImportHandler()({ sender: {} })

    expect(dialog.showOpenDialog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ properties: expect.arrayContaining(['multiSelections']) }),
    )
    expect(result.canceled).toBe(false)
    expect(result.files).toHaveLength(2)
    expect(result.files[0].raw).toEqual({ name: 'A', version: '1', colorScheme: 'dark', colors: {} })
    expect(result.files[1].raw).toEqual({ name: 'B', version: '1', colorScheme: 'dark', colors: {} })
  })

  it('reports a parseError for one bad file without dropping the good one', async () => {
    const goodPath = join(dir, 'good.json')
    const badPath = join(dir, 'bad.json')
    await writeFile(goodPath, JSON.stringify({ name: 'Good', version: '1', colorScheme: 'dark', colors: {} }), 'utf-8')
    await writeFile(badPath, '{ not valid json', 'utf-8')
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [badPath, goodPath] })

    const result = await getImportHandler()({ sender: {} })

    expect(result.files).toHaveLength(2)
    expect(result.files[0].parseError).toBeTruthy()
    expect(result.files[0].raw).toBeUndefined()
    expect(result.files[1].raw).toEqual({ name: 'Good', version: '1', colorScheme: 'dark', colors: {} })
  })

  it('returns canceled with no files when the dialog is dismissed', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] })

    const result = await getImportHandler()({ sender: {} })
    expect(result).toEqual({ canceled: true, files: [] })
  })

  it('returns canceled with no files when there is no window for the sender', async () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(null)

    const result = await getImportHandler()({ sender: {} })
    expect(result).toEqual({ canceled: true, files: [] })
    expect(dialog.showOpenDialog).not.toHaveBeenCalled()
  })
})
