import { app, BrowserWindow, Menu, session, shell } from 'electron'
import { join, resolve, dirname } from 'node:path'
import { statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { IpcChannels } from '../shared/ipc/channels'
import { setupFileIO } from './file-io'
import { setupSnapshotStore } from './snapshot-store'
import { setupFavoriteStore } from './favorite-store'
import { setupHidIpc } from './hid-ipc'
import { setupPipetteSettingsStore } from './pipette-settings-store'
import { setupLanguageStore } from './language-store'
import { setupSyncIpc } from './sync/sync-ipc'
import { setupHubIpc } from './hub/hub-ipc'
import { log, logHidPacket } from './logger'
import type { LogLevel } from './logger'
import { loadWindowState, saveWindowState, setupAppConfigIpc } from './app-config'
import { secureHandle, secureOn } from './ipc-guard'

const isDev = !!process.env.ELECTRON_RENDERER_URL

// Linux: disable GPU sandbox only when chrome-sandbox lacks SUID root.
// Packaged builds with correct permissions keep the GPU sandbox enabled.
if (process.platform === 'linux') {
  const chromeSandbox = resolve(dirname(process.execPath), 'chrome-sandbox')
  let needsGpuSandboxDisable = false
  try {
    const st = statSync(chromeSandbox)
    // SUID bit = 0o4000; owner must be root (uid 0)
    needsGpuSandboxDisable = st.uid !== 0 || (st.mode & 0o4000) === 0
  } catch {
    // Binary not found — namespace sandbox will be used; GPU sandbox
    // may still fail so disable it defensively.
    needsGpuSandboxDisable = true
  }
  if (needsGpuSandboxDisable) {
    app.commandLine.appendSwitch('disable-gpu-sandbox')
  }
}

function setupCsp(): void {
  const prodCsp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; ')

  const devCsp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self' ws://localhost:*",
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; ')

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [isDev ? devCsp : prodCsp],
      },
    })
  })
}

function hideMenuBar(): void {
  Menu.setApplicationMenu(null)
}

function createWindow(): void {
  const saved = loadWindowState()
  const winOpts: Electron.BrowserWindowConstructorOptions = {
    width: saved.width,
    height: saved.height,
    minWidth: 1280,
    minHeight: 960,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  }
  if (saved.x >= 0 && saved.y >= 0) {
    winOpts.x = saved.x
    winOpts.y = saved.y
  }
  const win = new BrowserWindow(winOpts)

  win.on('close', () => {
    saveWindowState(win.getBounds())
  })

  hideMenuBar()

  win.webContents.on('will-navigate', (event, url) => {
    const parsed = new URL(url)
    if (parsed.protocol !== 'file:' && !url.startsWith('http://localhost')) {
      event.preventDefault()
    }
  })

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
    win.webContents.openDevTools()
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function setupLzmaIpc(): void {
  secureHandle(IpcChannels.LZMA_DECOMPRESS, (_event, data: number[]): Promise<string | null> => {
    if (!data || !Array.isArray(data) || data.length === 0) {
      return Promise.resolve(null)
    }
    const buf = Buffer.from(data)
    // Detect format from magic bytes: XZ starts with FD 37 7A 58 5A 00
    const isXz = buf.length >= 6 && buf[0] === 0xfd && buf[1] === 0x37 && buf[2] === 0x7a &&
      buf[3] === 0x58 && buf[4] === 0x5a && buf[5] === 0x00
    if (isXz) {
      return decompressXz(buf)
    }
    // Fallback: try lzma package for raw LZMA streams
    return decompressLzma(data)
  })
}

function decompressXz(buf: Buffer): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('xz', ['--decompress', '--stdout'], { stdio: ['pipe', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('close', (code: number | null) => {
      if (code !== 0) {
        log('warn', `XZ decompress exited with code ${code}`)
        resolve(null)
        return
      }
      try {
        resolve(Buffer.concat(chunks).toString('utf-8'))
      } catch {
        resolve(null)
      }
    })
    child.on('error', (err: Error) => {
      log('warn', `XZ decompress error: ${err.message}`)
      resolve(null)
    })
    child.stdin.end(buf)
  })
}

function decompressLzma(data: number[]): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const LZMA = require('lzma') as { decompress: (data: number[], cb: (result: string | null) => void) => void }
  return new Promise((resolve) => {
    try {
      LZMA.decompress(data, (result: string | null) => {
        resolve(result)
      })
    } catch {
      resolve(null)
    }
  })
}

function setupShellIpc(): void {
  secureHandle(IpcChannels.SHELL_OPEN_EXTERNAL, async (_event, url: string) => {
    if (typeof url !== 'string') throw new Error('Invalid URL')
    let parsed: URL
    try { parsed = new URL(url) } catch { throw new Error('Invalid URL') }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Invalid URL scheme')
    }
    await shell.openExternal(url)
  })
}

function setupLogIpc(): void {
  secureOn(IpcChannels.LOG_ENTRY, (_event, level: LogLevel, message: string) => {
    log(level, message)
  })
  secureOn(IpcChannels.LOG_HID_PACKET, (_event, direction: 'TX' | 'RX', data: number[]) => {
    logHidPacket(direction, new Uint8Array(data))
  })
}

app.whenReady().then(() => {
  log('info', 'Pipette starting')
  setupCsp()
  setupHidIpc()
  setupFileIO()
  setupSnapshotStore()
  setupFavoriteStore()
  setupPipetteSettingsStore()
  setupLanguageStore()
  setupAppConfigIpc()
  setupSyncIpc()
  setupHubIpc()
  setupLzmaIpc()
  setupLogIpc()
  setupShellIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
