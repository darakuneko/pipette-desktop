// SPDX-License-Identifier: GPL-2.0-or-later
// OS integration for auto-launch-at-login and system-tray residency.

import { app, Menu, nativeImage, Tray } from 'electron'
import type { BrowserWindow } from 'electron'
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { log } from './logger'

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

/**
 * Create the singleton system-tray icon and its context menu. Safe to
 * call repeatedly — a second call while the tray is already active is a
 * no-op, so callers (the config-change listener, app startup) don't need
 * to track tray state themselves.
 */
export function setupTray(getWindow: () => BrowserWindow | null): void {
  if (trayInstance) return

  trayInstance = new Tray(nativeImage.createFromPath(appIconPath()))
  trayInstance.setToolTip('Pipette')

  const showWindow = (): void => {
    const win = getWindow()
    if (!win) return
    win.show()
    win.focus()
  }

  // Fixed English labels: the main process has no i18next runtime (it
  // only runs in the renderer), so the tray menu cannot be localized yet.
  const menu = Menu.buildFromTemplate([
    { label: 'Show', click: showWindow },
    { label: 'Quit', click: () => app.quit() },
  ])
  trayInstance.setContextMenu(menu)
  // Left-click shows the window too — Windows/Linux tray convention. A
  // harmless no-op on macOS, where clicking the icon opens the menu instead.
  trayInstance.on('click', showWindow)
}

export function destroyTray(): void {
  if (!trayInstance) return
  trayInstance.destroy()
  trayInstance = null
}

export function isTrayActive(): boolean {
  return trayInstance !== null
}
