import { app, BrowserWindow, Menu, session, shell } from 'electron'
import { join, resolve, dirname } from 'node:path'
import { statSync } from 'node:fs'
import { IpcChannels } from '../shared/ipc/channels'
import { setupFileIO } from './file-io'
import { setupSnapshotStore } from './snapshot-store'
import { setupFavoriteStore } from './favorite-store'
import { setupHidIpc } from './hid-ipc'
import { setupPipetteSettingsStore } from './pipette-settings-store'
import { setupLanguageStore } from './language-store'
import { setupSyncIpc } from './sync/sync-ipc'
import { setupHubIpc } from './hub/hub-ipc'
import { setupLzmaIpc } from './lzma'
import { setupNotificationStore } from './notification-store'
import { buildCsp, securityHeaders } from './csp'
import { log, logHidPacket } from './logger'
import type { LogLevel } from './logger'
import { loadWindowState, saveWindowState, setupAppConfigIpc, MIN_WIDTH, MIN_HEIGHT } from './app-config'
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
  const csp = buildCsp(isDev)

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
        ...securityHeaders,
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
    minWidth: 1320,
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
    if (normalWindowSize) {
      const bounds = win.getBounds()
      saveWindowState({ ...bounds, width: normalWindowSize.width, height: normalWindowSize.height })
    } else {
      saveWindowState(win.getBounds())
    }
  })

  hideMenuBar()

  win.webContents.on('will-navigate', (event, url) => {
    const parsed = new URL(url)
    if (parsed.protocol !== 'file:' && !url.startsWith('http://localhost')) {
      event.preventDefault()
    }
  })

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  // Native context menu for editable text fields (textarea, input)
  win.webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable) return
    const menu = Menu.buildFromTemplate([
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { type: 'separator' },
      { role: 'selectAll' },
    ])
    menu.popup()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  if (isDev) win.webContents.openDevTools()
}

interface WindowSize { width: number; height: number }
let normalWindowSize: WindowSize | null = null

function setupWindowIpc(): void {
  const COMPACT_MIN_WIDTH = 400
  const COMPACT_MIN_HEIGHT = 300

  secureHandle(
    IpcChannels.WINDOW_SET_COMPACT_MODE,
    (event, enabled: boolean, compactSize?: { width: number; height: number }): { width: number; height: number } | null => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return null

      const bounds = win.getBounds()
      if (enabled) {
        normalWindowSize = { width: bounds.width, height: bounds.height }
        win.setMinimumSize(COMPACT_MIN_WIDTH, COMPACT_MIN_HEIGHT)
        if (compactSize && compactSize.width > 0 && compactSize.height > 0) {
          const contentBounds = win.getContentBounds()
          const frameW = bounds.width - contentBounds.width
          const frameH = bounds.height - contentBounds.height
          win.setSize(
            Math.max(compactSize.width + frameW, COMPACT_MIN_WIDTH),
            Math.max(compactSize.height + frameH, COMPACT_MIN_HEIGHT),
          )
        }
        return null
      } else {
        const compactBounds = { width: bounds.width, height: bounds.height }
        win.setMinimumSize(MIN_WIDTH, MIN_HEIGHT)
        if (normalWindowSize) {
          win.setSize(
            Math.max(normalWindowSize.width, MIN_WIDTH),
            Math.max(normalWindowSize.height, MIN_HEIGHT),
          )
          normalWindowSize = null
        } else {
          const [w, h] = win.getSize()
          if (w < MIN_WIDTH || h < MIN_HEIGHT) {
            win.setSize(Math.max(w, MIN_WIDTH), Math.max(h, MIN_HEIGHT))
          }
        }
        return compactBounds
      }
    },
  )

  secureHandle(
    IpcChannels.WINDOW_SET_ASPECT_RATIO,
    (event, ratio: number) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return
      if (ratio <= 0) {
        win.setAspectRatio(0)
        return
      }
      const bounds = win.getBounds()
      const contentBounds = win.getContentBounds()
      const frameW = bounds.width - contentBounds.width
      const frameH = bounds.height - contentBounds.height
      win.setAspectRatio(ratio, { width: frameW, height: frameH })
    },
  )

  secureHandle(
    IpcChannels.WINDOW_SET_ALWAYS_ON_TOP,
    (event, enabled: boolean) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return
      win.setAlwaysOnTop(enabled)
    },
  )

  // Always-on-top is not supported on Wayland (compositor controls stacking)
  secureHandle(
    IpcChannels.WINDOW_IS_ALWAYS_ON_TOP_SUPPORTED,
    () => {
      if (process.platform !== 'linux') return true
      return !process.env.WAYLAND_DISPLAY && !process.env.XDG_SESSION_TYPE?.includes('wayland')
    },
  )
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
  setupNotificationStore()
  setupLogIpc()
  setupShellIpc()
  setupWindowIpc()
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
