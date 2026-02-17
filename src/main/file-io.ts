// SPDX-License-Identifier: GPL-2.0-or-later
// File I/O for .vil layout save/restore — runs in main process

import { dialog, BrowserWindow } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { IpcChannels } from '../shared/ipc/channels'
import { secureHandle } from './ipc-guard'

interface SaveResult {
  success: boolean
  filePath?: string
  error?: string
}

interface SaveDialogOptions {
  title: string
  defaultPath: string
  filters: Electron.FileFilter[]
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/\.+$/, '')
    .trim() || 'keyboard'
}

async function saveFileWithDialog(
  event: Electron.IpcMainInvokeEvent,
  content: string | Buffer,
  options: SaveDialogOptions,
): Promise<SaveResult> {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return { success: false, error: 'No window' }

  const result = await dialog.showSaveDialog(win, options)
  if (result.canceled || !result.filePath) {
    return { success: false, error: 'cancelled' }
  }

  try {
    if (typeof content === 'string') {
      await writeFile(result.filePath, content, 'utf-8')
    } else {
      await writeFile(result.filePath, content)
    }
    return { success: true, filePath: result.filePath }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

export function setupFileIO(): void {
  secureHandle(IpcChannels.FILE_SAVE_LAYOUT, async (event, jsonData: string, deviceName?: string) => {
    const filename = deviceName ? `${sanitizeFilename(deviceName)}.vil` : 'keyboard.vil'
    return saveFileWithDialog(event, jsonData, {
      title: 'Export Layout',
      defaultPath: filename,
      filters: [
        { name: 'Vial Layout', extensions: ['vil'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    })
  })

  secureHandle(IpcChannels.FILE_EXPORT_KEYMAP_C, async (event, content: string, deviceName?: string) => {
    const filename = deviceName ? `${sanitizeFilename(deviceName)}_keymap.c` : 'keymap.c'
    return saveFileWithDialog(event, content, {
      title: 'Export keymap.c',
      defaultPath: filename,
      filters: [
        { name: 'C Source', extensions: ['c'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    })
  })

  secureHandle(IpcChannels.FILE_EXPORT_PDF, async (event, base64Data: string, deviceName?: string) => {
    const filename = deviceName ? `${sanitizeFilename(deviceName)}.pdf` : 'keymap.pdf'
    return saveFileWithDialog(event, Buffer.from(base64Data, 'base64'), {
      title: 'Export Keymap PDF',
      defaultPath: filename,
      filters: [
        { name: 'PDF Document', extensions: ['pdf'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    })
  })

  secureHandle(IpcChannels.FILE_EXPORT_CSV, async (event, content: string, defaultName?: string) => {
    const filename = defaultName ? `${sanitizeFilename(defaultName)}.csv` : 'typing-test-history.csv'
    return saveFileWithDialog(event, content, {
      title: 'Export CSV',
      defaultPath: filename,
      filters: [
        { name: 'CSV', extensions: ['csv'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    })
  })

  secureHandle(IpcChannels.FILE_LOAD_LAYOUT, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { success: false, error: 'No window' }

    const result = await dialog.showOpenDialog(win, {
      title: 'Import Layout',
      filters: [
        { name: 'Vial Layout', extensions: ['vil'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    })

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, error: 'cancelled' }
    }

    try {
      const data = await readFile(result.filePaths[0], 'utf-8')
      return { success: true, data, filePath: result.filePaths[0] }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  secureHandle(IpcChannels.SIDELOAD_JSON, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { success: false, error: 'No window' }

    const result = await dialog.showOpenDialog(win, {
      title: 'Sideload JSON',
      filters: [
        { name: 'JSON Files', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    })

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, error: 'cancelled' }
    }

    try {
      const data = await readFile(result.filePaths[0], 'utf-8')
      const parsed: unknown = JSON.parse(data)
      return { success: true, data: parsed, filePath: result.filePaths[0] }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
}
