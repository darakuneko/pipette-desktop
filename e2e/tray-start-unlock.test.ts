// SPDX-License-Identifier: GPL-2.0-or-later
//
// Covers the boot-hidden Unlock dialog fix: with trayResident+startInTray
// enabled and the app quit while in typing view, a relaunch with a locked
// keyboard must (a) show the hidden window with the Unlock dialog instead
// of staying tray-resident, and (b) hide the window back to the tray once
// unlocked. Exercises both restore paths — typingView (dialog opened by
// the view-mode restore in App.tsx, which is unlock-gated) and plain
// editor (no view-mode restore requires unlocking, so the window must
// stay hidden and no dialog must appear — useBootHiddenWindow no longer
// opens the dialog on its own).
//
// Uses the virtual device (PIPETTE_VIRTUAL_DEVICE='only'), which relocks
// on every launch so the Unlock dialog is guaranteed to appear on each
// relaunch below. Mutates the Playwright userData dir (~/.config/Electron)
// directly, with backup/restore around the whole run. Sessions launch
// sequentially — the app's single-instance lock means each session must
// fully exit before the next one starts, so there is no way to run these
// three tests in parallel or out of order.

import { test, expect } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { launchApp } from './helpers/electron'
import {
  connectToDevice,
  clickThroughUnlock,
  waitForUnlockDialog,
  unlockDialogHeading,
  dismissNotificationModal,
  backupFile,
  restoreFile,
  VIRTUAL_DEVICE_DISPLAY_NAME,
  VIRTUAL_DEVICE_UID,
  type FileBackup,
} from './helpers/doc-capture-common'

const USER_DATA = join(homedir(), '.config', 'Electron')
const CONFIG_PATH = join(USER_DATA, 'config.json')
const SETTINGS_PATH = join(USER_DATA, 'sync', 'keyboards', VIRTUAL_DEVICE_UID, 'pipette_settings.json')

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> } catch { return null }
}

// Reset flags a previous (crashed) run may have left behind so the setup
// session starts as a normal visible launch with a device list.
function cleanTestFlags(): void {
  const cfg = readJson(CONFIG_PATH)
  if (cfg) {
    cfg.trayResident = false
    cfg.startInTray = false
    cfg.restoreLastSession = true
    delete cfg.lastDevice
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2))
  }
  // Also reset the persisted view mode from a previous run, otherwise the
  // auto-restore path opens the Unlock dialog right after connecting and
  // its overlay blocks the setup session's clicks.
  const prefs = readJson(SETTINGS_PATH)
  if (prefs && prefs.viewMode !== 'editor') {
    prefs.viewMode = 'editor'
    writeFileSync(SETTINGS_PATH, JSON.stringify(prefs, null, 2))
  }
}

function electronRunning(): boolean {
  try {
    // [n] bracket trick: keeps this pgrep's own sh -c wrapper (whose
    // command line contains the pattern text) from matching itself.
    execSync('pgrep -f "electron/dist/electro[n].*out/main/index.js"', { stdio: 'pipe' })
    return true
  } catch { return false }
}

async function waitForElectronExit(timeoutMs = 30_000): Promise<void> {
  const start = Date.now()
  while (electronRunning()) {
    if (Date.now() - start > timeoutMs) throw new Error('previous electron instance did not exit')
    await new Promise((r) => setTimeout(r, 500))
  }
}

async function quitApp(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: a }) => { a.quit() }).catch(() => {})
  await new Promise((r) => setTimeout(r, 2000))
  await app.close().catch(() => { /* already gone */ })
  await waitForElectronExit()
}

let app: ElectronApplication | null = null
let configBackup: FileBackup
let settingsBackup: FileBackup

test.describe.serial('tray start-in-tray unlock reveal', () => {
  test.setTimeout(180_000)

  test.beforeAll(() => {
    if (electronRunning()) {
      throw new Error('another electron instance is already running — aborting')
    }
    // Snapshot the files this run will mutate BEFORE any launch touches them.
    configBackup = backupFile(CONFIG_PATH)
    settingsBackup = backupFile(SETTINGS_PATH)
    cleanTestFlags()
  })

  test.afterAll(async () => {
    if (app) await quitApp(app).catch(() => {})
    restoreFile(configBackup)
    restoreFile(settingsBackup)
  })

  test('setup: connect, enter typing view, enable tray flags, quit while in typing view', async () => {
    const launched = await launchApp({ env: { PIPETTE_VIRTUAL_DEVICE: 'only' } })
    app = launched.app
    const page = launched.page

    const actualUserData = await app.evaluate(({ app: a }) => a.getPath('userData'))
    expect(actualUserData).toBe(USER_DATA)

    await dismissNotificationModal(page, { waitForAppearMs: 3_000 })

    const connected = await connectToDevice(page, VIRTUAL_DEVICE_DISPLAY_NAME)
    expect(connected).toBe(true)

    // Enter view-only typing mode (unlock-gated on the freshly locked
    // virtual device).
    const viewOnlyBtn = page.locator('[data-testid="view-only-button"]')
    await viewOnlyBtn.waitFor({ state: 'visible', timeout: 10_000 })
    await clickThroughUnlock(app, page, viewOnlyBtn)
    await page.waitForTimeout(2000)

    // Enable tray-resident + start-in-tray (restoreLastSession already
    // defaults to true).
    await page.evaluate(async () => {
      const api = (window as unknown as { vialAPI: { appConfigSet: (k: string, v: unknown) => Promise<void> } }).vialAPI
      await api.appConfigSet('trayResident', true)
      await api.appConfigSet('startInTray', true)
    })
    await page.waitForTimeout(800)

    // Quit while still in typingView.
    await quitApp(app)
    app = null

    const cfg = readJson(CONFIG_PATH)
    const prefs = readJson(SETTINGS_PATH)
    expect(cfg?.trayResident).toBe(true)
    expect(cfg?.startInTray).toBe(true)
    expect(prefs?.viewMode).toBe('typingView')
  })

  test('typingView restore path: relaunch reveals the Unlock dialog then hides back to tray', async () => {
    const launched = await launchApp({ env: { PIPETTE_VIRTUAL_DEVICE: 'only' } })
    app = launched.app
    const page = launched.page

    let dialogSeenVisible = false
    await expect.poll(async () => {
      const winVisible = await app!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((w) => w.isVisible()))
      const dialogUp = (await unlockDialogHeading(page).count()) > 0
      if (dialogUp && winVisible.some(Boolean)) dialogSeenVisible = true
      return dialogSeenVisible
    }, { message: 'expected the Unlock dialog to appear in a visible window', timeout: 25_000, intervals: [1000] }).toBe(true)

    await waitForUnlockDialog(app, page)

    await expect.poll(async () => {
      const winVisible = await app!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((w) => w.isVisible()))
      return winVisible.some(Boolean)
    }, { message: 'expected the window to hide back to the tray after unlock', timeout: 15_000, intervals: [1000] }).toBe(false)
    await expect(unlockDialogHeading(page)).toHaveCount(0)

    await quitApp(app)
    app = null
  })

  test('editor restore path: relaunch stays tray-resident with no Unlock dialog', async () => {
    // Rewrite the persisted view mode to plain editor so this session
    // restores into a view that does not require unlocking. Only the
    // typingView (and typingTest/matrix-test) restore paths are allowed to
    // open the Unlock dialog — a boot-hidden restore of the plain editor
    // must leave the window hidden and never show the dialog at all.
    const prefs = readJson(SETTINGS_PATH)
    expect(prefs).not.toBeNull()
    if (prefs) {
      prefs.viewMode = 'editor'
      writeFileSync(SETTINGS_PATH, JSON.stringify(prefs, null, 2))
    }

    const launched = await launchApp({ env: { PIPETTE_VIRTUAL_DEVICE: 'only' } })
    app = launched.app
    const page = launched.page

    // Sample repeatedly over a window long enough for the fixed bug to have
    // resurfaced (it used to fire this reveal shortly after the keyboard's
    // unlock status resolved) — the window must stay hidden and the dialog
    // must never appear.
    for (let sample = 0; sample < 10; sample++) {
      const winVisible = await app!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((w) => w.isVisible()))
      const dialogUp = (await unlockDialogHeading(page).count()) > 0
      expect(winVisible.some(Boolean), `window became visible on sample ${sample}`).toBe(false)
      expect(dialogUp, `Unlock dialog appeared on sample ${sample}`).toBe(false)
      await page.waitForTimeout(1000)
    }

    await quitApp(app)
    app = null
  })
})
