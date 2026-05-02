import { app, BrowserWindow, Menu, session, shell } from 'electron'
import { join, resolve, dirname } from 'node:path'
import { statSync } from 'node:fs'
import { IpcChannels } from '../shared/ipc/channels'
import { setupFileIO } from './file-io'
import { setupSnapshotStore } from './snapshot-store'
import { setupAnalyzeFilterStore } from './analyze-filter-store'
import { setupFavoriteStore } from './favorite-store'
import { setupKeyLabelStore } from './key-label-ipc'
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
import {
  setupTypingAnalytics,
  setupTypingAnalyticsIpc,
  hasTypingAnalyticsPendingWork,
  flushTypingAnalyticsBeforeQuit,
  setTypingAnalyticsSyncNotifier,
} from './typing-analytics/typing-analytics-service'
import { registerPreSyncQuitFinalizer, notifyChange } from './sync/sync-service'
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

let activeAnimationId = 0

function animateBounds(
  win: BrowserWindow,
  from: Electron.Rectangle,
  to: { x: number; y: number; width: number; height: number },
  duration = 200,
  onComplete?: () => void,
): void {
  const id = ++activeAnimationId
  const steps = Math.max(1, Math.round(duration / 16))
  let step = 0
  const lerp = (a: number, b: number, t: number): number => Math.round(a + (b - a) * t)
  const easeOut = (t: number): number => 1 - (1 - t) ** 2

  const tick = (): void => {
    if (id !== activeAnimationId || win.isDestroyed()) { onComplete?.(); return }
    step++
    const t = easeOut(Math.min(step / steps, 1))
    win.setBounds({
      x: lerp(from.x, to.x, t),
      y: lerp(from.y, to.y, t),
      width: lerp(from.width, to.width, t),
      height: lerp(from.height, to.height, t),
    })
    if (step < steps) {
      setTimeout(tick, 16)
    } else {
      onComplete?.()
    }
  }
  tick()
}
let normalWindowSize: WindowSize | null = null

function setupWindowIpc(): void {
  const COMPACT_MIN_WIDTH = 300
  const COMPACT_MIN_HEIGHT = 100

  secureHandle(
    IpcChannels.WINDOW_SET_COMPACT_MODE,
    async (event, enabled: boolean, compactSize?: { width: number; height: number }): Promise<{ width: number; height: number } | null> => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return null

      const bounds = win.getBounds()
      if (enabled) {
        if (!normalWindowSize) {
          normalWindowSize = { width: bounds.width, height: bounds.height }
          win.setMinimumSize(COMPACT_MIN_WIDTH, COMPACT_MIN_HEIGHT)
        }
        if (compactSize && compactSize.width > 0 && compactSize.height > 0) {
          const contentBounds = win.getContentBounds()
          const frameW = bounds.width - contentBounds.width
          const frameH = bounds.height - contentBounds.height
          const newW = Math.max(compactSize.width + frameW, COMPACT_MIN_WIDTH)
          const newH = Math.max(compactSize.height + frameH, COMPACT_MIN_HEIGHT)
          const targetX = bounds.x + Math.round((bounds.width - newW) / 2)
          const targetY = bounds.y + Math.round((bounds.height - newH) / 2)
          animateBounds(win, bounds, { x: targetX, y: targetY, width: newW, height: newH })
        }
        return null
      } else {
        const compactBounds = { width: bounds.width, height: bounds.height }
        if (normalWindowSize) {
          const newW = Math.max(normalWindowSize.width, MIN_WIDTH)
          const newH = Math.max(normalWindowSize.height, MIN_HEIGHT)
          const targetX = bounds.x - Math.round((newW - bounds.width) / 2)
          const targetY = bounds.y - Math.round((newH - bounds.height) / 2)
          await new Promise<void>((resolve) => {
            animateBounds(win, bounds, { x: targetX, y: targetY, width: newW, height: newH }, 300, () => {
              win.setMinimumSize(MIN_WIDTH, MIN_HEIGHT)
              resolve()
            })
          })
          normalWindowSize = null
        } else {
          win.setMinimumSize(MIN_WIDTH, MIN_HEIGHT)
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

  secureHandle(
    IpcChannels.WINDOW_SET_MIN_SIZE,
    (event, width: number, height: number) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return
      win.setMinimumSize(Math.max(width, 1), Math.max(height, 1))
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
  setupAnalyzeFilterStore()
  setupFavoriteStore()
  setupKeyLabelStore()
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
  setTypingAnalyticsSyncNotifier(notifyChange)
  setupTypingAnalyticsIpc()
  registerPreSyncQuitFinalizer({
    hasWork: hasTypingAnalyticsPendingWork,
    run: flushTypingAnalyticsBeforeQuit,
  })
  setupTypingAnalytics().catch((err: unknown) => {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
    log('error', `Failed to initialize typing analytics: ${detail}`)
  })
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
