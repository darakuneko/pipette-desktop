// SPDX-License-Identifier: GPL-2.0-or-later
//
// Regression coverage for the macOS window-overflow bug (issue #419): the
// window's nominal minimum size (1280x1024) is an intentional product
// decision and must stay, but on a display whose usable work area is
// smaller than that (small MacBook screens under the Dock; also reachable
// on any platform via a corrupted/oversized saved windowState) the window
// must be clamped to fit the visible area instead of spilling under OS
// chrome. Seeds a wildly oversized saved windowState directly into
// config.json (mirrors the on-disk shape loadWindowState() reads), then
// launches the real app and asserts the *requested* bounds — the ones the
// app itself asked for — fit inside the current display's work area. Note:
// the window manager on this Linux CI box also clamps oversized windows on
// its own, so this only proves the fix if it asserts on bounds the app
// requested before the WM had a chance to intervene, which is exactly what
// BrowserWindow.getBounds() reports from the main process.

import { test, expect } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { writeFileSync } from 'node:fs'
import { launchApp, readJson, electronRunning, quitApp } from './helpers/electron'
import {
  connectToDevice,
  dismissNotificationModal,
  backupFile,
  restoreFile,
  VIRTUAL_DEVICE_DISPLAY_NAME,
  type FileBackup,
} from './helpers/doc-capture-common'

const USER_DATA = join(homedir(), '.config', 'Electron')
const CONFIG_PATH = join(USER_DATA, 'config.json')

// A saved windowState large and far off-origin enough to force the clamp on
// any monitor, whose center — (100, 100) — still falls inside the primary
// display: loadWindowState() discards (falls back to DEFAULT_STATE for) any
// saved state whose center lands outside every connected display, which
// would skip right past the saved-position clamp path this test targets.
const SEEDED_WINDOW_STATE = { x: -9900, y: -9900, width: 20000, height: 20000 }

test.describe.serial('window clamps to the display work area', { tag: '@virtual' }, () => {
  test.setTimeout(60_000)

  let app: ElectronApplication | null = null
  let configBackup: FileBackup

  test.beforeAll(() => {
    if (electronRunning()) {
      throw new Error('another electron instance is already running — aborting')
    }
    configBackup = backupFile(CONFIG_PATH)

    const cfg = readJson(CONFIG_PATH) ?? {}
    // A real saved position (not the -1/-1 "no saved position" sentinel)
    // with a size far larger than any display's work area — the exact
    // on-disk shape loadWindowState() would have persisted from a bigger
    // display, then restored unclamped on a smaller one.
    cfg.windowState = SEEDED_WINDOW_STATE
    // A previous suite's run may have left an auto-restorable session
    // behind, which would skip straight past the device selector this test
    // drives via connectToDevice() below.
    cfg.restoreLastSession = false
    delete cfg.lastDevice
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2))
  })

  test.afterAll(async () => {
    if (app) await quitApp(app).catch(() => {})
    restoreFile(configBackup)
  })

  test('requested bounds and minimum size fit inside the display work area', async () => {
    const launched = await launchApp({ env: { PIPETTE_VIRTUAL_DEVICE: 'only' } })
    app = launched.app
    const page = launched.page

    await dismissNotificationModal(page, { waitForAppearMs: 3_000 })

    const connected = await connectToDevice(page, VIRTUAL_DEVICE_DISPLAY_NAME)
    expect(connected).toBe(true)

    await page.locator('[data-testid="status-bar"]').waitFor({ state: 'visible', timeout: 15_000 })

    const geometry = await app.evaluate(({ screen, BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      const bounds = win.getBounds()
      const [minWidth, minHeight] = win.getMinimumSize()
      const display = screen.getDisplayMatching(bounds)
      return { bounds, minWidth, minHeight, workArea: display.workArea }
    })

    const { bounds, minWidth, minHeight, workArea } = geometry

    // The seeded windowState requested a 20000x20000 window — confirm the
    // fix actually shrank it, not merely that the oversized request
    // happened to fit by coincidence.
    expect(bounds.width).toBeLessThan(20000)
    expect(bounds.height).toBeLessThan(20000)

    // The window never requested a size or position spilling past the
    // work area's right/bottom edge...
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(workArea.x + workArea.width)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(workArea.y + workArea.height)
    // ...nor past its top/left edge.
    expect(bounds.x).toBeGreaterThanOrEqual(workArea.x)
    expect(bounds.y).toBeGreaterThanOrEqual(workArea.y)

    // The effective minimum size itself must also never exceed what the
    // display can actually show, or the OS-level resize floor alone would
    // reproduce the "can't drag the bottom edge back up" half of the bug.
    expect(minWidth).toBeLessThanOrEqual(workArea.width)
    expect(minHeight).toBeLessThanOrEqual(workArea.height)

    await page.screenshot({ path: test.info().outputPath('window-workarea-clamp.png'), fullPage: true })

    await quitApp(app)
    app = null
  })
})
