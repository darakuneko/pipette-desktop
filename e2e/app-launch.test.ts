// SPDX-License-Identifier: GPL-2.0-or-later

import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { launchApp } from './helpers/electron'
import { getTestDeviceButton, connectTestDevice } from './helpers/test-device'

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  const launched = await launchApp()
  app = launched.app
  page = launched.page
})

test.afterAll(async () => {
  await app?.close()
})

// --- Basic app launch ---

test('app starts and shows window', async () => {
  const windows = app.windows()
  expect(windows.length).toBeGreaterThanOrEqual(1)
})

test('window title is set', async () => {
  const title = await page.title()
  expect(title).toBeTruthy()
})

test('shows device selector on launch', async () => {
  await expect(page.locator('text=Pipette').first()).toBeVisible({ timeout: 10_000 })
})

test('shows select device prompt', async () => {
  await expect(page.locator('text=Select a device')).toBeVisible()
})

// --- Device discovery (node-hid, no permission dialog) ---

test('auto-discovers connected Vial devices on launch', async () => {
  // node-hid lists devices automatically without any browser permission dialog.
  // Wait for either state: device buttons rendered OR "no device" message shown.
  const deviceList = page.locator('[data-testid="device-list"]')
  const noDeviceMsg = page.locator('[data-testid="no-device-message"]')

  // Wait for either to appear (handles rendering delay)
  await Promise.race([
    deviceList.waitFor({ state: 'visible', timeout: 10_000 }),
    noDeviceMsg.waitFor({ state: 'visible', timeout: 10_000 }),
  ])

  const hasDevices = await deviceList.isVisible()
  const hasNoDeviceMsg = await noDeviceMsg.isVisible()
  expect(hasDevices || hasNoDeviceMsg).toBe(true)
})

test('device buttons show vendor:product ID', async () => {
  // Skip if no hardware is connected
  const deviceButtons = page.locator('[data-testid="device-button"]')
  const count = await deviceButtons.count()
  if (count === 0) {
    test.skip(true, 'No Vial device connected')
    return
  }

  // Each device button should display a hex vendor:product ID (e.g., "1234:5678")
  const idText = await deviceButtons.first().locator('[data-testid="device-id"]').textContent()
  expect(idText).toMatch(/[0-9a-f]{4}:[0-9a-f]{4}/)

  // Verify the designated test device is among discovered devices
  const testDeviceBtn = getTestDeviceButton(page)
  const testDeviceCount = await testDeviceBtn.count()
  if (testDeviceCount > 0) {
    const testDeviceId = await testDeviceBtn
      .first()
      .locator('[data-testid="device-id"]')
      .textContent()
    expect(testDeviceId).toMatch(/[0-9a-f]{4}:[0-9a-f]{4}/)
  }
})

// --- Device connection flow ---

test('clicking a device button connects and shows editor', async () => {
  // Connect to the designated test device (skips if not connected)
  await connectTestDevice(page)
})
