// SPDX-License-Identifier: GPL-2.0-or-later
//
// Drives the software-emulated Virtual Keyboard device (a GPK60-63R
// emulator, no real hardware required). Does NOT use connectTestDevice() —
// that helper targets the physical GPK60-63R test device, a different
// vid/pid from the virtual one.
//
// `app.evaluate()` callbacks run inside Electron's main process and must be
// self-contained (no closures over outer test-file variables) since
// Playwright serializes the function body across the IPC boundary.

import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { launchApp } from './helpers/electron'
import { dismissNotificationModal, escapeRegex, VIRTUAL_DEVICE_DISPLAY_NAME } from './helpers/doc-capture-common'
import type { VirtualDeviceController } from './helpers/doc-capture-common'

const VIRTUAL_DEVICE_NAME = VIRTUAL_DEVICE_DISPLAY_NAME
const CONNECT_TIMEOUT_MS = 15_000
const UNLOCK_TIMEOUT_MS = 10_000

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  const launched = await launchApp({ env: { PIPETTE_VIRTUAL_DEVICE: '1' } })
  app = launched.app
  page = launched.page
  await dismissNotificationModal(page, { waitForAppearMs: 3_000 })
})

test.afterAll(async () => {
  await app?.close()
})

test('virtual device appears in the device list and connects to the editor', async () => {
  // Anchored exact match (same form as connectToDevice) — a plain string
  // hasText is substring matching and could hit a device whose name merely
  // contains VIRTUAL_DEVICE_NAME.
  const deviceButton = page
    .locator('[data-testid="device-button"]')
    .filter({ has: page.locator('.font-semibold', { hasText: new RegExp(`^${escapeRegex(VIRTUAL_DEVICE_NAME)}$`) }) })

  await expect(deviceButton).toBeVisible({ timeout: CONNECT_TIMEOUT_MS })
  await deviceButton.click()

  await expect(page.locator('[data-testid="editor-content"]')).toBeVisible({ timeout: CONNECT_TIMEOUT_MS })

  // Powered-on-but-locked, like a real Vial keyboard: no unlock prompt yet.
  await expect(page.locator('text=Unlock Keyboard')).not.toBeVisible()
})

test('enabling the matrix tester while locked prompts the unlock dialog, which clears after the combo is held', async () => {
  const settingsButton = page.locator('[aria-controls="keycodes-overlay-panel"]')
  await settingsButton.click()

  const toolsTab = page.locator('[data-testid="overlay-tab-tools"]')
  await toolsTab.click()

  // Shorten the unlock countdown BEFORE the dialog's unlockStart() fires, so
  // the sequence completes in a few 200ms polls instead of the firmware's
  // default 50 (~10s of continuous holding).
  await app.evaluate(() => {
    const controller = (globalThis as unknown as { __pipetteVirtualDevice: VirtualDeviceController }).__pipetteVirtualDevice
    controller.setUnlockCounterMax(3)
  })

  const matrixToggle = page.locator('[data-testid="overlay-matrix-toggle"]')
  await matrixToggle.click()

  const unlockDialog = page.locator('text=Unlock Keyboard')
  await expect(unlockDialog).toBeVisible({ timeout: UNLOCK_TIMEOUT_MS })

  await app.evaluate(() => {
    const controller = (globalThis as unknown as { __pipetteVirtualDevice: VirtualDeviceController }).__pipetteVirtualDevice
    controller.holdKeys([[0, 0], [0, 1]])
  })

  await expect(unlockDialog).not.toBeVisible({ timeout: UNLOCK_TIMEOUT_MS })

  await app.evaluate(() => {
    const controller = (globalThis as unknown as { __pipetteVirtualDevice: VirtualDeviceController }).__pipetteVirtualDevice
    controller.releaseAll()
  })
})

test('pressing a key through the controller reflects in the matrix tester UI', async () => {
  await app.evaluate(() => {
    const controller = (globalThis as unknown as { __pipetteVirtualDevice: VirtualDeviceController }).__pipetteVirtualDevice
    controller.pressKey(2, 3)
  })

  const pressedKey = page.locator('[data-key-pos="2,3"]').first()
  await expect(pressedKey).toHaveAttribute('data-pressed', 'true', { timeout: 5_000 })

  await app.evaluate(() => {
    const controller = (globalThis as unknown as { __pipetteVirtualDevice: VirtualDeviceController }).__pipetteVirtualDevice
    controller.releaseKey(2, 3)
  })

  await expect(pressedKey).not.toHaveAttribute('data-pressed', 'true', { timeout: 5_000 })
})
