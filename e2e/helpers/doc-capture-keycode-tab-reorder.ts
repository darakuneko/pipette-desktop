// SPDX-License-Identifier: GPL-2.0-or-later
//
// Capture for the keycode palette's tab reorder mode — `keycode-tab-reorder.png`
// (operation guide §3.15). Long-presses the Macro tab on the virtual device
// and captures the palette in reorder mode — Macro selected, its tiles
// shown — in the default tab order.
//
// Usage: pnpm build && npx tsx e2e/helpers/doc-capture-keycode-tab-reorder.ts
//
// The virtual device's PipetteSettings file is backed up first and restored
// after the app closes; a saved `keycodeTabOrder` is removed for the run so
// the capture always shows the default order. Captures go through
// `webContents.capturePage()` for the same reason as
// doc-capture-overlay-tools.ts.

import type { ElectronApplication } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  backupVirtualDeviceSettings,
  connectToDevice,
  dismissNotificationModal,
  launchCaptureApp,
  restoreVirtualDeviceSettings,
  resetVirtualDeviceKeyboardLayout,
  VIRTUAL_DEVICE_DISPLAY_NAME,
  VIRTUAL_DEVICE_UID,
  type VirtualDeviceSettingsBackup,
} from './doc-capture-common'

const PROJECT_ROOT = resolve(import.meta.dirname, '../..')
const SCREENSHOT_DIR = resolve(PROJECT_ROOT, 'docs/screenshots')

/** Same viewport `doc-capture-overlay-tools.ts` captures at. */
const VIEWPORT = { width: 1440, height: 1024 }

/** Longer than the 500 ms long-press threshold (`use-keycode-tab-reorder.ts`). */
const LONG_PRESS_HOLD_MS = 800

async function capture(app: ElectronApplication, name: string): Promise<void> {
  const dataUrl = await app.evaluate(async ({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0]
    const img = await win.webContents.capturePage()
    return img.resize({ ...size, quality: 'best' }).toDataURL()
  }, VIEWPORT)
  const path = resolve(SCREENSHOT_DIR, `${name}.png`)
  writeFileSync(path, Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'))
  console.log(`Saved: ${path}`)
}

function clearSavedTabOrder(userDataPath: string): void {
  const path = join(userDataPath, 'sync', 'keyboards', VIRTUAL_DEVICE_UID, 'pipette_settings.json')
  if (!existsSync(path)) return
  const settings = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
  if (settings.keycodeTabOrder === undefined) return
  delete settings.keycodeTabOrder
  writeFileSync(path, JSON.stringify(settings, null, 2), 'utf-8')
}

async function main(): Promise<void> {
  mkdirSync(SCREENSHOT_DIR, { recursive: true })

  console.log('Launching Electron app (virtual device)...')
  const app = await launchCaptureApp()
  let backup: VirtualDeviceSettingsBackup | null = null

  try {
    const userDataPath = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
    backup = backupVirtualDeviceSettings(userDataPath)
    resetVirtualDeviceKeyboardLayout(userDataPath)
    clearSavedTabOrder(userDataPath)

    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.setViewportSize(VIEWPORT)
    await page.waitForTimeout(3000)
    await dismissNotificationModal(page, { waitForAppearMs: 3000 })

    if (!(await connectToDevice(page, VIRTUAL_DEVICE_DISPLAY_NAME))) {
      console.log('Failed to connect to device')
      return
    }
    await dismissNotificationModal(page)

    const tab = page.locator('[data-testid="tabbed-keycodes-root"] [data-keycode-tab="macro"]').first()
    const box = await tab.boundingBox()
    if (!box) {
      console.log('  [skip] Macro tab not found')
      return
    }
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.waitForTimeout(LONG_PRESS_HOLD_MS)
    await page.mouse.up()
    // Park the pointer in the empty top-left corner so no hover style or
    // tooltip shows in the capture.
    await page.mouse.move(2, 2)

    const done = page.locator('[data-testid="keycode-tab-reorder-done"]')
    await done.waitFor({ state: 'visible', timeout: 5000 })
    await capture(app, 'keycode-tab-reorder')
    await done.click()
  } finally {
    await app.close().catch((err: unknown) => console.error('  [cleanup] app.close failed:', err))
    if (backup) restoreVirtualDeviceSettings(backup)
  }
}

main().catch((err: unknown) => {
  console.error('Script failed:', err)
  process.exit(1)
})
