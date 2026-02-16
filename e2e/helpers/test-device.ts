// SPDX-License-Identifier: GPL-2.0-or-later

import type { Locator, Page } from '@playwright/test'
import { test, expect } from '@playwright/test'
import { TEST_DEVICE } from '../test-device.config'

/** Max attempts to detect the test device before skipping. */
const DEVICE_DETECT_RETRIES = 3

/** Delay (ms) between retries, allowing auto-detect polling to re-scan HID. */
const DETECT_RETRY_INTERVAL_MS = 3_000

/** Timeout (ms) for the device list or no-device message to appear. */
const DEVICE_LIST_TIMEOUT_MS = 10_000

/** Timeout (ms) for the editor UI to appear after connecting. */
const CONNECT_TIMEOUT_MS = 15_000

/**
 * Return the device button matching the configured test device productName.
 * Uses exact match on the product name element to avoid substring collisions
 * (e.g. "Alpha" vs "Alpha Pro").
 */
export function getTestDeviceButton(page: Page): Locator {
  const escaped = TEST_DEVICE.productName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return page
    .locator('[data-testid="device-button"]')
    .filter({ has: page.locator('.font-semibold', { hasText: new RegExp(`^${escaped}$`) }) })
}

/**
 * Wait for the device list to render and check if the test device is present.
 * Retries up to {@link DEVICE_DETECT_RETRIES} times to handle HID release
 * delay when a previous test suite held the device.
 * Skips the current test if the device is not connected.
 */
export async function skipIfNoTestDevice(page: Page): Promise<boolean> {
  const deviceList = page.locator('[data-testid="device-list"]')
  const noDeviceMsg = page.locator('[data-testid="no-device-message"]')

  for (let attempt = 0; attempt < DEVICE_DETECT_RETRIES; attempt++) {
    await Promise.race([
      deviceList.waitFor({ state: 'visible', timeout: DEVICE_LIST_TIMEOUT_MS }),
      noDeviceMsg.waitFor({ state: 'visible', timeout: DEVICE_LIST_TIMEOUT_MS }),
    ])

    const btn = getTestDeviceButton(page)
    const count = await btn.count()
    if (count > 0) {
      expect(count).toBe(1)
      return true
    }

    // Wait for auto-detect polling to re-scan (skip on last attempt)
    if (attempt < DEVICE_DETECT_RETRIES - 1) {
      await page.waitForTimeout(DETECT_RETRY_INTERVAL_MS)
    }
  }

  test.skip(true, `Test device "${TEST_DEVICE.productName}" not connected`)
  return false
}

/**
 * Click the test device button and wait for the editor to load.
 * Skips the test if the device is not connected.
 */
export async function connectTestDevice(page: Page): Promise<void> {
  const available = await skipIfNoTestDevice(page)
  if (!available) return

  const btn = getTestDeviceButton(page)
  await btn.click()

  await expect(page.locator('[data-testid="status-bar"]')).toBeVisible({
    timeout: CONNECT_TIMEOUT_MS,
  })

  // Wait for keyboard reload to populate the protocol version.
  // vialProtocol starts at -1 and becomes non-negative after getKeyboardId().
  await expect(page.locator('[data-testid="status-vial-protocol"]')).toHaveText(
    /Vial v\d+/,
    { timeout: CONNECT_TIMEOUT_MS },
  )
}
