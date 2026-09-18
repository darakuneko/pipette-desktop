// SPDX-License-Identifier: GPL-2.0-or-later

// Screenshot capture script for the QMK settings modal documentation.
// Connects to the virtual "Virtual Keyboard" device (PIPETTE_VIRTUAL_DEVICE=only),
// opens the Tap-Hold Settings modal, saves an edited field, and captures the
// modal while its "Saved" confirmation is showing. No real hardware required.
//
// Usage: pnpm build && npx tsx e2e/helpers/doc-capture-qmk-settings.ts

import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  backupVirtualDeviceSettings,
  connectToDevice,
  dismissNotificationModal,
  isAvailable,
  launchCaptureApp,
  resetToEditorMode,
  restoreVirtualDeviceSettings,
  VIRTUAL_DEVICE_DISPLAY_NAME,
  waitForUnlockDialog,
} from './doc-capture-common'

const PROJECT_ROOT = resolve(import.meta.dirname, '../..')
const SCREENSHOT_DIR = resolve(PROJECT_ROOT, 'docs/screenshots')
const DEVICE_NAME = VIRTUAL_DEVICE_DISPLAY_NAME

async function capture(page: Page, name: string): Promise<void> {
  const path = resolve(SCREENSHOT_DIR, `${name}.png`)
  await page.screenshot({ path, fullPage: true })
  console.log(`  [ok] ${name}.png`)
}

async function main(): Promise<void> {
  mkdirSync(SCREENSHOT_DIR, { recursive: true })

  console.log('Launching Electron app (virtual device)...')
  const app = await launchCaptureApp()

  // The virtual device's QMK settings live only in the main process's
  // in-memory emulator state (src/main/virtual-device/qmk-settings.ts) —
  // nothing is flushed to disk, and every Electron launch starts from the
  // firmware defaults again. So the Tapping Term edit this script saves
  // does not need to be reverted. The one on-disk file a capture run can
  // still leak into later runs is PipetteSettings' `viewMode` (see the
  // other doc-capture-*.ts helpers), so back that up/restore it the same
  // way for consistency even though this script never changes it itself.
  const userDataPath = await app.evaluate(async ({ app: a }) => a.getPath('userData'))
  const settingsBackup = backupVirtualDeviceSettings(userDataPath)

  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.setViewportSize({ width: 1440, height: 1024 })
  await page.waitForTimeout(3000)

  try {
    await dismissNotificationModal(page, { waitForAppearMs: 3000 })

    console.log(`Looking for ${DEVICE_NAME}...`)
    const connected = await connectToDevice(page, DEVICE_NAME)
    if (!connected) throw new Error(`Device "${DEVICE_NAME}" not found`)
    console.log(`Connected to ${DEVICE_NAME}`)

    await dismissNotificationModal(page)
    await waitForUnlockDialog(app, page)
    await dismissNotificationModal(page)
    await resetToEditorMode(page)

    console.log('\n--- QMK Settings Screenshots ---')

    const editorContent = page.locator('[data-testid="editor-content"]')

    // Switch to the Tap-Hold / Tap Dance keycode tab, where the Tap-Hold
    // Settings shortcut button lives next to Edit JSON.
    const tdTabBtn = editorContent.locator('button', { hasText: /^Tap-Hold \/ Tap Dance$/ })
    await tdTabBtn.first().waitFor({ state: 'visible', timeout: 10_000 })
    await tdTabBtn.first().click()
    await page.waitForTimeout(300)

    const tapHoldBtn = page.locator('[data-testid="tap-hold-settings-btn"]')
    if (!(await isAvailable(tapHoldBtn))) {
      throw new Error('tap-hold-settings-btn not found — the virtual device may not report a supported Tap-Hold qsid')
    }
    await tapHoldBtn.click()

    const modal = page.locator('[data-testid="tap-hold-settings-backdrop"]')
    await modal.waitFor({ state: 'visible', timeout: 10_000 })
    await page.waitForTimeout(500)

    // Edit the first number field (Tapping Term, qsid 7 — within the
    // virtual device's supported qsid range of 1-7,9-27) so Save has
    // something to write.
    const numberInput = modal.locator('input[type="number"]').first()
    await numberInput.waitFor({ state: 'visible', timeout: 10_000 })
    const currentValue = await numberInput.inputValue()
    const nextValue = String((parseInt(currentValue, 10) || 0) + 10)
    await numberInput.fill(nextValue)
    await page.waitForTimeout(200)

    const saveBtn = page.locator('[data-testid="qmk-save"]')
    await saveBtn.click()

    const saveStatus = page.locator('[data-testid="qmk-save-status"]')
    await saveStatus.waitFor({ state: 'visible', timeout: 10_000 })
    // "Saved" flashes for ~2s before fading back to idle — poll for the
    // text instead of a fixed wait so a slow HID round trip doesn't miss
    // the window entirely.
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if ((await saveStatus.textContent())?.includes('Saved')) break
      await page.waitForTimeout(100)
    }

    await capture(page, 'tap-hold-settings')

    console.log(`\nScreenshots saved to: ${SCREENSHOT_DIR}`)
  } finally {
    // Close the app first so no further debounced save can race with (and
    // undo) the settings restore below.
    await app.close().catch((err: unknown) => console.error('  [cleanup] app.close failed:', err))
    try {
      restoreVirtualDeviceSettings(settingsBackup)
    } catch (err) {
      console.error('  [cleanup] restore virtual device settings failed:', err)
    }
  }
}

main().catch((err: unknown) => {
  console.error('Script failed:', err)
  process.exit(1)
})
