import { app, BrowserWindow, Menu, session, shell } from 'electron'
import { join, resolve, dirname } from 'node:path'
import { statSync } from 'node:fs'
import { IpcChannels } from '../shared/ipc/channels'
import { setupFileIO } from './file-io'
import { setupSnapshotStore } from './snapshot-store'
import { setupAnalyzeFilterStore } from './analyze-filter-store'
import { setupFavoriteStore } from './favorite-store'
import { setupKeyLabelStore } from './key-label-ipc'
import { setupTypingTestTextStore } from './typing-test-text-ipc'
import { setupI18nPackStore } from './i18n-pack-ipc'
import { setupThemePackStore } from './theme-pack-ipc'
import { setupHidIpc } from './hid-ipc'
import { setupPipetteSettingsStore } from './pipette-settings-store'
import { setupLanguageStore } from './language-store'
import { setupAozoraIpc } from './aozora/aozora-ipc'
import { setupSyncIpc } from './sync/sync-ipc'
import { setupHubIpc } from './hub/hub-ipc'
import { startI18nStartupSync } from './hub/i18n-startup-sync'
import { setupLzmaIpc } from './lzma'
import { setupNotificationStore } from './notification-store'
import { buildCsp, securityHeaders } from './csp'
import { log, logHidPacket } from './logger'
import type { LogLevel } from './logger'
import { loadWindowState, saveWindowState, setupAppConfigIpc, loadAppConfig, onAppConfigChange, MIN_WIDTH, MIN_HEIGHT } from './app-config'
import { clampZoomFactor } from '../shared/types/app-config'
import {
  applyAutoLaunch,
  setupTray,
  destroyTray,
  isTrayActive,
  appIconPath,
  showWindow,
  hideWindow,
  setWindowStartedHidden,
  getWindowStartedHidden,
  updateTrayStatus,
} from './app-behavior'
import type { TrayStatus } from '../shared/types/vial-api'
import {
  setupTypingAnalytics,
  setupTypingAnalyticsIpc,
  hasTypingAnalyticsPendingWork,
  flushTypingAnalyticsBeforeQuit,
  setTypingAnalyticsSyncNotifier,
} from './typing-analytics/typing-analytics-service'
import { registerPreSyncQuitFinalizer, notifyChange } from './sync/sync-service'
import { secureHandle, secureOn } from './ipc-guard'
import { isVirtualDeviceEnabled, getVirtualDeviceController } from './virtual-device'

const isDev = !!process.env.ELECTRON_RENDERER_URL

app.setDesktopName('pipette')

// Distinguishes a user-initiated quit from a plain window close so the
// tray-resident close handler knows whether to hide the window instead of
// letting it (and the app) close.
let isQuitting = false
app.on('before-quit', () => {
  isQuitting = true
})

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
  const cfg = loadAppConfig()
  const saved = loadWindowState()
  const winOpts: Electron.BrowserWindowConstructorOptions = {
    width: saved.width,
    height: saved.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    icon: appIconPath(),
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
  // Only start hidden when the tray can actually reopen the window — a
  // hidden window with no tray icon would be unreachable. The tray is
  // set up from the same trayResident flag elsewhere in the startup
  // sequence (app.whenReady()), so this stays in sync with it.
  const startHidden = cfg.startInTray && cfg.trayResident
  if (startHidden) {
    winOpts.show = false
  }
  setWindowStartedHidden(startHidden)
  const win = new BrowserWindow(winOpts)

  win.on('close', (e) => {
    if (normalWindowSize) {
      const bounds = win.getBounds()
      saveWindowState({ ...bounds, width: normalWindowSize.width, height: normalWindowSize.height })
    } else {
      saveWindowState(win.getBounds())
    }
    // Gate on the live tray resource, not the trayResident config flag:
    // the config-change listener keeps the tray in sync (so mid-session
    // toggles apply without a restart), and if Tray construction ever
    // failed we must not hide the only window with nothing to restore it.
    // Also avoids electron-store's per-access file read on every close.
    if (isTrayActive() && !isQuitting) {
      e.preventDefault()
      win.hide()
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

  win.webContents.setZoomFactor(clampZoomFactor(cfg.zoomFactor) / 100)
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

/** The main window, shared by the tray (show-from-tray) and the
 * show/hide IPC handlers. This app only ever has one top-level window,
 * so "first" is unambiguous. */
function getFirstWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null
}

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

  secureHandle(
    IpcChannels.WINDOW_SET_ZOOM,
    (event, zoom: number) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return
      win.webContents.setZoomFactor(clampZoomFactor(zoom) / 100)
    },
  )

  secureHandle(IpcChannels.WINDOW_SHOW, () => {
    showWindow(getFirstWindow)
  })

  secureHandle(IpcChannels.WINDOW_HIDE, () => {
    hideWindow(getFirstWindow)
  })

  secureHandle(IpcChannels.WINDOW_STARTED_HIDDEN, (): boolean => getWindowStartedHidden())

  secureHandle(IpcChannels.TRAY_STATUS_UPDATE, (_event, status: unknown) => {
    if (!isValidTrayStatus(status)) return
    updateTrayStatus(status, getFirstWindow)
  })
}

/** Minimal shape validation for a payload crossing the IPC boundary —
 * the renderer is trusted but not the wire format, so a malformed call
 * (stale renderer bundle, future field drift) is dropped instead of
 * corrupting the tray's cached status. */
function isValidTrayStatus(value: unknown): value is TrayStatus {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (v.keyboardName === null || typeof v.keyboardName === 'string') &&
    typeof v.recording === 'boolean' &&
    typeof v.count === 'number'
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
  if (isVirtualDeviceEnabled()) {
    const globalWithVirtualDevice = globalThis as Record<string, unknown>
    globalWithVirtualDevice.__pipetteVirtualDevice = getVirtualDeviceController()
  }
  setupFileIO()
  setupSnapshotStore()
  setupAnalyzeFilterStore()
  setupFavoriteStore()
  setupKeyLabelStore()
  setupTypingTestTextStore()
  setupI18nPackStore()
  setupThemePackStore()
  setupPipetteSettingsStore()
  setupLanguageStore()
  setupAozoraIpc()
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
  onAppConfigChange((key, value) => {
    if (key !== 'zoomFactor') return
    const pct = clampZoomFactor(value)
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.setZoomFactor(pct / 100)
    }
  })

  onAppConfigChange((key, value) => {
    if (key === 'autoLaunch') {
      applyAutoLaunch(Boolean(value))
    } else if (key === 'trayResident') {
      if (value) {
        setupTray(getFirstWindow)
      } else {
        destroyTray()
      }
    }
  })

  setupTypingAnalytics().catch((err: unknown) => {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
    log('error', `Failed to initialize typing analytics: ${detail}`)
  })
  createWindow()

  const behaviorConfig = loadAppConfig()
  applyAutoLaunch(behaviorConfig.autoLaunch)
  if (behaviorConfig.trayResident) {
    setupTray(getFirstWindow)
  }

  // Best-effort: refresh Hub-linked i18n packs in the background. This
  // never blocks startup — if Hub is unreachable or a single pack fails
  // to validate, the function logs and returns. Renderer windows are
  // notified via I18N_PACK_CHANGED so the language picker reflects any
  // applied updates without a manual reload.
  startI18nStartupSync()

  // The typing-test dataset is NOT auto-synced at startup. The Mode modal
  // checks the Hub version when its tab is shown and surfaces a manual
  // "Update" button (see TYPING_DATASET_CHECK / TYPING_DATASET_UPDATE).

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  // With trayResident on, the close handler hides the window via
  // preventDefault() instead of letting it close, so this rarely fires —
  // isTrayActive() is a safety net in case a window closes some other way.
  if (process.platform !== 'darwin' && !isTrayActive()) {
    app.quit()
  }
})
