// SPDX-License-Identifier: GPL-2.0-or-later
// File I/O for .vil layout save/restore — runs in main process

import { dialog, BrowserWindow } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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

  // Multi-file CSV bundle export. The renderer pre-builds each file's
  // content + filename and we prompt once for a target directory; the
  // main process writes them all in parallel. Each `name` is sanitised
  // and `.csv` is appended if missing so the renderer can pass either
  // form. Returns a summary of which files made it to disk.
  secureHandle(IpcChannels.FILE_EXPORT_CSV_BUNDLE, async (event, files: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { success: false, error: 'No window' }
    if (!Array.isArray(files) || files.length === 0) {
      return { success: false, error: 'no files' }
    }
    const entries: { name: string; content: string }[] = []
    for (const f of files) {
      if (
        typeof f !== 'object' || f === null ||
        typeof (f as { name?: unknown }).name !== 'string' ||
        typeof (f as { content?: unknown }).content !== 'string'
      ) {
        return { success: false, error: 'invalid file entry' }
      }
      entries.push(f as { name: string; content: string })
    }
    const result = await dialog.showOpenDialog(win, {
      title: 'Export CSV bundle',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, error: 'cancelled' }
    }
    const dirPath = result.filePaths[0]
    const written: string[] = []
    try {
      await Promise.all(entries.map(async (entry) => {
        const safe = sanitizeFilename(entry.name)
        const fname = safe.toLowerCase().endsWith('.csv') ? safe : `${safe}.csv`
        const full = join(dirPath, fname)
        await writeFile(full, entry.content, 'utf-8')
        written.push(full)
      }))
      return { success: true, dirPath, files: written }
    } catch (err) {
      return { success: false, error: String(err), files: written }
    }
  })

  secureHandle(IpcChannels.FILE_EXPORT_JSON, async (event, content: string, defaultName?: string) => {
    const filename = defaultName ? `${sanitizeFilename(defaultName)}.json` : 'export.json'
    return saveFileWithDialog(event, content, {
      title: 'Export JSON',
      defaultPath: filename,
      filters: [
        { name: 'JSON', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    })
  })

  secureHandle(IpcChannels.FILE_LOAD_LAYOUT, async (event, title?: unknown, extensions?: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { success: false, error: 'No window' }

    // Default to .vil; callers can pass ['pipette'] for pipette-file mode
    const exts = Array.isArray(extensions) && extensions.every((e) => typeof e === 'string')
      ? extensions as string[]
      : ['vil']
    const filterName = exts.includes('pipette') ? 'Pipette Layout' : 'Vial Layout'

    const result = await dialog.showOpenDialog(win, {
      title: typeof title === 'string' ? title : 'Import Layout',
      filters: [
        { name: filterName, extensions: exts },
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

  secureHandle(IpcChannels.SIDELOAD_JSON, async (event, title?: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { success: false, error: 'No window' }

    const result = await dialog.showOpenDialog(win, {
      title: typeof title === 'string' ? title : 'Load from JSON file',
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
