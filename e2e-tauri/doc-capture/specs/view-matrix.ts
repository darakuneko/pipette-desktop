// SPDX-License-Identifier: GPL-2.0-or-later
//
// The View Matrix screenshots. Scene A connects the virtual keyboard and
// captures the Wires overlay, the mode's two-pane layout, a selected key,
// and the duplicate-position highlight. Scene B, after a fresh launch,
// loads a direct-pin dummy definition (fixtures/e2e_direct_pin.json, a
// degenerate 1x6 matrix) to show both Row/Col selects offering the widened
// 0..5 range.
//
//   pnpm doc:screenshots --spec e2e-tauri/doc-capture/specs/view-matrix.ts

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clickIntoFileDialog, VIRTUAL_DEVICE_NAME } from '../../helpers/app'
import {
  captureNamed,
  closeKeycodesOverlay,
  connectToDevice,
  dismissNotificationModal,
  openOverlayTab,
  outputDirectory,
  overlayTabNotFoundMessage,
  prepareCapture,
  relaunchApp,
  resetToEditorMode,
  waitForUnlockDialog,
} from '../common'
import { Page } from '../page'

const DIRECT_PIN_FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures/e2e_direct_pin.json')

/** Open the Keycodes Overlay Panel and click the View Matrix row's Edit
 *  button, then wait for the mode's left pane to mount. Entering the mode
 *  unmounts the whole keycode picker (overlay included), so there is no
 *  panel to close afterwards. The View Matrix row lives on the Tools tab;
 *  openOverlayTab already handles the case where Tools is the panel's only
 *  tab (tab bar absent, content already active). */
async function enterViewMatrixMode(page: Page): Promise<void> {
  if (!(await openOverlayTab(page, 'tools'))) {
    throw new Error(overlayTabNotFoundMessage('tools'))
  }
  await page.locator('[data-testid="overlay-view-matrix-edit-button"]').click()
  await page.locator('[data-testid="view-matrix-reset-panel"]').waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(500)
}

/** Open the Tools tab and set the View Matrix Wires toggle to `on`,
 *  idempotently (reads `aria-checked` first so a call that finds it already
 *  in the target state is a no-op click-wise). Closes the overlay panel
 *  again before returning — it opened it, so callers don't need their own
 *  `closeKeycodesOverlay` afterwards. */
async function setViewMatrixWires(page: Page, on: boolean): Promise<void> {
  if (!(await openOverlayTab(page, 'tools'))) {
    throw new Error(overlayTabNotFoundMessage('tools'))
  }
  const toggle = page.locator('[data-testid="overlay-view-matrix-wires-toggle"]')
  const checked = (await toggle.getAttribute('aria-checked')) === 'true'
  if (checked !== on) {
    await toggle.click()
    await page.waitForTimeout(300)
  }
  await closeKeycodesOverlay(page)
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

async function captureVirtualDeviceScene(page: Page): Promise<void> {
  console.log('\n=== Scene A: View Matrix on the virtual device ===')

  console.log(`Looking for ${VIRTUAL_DEVICE_NAME}...`)
  const connected = await connectToDevice(page, VIRTUAL_DEVICE_NAME)
  if (!connected) throw new Error(`Device "${VIRTUAL_DEVICE_NAME}" not found`)

  await dismissNotificationModal(page)
  await waitForUnlockDialog(page)
  await resetToEditorMode(page)

  // Wires overlay — captured during normal editing (Wires stays in effect
  // through View Matrix Edit mode too, but this shot is meant to show it
  // over an ordinary keymap, not the Edit mode's R/C legends). Close the
  // overlay panel first so it doesn't obstruct the keymap in the shot,
  // then turn the toggle back off before entering Edit mode below — the
  // view-matrix-mode/selected/duplicate shots are taken without the
  // overlay.
  await setViewMatrixWires(page, true)
  await captureNamed(page, 'view-matrix-wires')
  await setViewMatrixWires(page, false)

  await enterViewMatrixMode(page)
  // Two-pane overview: R/C key legends, panel with blank Row/Col selects,
  // hint + zoom row under the keymap.
  await captureNamed(page, 'view-matrix-mode')

  // Select one key — the Row/Col selects populate with its effective
  // position (physical 1,1 — no override yet).
  await clickKey(page, 1, 1)
  await captureNamed(page, 'view-matrix-selected')

  // Collide: move the selected key's Row to 0 so its effective position
  // (0,1) matches physical key (0,1) — both get the duplicate fill. Then
  // deselect (background click) so the selection highlight doesn't cover
  // one of the two warning-colored keys in the shot.
  await page.locator('[data-testid="view-matrix-row-select"]').selectOption('0')
  await page.waitForTimeout(500)
  await page.locator('[data-testid="primary-pane"]').click({ position: { x: 10, y: 10 } })
  await page.waitForTimeout(400)
  await captureNamed(page, 'view-matrix-duplicate')

  // Reset (2-step confirm) clears the override just written.
  await page.locator('[data-testid="view-matrix-reset-button"]').click()
  await page.locator('[data-testid="view-matrix-reset-confirm-button"]').click()
  await page.waitForTimeout(500)

  // Exit the mode so the app quits from the normal editor state.
  await page.locator('[data-testid="view-matrix-mode-toggle"]').click()
  await page.waitForTimeout(500)
}

// --- Scene B: direct-pin dummy definition --------------------------------

async function captureDirectPinScene(page: Page): Promise<void> {
  console.log('\n=== Scene B: View Matrix on a direct-pin keyboard (dummy) ===')

  // The dummy button opens a file dialog; the development tools answer it
  // with the fixture.
  const dummyBtn = page.locator('[data-testid="dummy-button"]')
  await dummyBtn.waitFor({ state: 'visible', timeout: 10_000 })
  await clickIntoFileDialog('[data-testid="dummy-button"]', DIRECT_PIN_FIXTURE)

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
  await captureNamed(page, 'view-matrix-direct-pin')
}

describe('View Matrix screenshots', () => {
  it('captures View Matrix on the virtual keyboard and on a direct-pin definition', async () => {
    const page = new Page()
    await prepareCapture(page)
    await captureVirtualDeviceScene(page)

    // Scene B starts from a fresh launch on the device-selection screen.
    await relaunchApp()
    await prepareCapture(page)
    await captureDirectPinScene(page)

    console.log(`\nScreenshots saved to: ${outputDirectory()}`)
  })
})
