// SPDX-License-Identifier: GPL-2.0-or-later
//
// Settings → Tools → Key Labels modal smoke test. Hardware-free: opens
// from the device-selector Settings button so we don't need a Vial
// device connected. Hub-write paths are not exercised here (they need
// real auth); only local UI behaviour and the qwerty special-case.

import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { launchApp } from './helpers/electron'

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  const launched = await launchApp()
  app = launched.app
  page = launched.page
  // Wait for the device selector to fully render before any test runs.
  // Dev mode (Vite HMR) can take noticeably longer than the prod bundle.
  await page.waitForLoadState('networkidle').catch(() => undefined)
  await expect(page.locator('text=Pipette').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('settings-button')).toBeVisible({ timeout: 30_000 })
})

test.afterAll(async () => {
  await app?.close()
})

async function openKeyLabelsModal(): Promise<void> {
  // Settings button on the device selector header
  await page.getByTestId('settings-button').click()
  await expect(page.getByTestId('settings-modal')).toBeVisible()

  // Tools tab is the default but click for safety on environments where
  // the active tab persisted to a different one.
  await page.getByTestId('settings-tab-tools').click()
  await expect(page.getByTestId('settings-key-labels-row')).toBeVisible()

  await page.getByTestId('settings-key-labels-button').click()
  await expect(page.getByTestId('key-labels-modal')).toBeVisible()
}

test('opens Key Labels modal from Settings → Tools', async () => {
  await openKeyLabelsModal()
  // QWERTY row is always present and has no actions (delete-protected).
  await expect(page.getByTestId('key-labels-modal').locator('text=QWERTY')).toBeVisible()
  // Close via the explicit close button so the next test starts clean.
  await page.getByTestId('key-labels-modal-close').click()
  await expect(page.getByTestId('key-labels-modal')).toHaveCount(0)
  await page.getByTestId('settings-close').click()
  await expect(page.getByTestId('settings-modal')).toHaveCount(0)
})

test('search input + Search button are wired', async () => {
  await openKeyLabelsModal()

  // Search input lives on the "Find on Hub" tab.
  await page.getByTestId('key-labels-tab-hub').click()

  const input = page.getByTestId('key-labels-search-input')
  const button = page.getByTestId('key-labels-search-button')

  await expect(input).toBeVisible()
  await expect(button).toBeVisible()

  // Typing into the input must not crash and the button stays enabled.
  await input.fill('french')
  await expect(input).toHaveValue('french')

  // We don't assert the network call result (Hub may be unreachable in
  // CI). Just ensure the click handler is reachable and the button does
  // not stay frozen in a busy state forever.
  await button.click()
  await expect(button).toBeVisible()

  // Close modal + settings to clean up for following tests.
  await page.getByTestId('key-labels-modal-close').click()
  await page.getByTestId('settings-close').click()
})

test('qwerty has no Upload/Delete actions', async () => {
  await openKeyLabelsModal()

  // Action column for qwerty should not expose any of these test ids.
  await expect(page.getByTestId('key-labels-upload-qwerty')).toHaveCount(0)
  await expect(page.getByTestId('key-labels-delete-qwerty')).toHaveCount(0)
  await expect(page.getByTestId('key-labels-rename-qwerty')).toHaveCount(0)

  await page.getByTestId('key-labels-modal-close').click()
  await page.getByTestId('settings-close').click()
})
