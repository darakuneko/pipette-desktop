// SPDX-License-Identifier: GPL-2.0-or-later

import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { launchApp } from './helpers/electron'
import { connectTestDevice } from './helpers/test-device'

let app: ElectronApplication
let page: Page
let connected = false

test.beforeAll(async () => {
  const launched = await launchApp()
  app = launched.app
  page = launched.page

  try {
    await connectTestDevice(page)
    connected = true
  } catch {
    // Test device unavailable — tests skip via beforeEach guard
  }
})

test.beforeEach(async () => {
  if (!connected) {
    test.skip(true, 'Test device not connected — skipping tooltip tests')
  }
})

test.afterAll(async () => {
  await app?.close()
})

test.describe('Tooltip display', () => {
  test('layer panel toggle shows tooltip on hover (opacity transitions to 1)', async () => {
    const btn = page.locator('[data-testid="layer-panel-collapse-btn"], [data-testid="layer-panel-expand-btn"]').first()
    await expect(btn).toBeVisible()

    const describedBy = await btn.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()

    const tooltip = page.locator(`#${describedBy}`)
    await expect(tooltip).toHaveAttribute('role', 'tooltip')

    await btn.hover()

    await expect.poll(
      async () => tooltip.evaluate((el) => parseFloat(getComputedStyle(el).opacity)),
      { message: 'tooltip opacity should reach 1 after hover', timeout: 2000 },
    ).toBe(1)
  })

  test('layer panel toggle shows tooltip on focus (opacity transitions to 1)', async () => {
    const btn = page.locator('[data-testid="layer-panel-collapse-btn"], [data-testid="layer-panel-expand-btn"]').first()
    await expect(btn).toBeVisible()

    const describedBy = await btn.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()

    const tooltip = page.locator(`#${describedBy}`)

    await btn.focus()

    await expect.poll(
      async () => tooltip.evaluate((el) => parseFloat(getComputedStyle(el).opacity)),
      { message: 'tooltip opacity should reach 1 after focus', timeout: 2000 },
    ).toBe(1)

    // Clean up: move focus elsewhere to prevent tooltip persisting across tests.
    await page.locator('body').click({ position: { x: 0, y: 0 }, force: true })
  })

  test('undo button (Tooltip from Task-02) exposes role="tooltip" via aria-describedby', async () => {
    const undoBtn = page.locator('[data-testid="undo-button"]').first()
    await expect(undoBtn).toBeVisible()

    const describedBy = await undoBtn.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()

    const tooltip = page.locator(`#${describedBy}`)
    await expect(tooltip).toHaveAttribute('role', 'tooltip')
  })
})
