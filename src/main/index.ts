import { app, BrowserWindow, Menu, screen, session, shell } from 'electron'
import { join, resolve, dirname } from 'node:path'
import { statSync } from 'node:fs'
import { IpcChannels } from '../shared/ipc/channels'
import { setupFileIO } from './file-io'
import { setupSnapshotStore } from './snapshot-store'
import { setupAnalyzeFilterStore } from './analyze-filter-store'
import { setupFavoriteStore } from './favorite-store'
import { setupKeyLabelStore } from './key-label-ipc'
import { setupTypingTestTextStore } from './typing-test-text-ipc'
import { setupTypingRunLogStore } from './typing-run-log-ipc'
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
import { loadWindowState, saveWindowState, setupAppConfigIpc, loadAppConfig, onAppConfigChange, hasSavedWindowPosition, MIN_WIDTH, MIN_HEIGHT } from './app-config'
import { effectiveMinSize, clampBoundsToWorkArea } from './window-bounds'
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

// Single-instance guard: a second launch exits immediately and silently
// (app.exit skips before-quit/will-quit — nothing is set up yet at this
// point); the surviving instance reveals its window instead. Electron only
// emits 'second-instance' on the lock holder and never before 'ready', so
// registering at module top level is safe.
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
} else {
  app.on('second-instance', revealApp)
}

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
  const hasSavedPosition = hasSavedWindowPosition(saved)
  // With a saved position, resolve the display it actually overlaps via the
  // shared helper. With no saved position, `saved` is the -1/-1 sentinel
  // rect, which getDisplayMatching would resolve arbitrarily — Electron
  // centers position-less windows on the primary display instead, so that's
  // the correct clamp target here.
  let display: Electron.Display
  let minSize: Electron.Size
  if (hasSavedPosition) {
    ;({ display, minSize } = minSizeForBounds(saved))
  } else {
    display = screen.getPrimaryDisplay()
    minSize = effectiveMinSize(display.workArea, MIN_WIDTH, MIN_HEIGHT)
  }
  // Clamp size (and, when a saved position exists, origin) into the target
  // display's work area — on a display whose usable area is smaller than
  // the nominal 1280x1024 minimum (e.g. a MacBook's built-in screen under
  // the Dock), this keeps the window from being created oversized and
  // spilling under OS chrome. With no saved position, clamp against the
  // display's own origin instead of the -1/-1 sentinel.
  const boundsToClamp = hasSavedPosition ? saved : { ...saved, x: display.workArea.x, y: display.workArea.y }
  const clampedBounds = clampBoundsToWorkArea(boundsToClamp, display.workArea)
  const winOpts: Electron.BrowserWindowConstructorOptions = {
    width: clampedBounds.width,
    height: clampedBounds.height,
    minWidth: minSize.width,
    minHeight: minSize.height,
    icon: appIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  }
  if (hasSavedPosition) {
    winOpts.x = clampedBounds.x
    winOpts.y = clampedBounds.y
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
  lastAppliedMinSize = minSize

  // document.visibilityState is unreliable for windows created with
  // show: false (notably on Linux, it still reports 'visible'), so the
  // renderer needs main-process visibility truth pushed to it directly.
  win.on('show', () => {
    win.webContents.send(IpcChannels.WINDOW_VISIBILITY_CHANGED, true)
  })
  win.on('hide', () => {
    win.webContents.send(IpcChannels.WINDOW_VISIBILITY_CHANGED, false)
  })

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

  // Re-derive the effective minimum size whenever the window may have
  // landed on a different display (dragged across monitors). 'moved' rather
  // than 'move' — the latter fires on every intermediate drag frame,
  // 'moved' only once the drag settles. Skipped while compact mode owns the
  // minimum size (normalWindowSize non-null).
  win.on('moved', () => {
    if (win.isDestroyed() || normalWindowSize) return
    const { minSize } = minSizeForBounds(win.getBounds())
    applyMinSizeIfChanged(win, minSize)
  })

  // A display's work area itself changing (Dock auto-hide toggled, external
  // monitor (dis)connected) can both shrink the effective minimum and leave
  // the window's current bounds spilling outside the new work area, so this
  // re-applies the minimum size and re-clamps bounds. Also skipped while
  // compact mode is active, and never fights a maximized/fullscreen window
  // (the OS already owns its bounds there). The screen listener is
  // process-wide, so it must be torn down with this window instead of
  // leaking across window lifetimes.
  const handleDisplayMetricsChanged = (): void => {
    if (win.isDestroyed() || normalWindowSize) return
    if (win.isMaximized() || win.isFullScreen()) return
    const { display, minSize } = minSizeForBounds(win.getBounds())
    applyMinSizeIfChanged(win, minSize)
    const current = win.getBounds()
    const clamped = clampBoundsToWorkArea(current, display.workArea)
    if (clamped.x !== current.x || clamped.y !== current.y || clamped.width !== current.width || clamped.height !== current.height) {
      win.setBounds(clamped)
    }
  }
  screen.on('display-metrics-changed', handleDisplayMetricsChanged)
  win.on('closed', () => {
    screen.removeListener('display-metrics-changed', handleDisplayMetricsChanged)
    lastAppliedMinSize = null
    normalWindowSize = null
  })
}

// Bring the app to the user's attention: reveal the existing window
// (hidden tray-resident, or minimized) or create one when none exists.
// Shared by both relaunch paths — 'second-instance' (Windows/Linux spawn
// a second process that loses the lock) and macOS 'activate' (a Dock/
// Finder relaunch re-activates the running process instead) — so every
// platform gives the same visible feedback when the user launches the
// app while it is already running.
function revealApp(): void {
  // A relaunch attempt racing this instance's own startup can arrive
  // before 'ready'; creating a BrowserWindow then would throw, and the
  // startup sequence is about to produce the window anyway.
  if (!app.isReady()) return
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  } else {
    showWindow(getFirstWindow)
  }
}

let activeAnimationId = 0

/** @param onComplete Called exactly once per animation, with `completed` true
 * only when this animation actually ran to the end as the still-active
 * animation on a still-live window — false when a later `animateBounds` call
 * superseded it (or the window was destroyed) before it finished. Callers
 * that mutate shared state (e.g. `normalWindowSize`) on completion must gate
 * that mutation on `completed` so a superseded animation can't stomp on
 * state a newer animation already owns. */
function animateBounds(
  win: BrowserWindow,
  from: Electron.Rectangle,
  to: { x: number; y: number; width: number; height: number },
  duration = 200,
  onComplete?: (completed: boolean) => void,
): void {
  const id = ++activeAnimationId
  const steps = Math.max(1, Math.round(duration / 16))
  let step = 0
  const lerp = (a: number, b: number, t: number): number => Math.round(a + (b - a) * t)
  const easeOut = (t: number): number => 1 - (1 - t) ** 2

  const tick = (): void => {
    if (id !== activeAnimationId || win.isDestroyed()) { onComplete?.(false); return }
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
      onComplete?.(true)
    }
  }
  tick()
}
let normalWindowSize: Electron.Size | null = null

/** Resolves the display a rect currently overlaps and the effective
 * minimum size for that display's work area. The single place the
 * screen.getDisplayMatching + effectiveMinSize pair is computed — shared by
 * createWindow, both compact-exit branches, and the display-change
 * listeners. Callers that must not fight compact mode's own minimum size
 * (300x100) guard on `normalWindowSize` themselves before calling this. */
function minSizeForBounds(bounds: Electron.Rectangle): { display: Electron.Display; minSize: Electron.Size } {
  const display = screen.getDisplayMatching(bounds)
  const minSize = effectiveMinSize(display.workArea, MIN_WIDTH, MIN_HEIGHT)
  return { display, minSize }
}

/** The minimum size this module last applied to a window via setMinimumSize,
 * so bursts of identical re-applies (display-metrics-changed firing
 * repeatedly, or a compact-exit setBounds re-triggering 'moved' with the
 * same bounds) can skip the redundant native call. Reset whenever a window
 * is created or closed. */
let lastAppliedMinSize: Electron.Size | null = null

/** Applies `minSize` to `win` unless it is identical to the size this
 * module last applied — see {@link lastAppliedMinSize}. */
function applyMinSizeIfChanged(win: BrowserWindow, minSize: Electron.Size): void {
  if (lastAppliedMinSize && lastAppliedMinSize.width === minSize.width && lastAppliedMinSize.height === minSize.height) {
    return
  }
  win.setMinimumSize(minSize.width, minSize.height)
  lastAppliedMinSize = minSize
}

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
          applyMinSizeIfChanged(win, { width: COMPACT_MIN_WIDTH, height: COMPACT_MIN_HEIGHT })
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
        const { display, minSize } = minSizeForBounds(bounds)
        if (normalWindowSize) {
          const newW = Math.max(normalWindowSize.width, minSize.width)
          const newH = Math.max(normalWindowSize.height, minSize.height)
          const targetX = bounds.x - Math.round((newW - bounds.width) / 2)
          const targetY = bounds.y - Math.round((newH - bounds.height) / 2)
          const target = clampBoundsToWorkArea({ x: targetX, y: targetY, width: newW, height: newH }, display.workArea)
          await new Promise<void>((resolve) => {
            animateBounds(win, bounds, target, 300, (completed) => {
              // A superseded animation (a new compact-enter started before
              // this exit finished) must not re-apply the full-size minimum
              // or clear normalWindowSize out from under it.
              if (completed) {
                applyMinSizeIfChanged(win, minSize)
                normalWindowSize = null
              }
              resolve()
            })
          })
        } else {
          applyMinSizeIfChanged(win, minSize)
          const [w, h] = win.getSize()
          // The minimum is display-aware; only correct the size when it
          // actually falls below that, leaving an in-range window alone.
          if (w < minSize.width || h < minSize.height) {
            const target = clampBoundsToWorkArea(
              { x: bounds.x, y: bounds.y, width: Math.max(w, minSize.width), height: Math.max(h, minSize.height) },
              display.workArea,
            )
            win.setBounds(target)
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
      applyMinSizeIfChanged(win, { width: Math.max(width, 1), height: Math.max(height, 1) })
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

  secureHandle(IpcChannels.WINDOW_SHOW, (): boolean => {
    return showWindow(getFirstWindow)
  })

  secureHandle(IpcChannels.WINDOW_HIDE, () => {
    hideWindow(getFirstWindow)
  })

  secureHandle(IpcChannels.WINDOW_STARTED_HIDDEN, (): boolean => getWindowStartedHidden())

  secureHandle(IpcChannels.WINDOW_IS_VISIBLE, (): boolean => getFirstWindow()?.isVisible() ?? false)

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
    typeof v.count === 'number' &&
    typeof v.kpm === 'number'
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
  setupTypingRunLogStore()
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

  app.on('activate', revealApp)
})

app.on('window-all-closed', () => {
  // With trayResident on, the close handler hides the window via
  // preventDefault() instead of letting it close, so this rarely fires —
  // isTrayActive() is a safety net in case a window closes some other way.
  if (process.platform !== 'darwin' && !isTrayActive()) {
    app.quit()
  }
})
