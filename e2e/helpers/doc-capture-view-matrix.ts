// SPDX-License-Identifier: GPL-2.0-or-later

// Screenshot capture script for View Matrix documentation (§2.6).
//
// Scene A connects to the virtual "Virtual Keyboard" device
// (PIPETTE_VIRTUAL_DEVICE=only, no real hardware required) and captures the
// mode's two-pane layout, a selected key, and the duplicate-position
// highlight. Scene B loads a direct-pin dummy definition
// (e2e_direct_pin.json, degenerate 1x6 matrix) to show both Row/Col selects
// offering the widened 0..5 range.
//
// Usage: pnpm build && npx tsx e2e/helpers/doc-capture-view-matrix.ts

import type { ElectronApplication, Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  backupVirtualDeviceSettings,
  connectToDevice,
  dismissNotificationModal,
  launchCaptureApp,
  resetToEditorMode,
  restoreVirtualDeviceSettings,
  VIRTUAL_DEVICE_DISPLAY_NAME,
  waitForUnlockDialog,
} from './doc-capture-common'

const PROJECT_ROOT = resolve(import.meta.dirname, '../..')
const SCREENSHOT_DIR = resolve(PROJECT_ROOT, 'docs/screenshots')
const DIRECT_PIN_FIXTURE = resolve(PROJECT_ROOT, 'e2e/fixtures/e2e_direct_pin.json')

async function capture(page: Page, name: string): Promise<void> {
  const path = resolve(SCREENSHOT_DIR, `${name}.png`)
  await page.screenshot({ path, fullPage: true })
  console.log(`  [ok] ${name}.png`)
}

/** Route the next native open-file dialog to the direct-pin fixture, so the
 *  dummy-button flow loads it without a real dialog (same interception the
 *  layout-options helper uses). */
async function interceptFileDialog(app: ElectronApplication): Promise<void> {
  await app.evaluate(
    async ({ dialog }, fixturePath) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [fixturePath],
      })
    },
    DIRECT_PIN_FIXTURE,
  )
}

async function ensureOverlayOpen(page: Page): Promise<void> {
  const toggle = page.locator('button[aria-controls="keycodes-overlay-panel"]')
  const isExpanded = await toggle.getAttribute('aria-expanded')
  if (isExpanded !== 'true') {
    await toggle.click()
    await page.waitForTimeout(500)
  }
}

/** Open the Keycodes Overlay Panel and click the View Matrix row's Edit
 *  button, then wait for the mode's left pane to mount. Entering the mode
 *  unmounts the whole keycode picker (overlay included), so there is no
 *  panel to close afterwards. */
async function enterViewMatrixMode(page: Page): Promise<void> {
  await ensureOverlayOpen(page)
  // The View Matrix row lives on the Tools tab; the panel may open on the
  // Layout/Save tab instead when the keyboard has those (tab bar is absent
  // when Tools is the only tab).
  const toolsTab = page.locator('[data-testid="overlay-tab-tools"]')
  if ((await toolsTab.count()) > 0) {
    await toolsTab.click()
    await page.waitForTimeout(300)
  }
  await page.locator('[data-testid="overlay-view-matrix-edit-button"]').click()
  await page.locator('[data-testid="view-matrix-reset-panel"]').waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(500)
}

/** Click the keymap key at physical matrix position "row,col" — in View
 *  Matrix mode this selects it for the panel's Row/Col selects. Scoped to
 *  the editor content; the keycode picker (which also renders data-key-pos
 *  keys in normal mode) is unmounted while the mode is active. */
async function clickKey(page: Page, row: number, col: number): Promise<void> {
  await page.locator(`[data-testid="editor-content"] g[data-key-pos="${row},${col}"]`).first().click()
  await page.waitForTimeout(400)
}

// --- Scene A: virtual device --------------------------------------------

async function captureVirtualDeviceScene(): Promise<void> {
  console.log('\n=== Scene A: View Matrix on the virtual device ===')
  const app = await launchCaptureApp()

  // The panel's Row/Col edits persist into the virtual device's
  // pipette_settings.json (viewMatrix via PipetteSettings). The in-scene
  // Reset already clears them, but snapshot/restore the file anyway so an
  // aborted run can't leak overrides into later helper/test runs.
  const userDataPath = await app.evaluate(async ({ app: a }) => a.getPath('userData'))
  const settingsBackup = backupVirtualDeviceSettings(userDataPath)

  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.setViewportSize({ width: 1320, height: 960 })
  await page.waitForTimeout(3000)

  try {
    await dismissNotificationModal(page, { waitForAppearMs: 3000 })

    console.log(`Looking for ${VIRTUAL_DEVICE_DISPLAY_NAME}...`)
    const connected = await connectToDevice(page, VIRTUAL_DEVICE_DISPLAY_NAME)
    if (!connected) throw new Error(`Device "${VIRTUAL_DEVICE_DISPLAY_NAME}" not found`)

    await dismissNotificationModal(page)
    await waitForUnlockDialog(app, page)
    await resetToEditorMode(page)

    await enterViewMatrixMode(page)
    // Two-pane overview: R/C key legends, panel with blank Row/Col selects,
    // hint + zoom row under the keymap.
    await capture(page, 'view-matrix-mode')

    // Select one key — the Row/Col selects populate with its effective
    // position (physical 1,1 — no override yet).
    await clickKey(page, 1, 1)
    await capture(page, 'view-matrix-selected')

    // Collide: move the selected key's Row to 0 so its effective position
    // (0,1) matches physical key (0,1) — both get the duplicate fill. Then
    // deselect (background click) so the selection highlight doesn't cover
    // one of the two warning-colored keys in the shot.
    await page.locator('[data-testid="view-matrix-row-select"]').selectOption('0')
    await page.waitForTimeout(500)
    await page.locator('[data-testid="primary-pane"]').click({ position: { x: 10, y: 10 } })
    await page.waitForTimeout(400)
    await capture(page, 'view-matrix-duplicate')

    // Reset (2-step confirm) clears the override just written, leaving the
    // persisted prefs clean for whoever runs against this userData next.
    await page.locator('[data-testid="view-matrix-reset-button"]').click()
    await page.locator('[data-testid="view-matrix-reset-confirm-button"]').click()
    await page.waitForTimeout(500)

    // Exit the mode so the app closes from the normal editor state.
    await page.locator('[data-testid="view-matrix-mode-toggle"]').click()
    await page.waitForTimeout(500)
  } finally {
    // Close first so no debounced settings save can race the restore.
    await app.close().catch((err: unknown) => console.error('  [cleanup] app.close failed:', err))
    try {
      restoreVirtualDeviceSettings(settingsBackup)
    } catch (err) {
      console.error('  [cleanup] restore virtual device settings failed:', err)
    }
  }
}

// --- Scene B: direct-pin dummy definition --------------------------------

async function captureDirectPinScene(): Promise<void> {
  console.log('\n=== Scene B: View Matrix on a direct-pin keyboard (dummy) ===')
  const app = await launchCaptureApp()

  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.setViewportSize({ width: 1320, height: 960 })
  await page.waitForTimeout(3000)

  try {
    await dismissNotificationModal(page, { waitForAppearMs: 3000 })
    await interceptFileDialog(app)

    const dummyBtn = page.locator('[data-testid="dummy-button"]')
    await dummyBtn.waitFor({ state: 'visible', timeout: 10_000 })
    await dummyBtn.click()

    await page.locator('[data-testid="editor-content"]').waitFor({ state: 'visible', timeout: 20_000 })
    await page.waitForTimeout(2000)
    await dismissNotificationModal(page)

    await enterViewMatrixMode(page)

    // Select the last key (physical 0,5 on the 1x6 matrix) and move its Row
    // to 5: both selects span 0..5 (max of rows/cols), so the shot shows
    // Row 5 / Col 5 despite the single-row physical matrix. The dummy flow
    // never calls applyDevicePrefs (no uid), so nothing persists to disk.
    await clickKey(page, 0, 5)
    await page.locator('[data-testid="view-matrix-row-select"]').selectOption('5')
    await page.waitForTimeout(500)
    await capture(page, 'view-matrix-direct-pin')
  } finally {
    await app.close().catch((err: unknown) => console.error('  [cleanup] app.close failed:', err))
  }
}

async function main(): Promise<void> {
  mkdirSync(SCREENSHOT_DIR, { recursive: true })
  await captureVirtualDeviceScene()
  await captureDirectPinScene()
  console.log(`\nScreenshots saved to: ${SCREENSHOT_DIR}`)
}

main().catch((err: unknown) => {
  console.error('Script failed:', err)
  process.exit(1)
})
