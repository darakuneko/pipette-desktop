// SPDX-License-Identifier: GPL-2.0-or-later
// OS integration for auto-launch-at-login and system-tray residency.

import { app, Menu, nativeImage, Tray } from 'electron'
import type { BrowserWindow } from 'electron'
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { log } from './logger'
import type { TrayStatus } from '../shared/types/vial-api'

/** Path to the XDG autostart desktop entry used on Linux. Exported so
 * tests (and any future uninstall/cleanup path) can target the exact
 * location without duplicating the join() logic. */
export function autostartDesktopPath(): string {
  return join(homedir(), '.config', 'autostart', 'pipette.desktop')
}

function buildAutostartDesktopEntry(): string {
  // AppImage builds re-exec through a mount path; process.execPath would
  // point at the temporary mount, so prefer APPIMAGE (the stable launcher
  // path) when present.
  const execPath = process.env.APPIMAGE ?? process.execPath
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Pipette',
    'Comment=Vial-compatible keyboard configurator',
    `Exec="${execPath}"`,
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n')
}

function isEnoentError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT'
}

function applyLinuxAutostart(enabled: boolean): void {
  const target = autostartDesktopPath()
  try {
    if (enabled) {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, buildAutostartDesktopEntry(), 'utf-8')
    } else {
      unlinkSync(target)
    }
  } catch (err: unknown) {
    // Disabling an autostart entry that was never created is not an error.
    if (!enabled && isEnoentError(err)) return
    const detail = err instanceof Error ? err.message : String(err)
    log('error', `auto-launch: failed to update Linux autostart entry: ${detail}`)
  }
}

/**
 * Register (or unregister) the app to start when the user signs in to
 * the OS.
 *
 * Skipped entirely for unpackaged builds: the dev exec path points at the
 * bare `electron` binary, so registering it as a login item would launch
 * the wrong thing on every platform.
 */
export function applyAutoLaunch(enabled: boolean, platform: NodeJS.Platform = process.platform): void {
  if (!app.isPackaged) {
    log('warn', 'auto-launch skipped: unpackaged build')
    return
  }
  if (platform === 'win32' || platform === 'darwin') {
    app.setLoginItemSettings({ openAtLogin: enabled })
    return
  }
  if (platform === 'linux') {
    applyLinuxAutostart(enabled)
  }
}

/** Packaged application icon, shared by the main window and the tray so
 *  the two can never diverge if the asset moves. */
export function appIconPath(): string {
  return join(__dirname, '../../build/icon.png')
}

let trayInstance: Tray | null = null

/** Show and focus the given window. Shared by the tray menu/click
 * handlers and the WINDOW_SHOW IPC handler so a hidden (start-in-tray)
 * window and the tray icon reveal it the same way. Returns whether the
 * window actually transitioned from hidden to shown, so callers that only
 * want to act on a genuine hidden→visible edge (e.g. the boot-hidden Unlock
 * dialog flow) can tell that apart from a window that was already visible. */
export function showWindow(getWindow: () => BrowserWindow | null): boolean {
  const win = getWindow()
  if (!win) return false
  const wasVisible = win.isVisible()
  win.show()
  win.focus()
  return !wasVisible
}

const DEFAULT_TRAY_STATUS: TrayStatus = { keyboardName: null, recording: false, count: 0, kpm: 0 }

// Latest status reported by the renderer (the source of truth — see
// App.tsx; the tray never reads HID/analytics state itself). Module-level
// so a config toggle that tears down and recreates the tray (trayResident
// off→on) does not lose the current keyboard/REC state — setupTray
// re-applies whatever was last received, regardless of arrival order.
// This is renderer-owned state: neither destroyTray nor updateTrayStatus
// resets it back to the disconnected default — the renderer sends the
// cleared status itself on disconnect.
let cachedTrayStatus: TrayStatus = DEFAULT_TRAY_STATUS

function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}

function formatTrayTooltip(status: TrayStatus): string {
  if (!status.keyboardName) return 'Pipette'
  if (!status.recording) return `Pipette — ${status.keyboardName}`
  return `Pipette — ${status.keyboardName} — Cnt: ${formatCount(status.count)} · KPM: ${formatCount(status.kpm)}`
}

/** Disabled info rows shown between the two separators: the connected
 * keyboard's name (when connected), then — while recording — a
 * "Recording" marker plus separate Cnt/KPM rows. Empty when disconnected
 * and not recording, in which case buildTrayMenu omits the surrounding
 * block entirely. */
function buildInfoRows(status: TrayStatus): Electron.MenuItemConstructorOptions[] {
  const rows: Electron.MenuItemConstructorOptions[] = []
  if (status.keyboardName) {
    rows.push({ label: status.keyboardName, enabled: false })
  }
  if (status.recording) {
    rows.push({ label: 'Recording', enabled: false })
    rows.push({ label: `Cnt: ${formatCount(status.count)}`, enabled: false })
    rows.push({ label: `KPM: ${formatCount(status.kpm)}`, enabled: false })
  }
  return rows
}

/** Build the tray context menu for the given status: Show, a separator,
 * the disabled info block (only when non-empty), another separator, then
 * Quit. Fixed English labels throughout — see setupTray for why. */
function buildTrayMenu(getWindow: () => BrowserWindow | null, status: TrayStatus): Menu {
  const items: Electron.MenuItemConstructorOptions[] = []
  items.push({ label: 'Show', click: () => showWindow(getWindow) })
  items.push({ type: 'separator' })
  const infoRows = buildInfoRows(status)
  if (infoRows.length > 0) {
    items.push(...infoRows)
    items.push({ type: 'separator' })
  }
  items.push({ label: 'Quit', click: () => app.quit() })
  return Menu.buildFromTemplate(items)
}

/** Apply the cached status to the live tray's tooltip and context menu.
 * No-op when the tray hasn't been created yet. The menu is rebuilt on
 * every applied update — including the ≤1 Hz count/KPM ticks while REC
 * runs — deliberately: GNOME-family trays often never show tooltips, so
 * the menu's Cnt/KPM rows are the only place the live rate is visible
 * there, and the renderer's dedupe/throttle already bounds the rebuild
 * rate. */
function applyCachedTrayStatus(getWindow: () => BrowserWindow | null): void {
  if (!trayInstance) return
  trayInstance.setToolTip(formatTrayTooltip(cachedTrayStatus))
  trayInstance.setContextMenu(buildTrayMenu(getWindow, cachedTrayStatus))
}

/** Update the tray with the connected keyboard's name and REC keystroke
 * count. Always caches the status (even with no tray active yet) so a
 * later setupTray() — e.g. the user enables trayResident after the status
 * already arrived — reflects the current state immediately instead of
 * starting from the disconnected default. */
export function updateTrayStatus(status: TrayStatus, getWindow: () => BrowserWindow | null): void {
  cachedTrayStatus = status
  applyCachedTrayStatus(getWindow)
}

/** Hide the given window, but only while the tray is active — a hidden
 * window with no tray icon to reopen it would be unreachable. Backs the
 * WINDOW_HIDE IPC handler used by the renderer's "start hidden" flow. */
export function hideWindow(getWindow: () => BrowserWindow | null): void {
  if (!isTrayActive()) return
  const win = getWindow()
  if (!win) return
  win.hide()
}

/**
 * Create the singleton system-tray icon and its context menu. Safe to
 * call repeatedly — a second call while the tray is already active is a
 * no-op, so callers (the config-change listener, app startup) don't need
 * to track tray state themselves.
 */
export function setupTray(getWindow: () => BrowserWindow | null): void {
  if (trayInstance) return

  trayInstance = new Tray(nativeImage.createFromPath(appIconPath()))
  // Fixed English labels throughout: the main process has no i18next
  // runtime (it only runs in the renderer), so the tray cannot be
  // localized yet.
  applyCachedTrayStatus(getWindow)

  // Left-click shows the window too — Windows/Linux tray convention. A
  // harmless no-op on macOS, where clicking the icon opens the menu instead.
  trayInstance.on('click', () => showWindow(getWindow))
}

export function destroyTray(): void {
  if (!trayInstance) return
  trayInstance.destroy()
  trayInstance = null
}

export function isTrayActive(): boolean {
  return trayInstance !== null
}

// Whether THIS launch created the main window hidden (startInTray +
// trayResident both enabled at createWindow() time). This is a static
// per-launch fact, not the window's current visibility — it never
// changes after startup, even once the window is later shown.
let didStartWindowHidden = false

export function setWindowStartedHidden(hidden: boolean): void {
  didStartWindowHidden = hidden
}

export function getWindowStartedHidden(): boolean {
  return didStartWindowHidden
}
