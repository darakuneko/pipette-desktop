// SPDX-License-Identifier: GPL-2.0-or-later

// Screenshot capture script for Hub workflow documentation.
// Launches app directly (not via Playwright electron.launch) to preserve safeStorage/keyring,
// then connects Playwright via remote debugging to capture screenshots.
// Usage: pnpm build && npx tsx e2e/helpers/doc-capture-hub.ts
import { chromium } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const PROJECT_ROOT = resolve(import.meta.dirname, '../..')
const SCREENSHOT_DIR = resolve(PROJECT_ROOT, 'docs/screenshots')
const DEVICE_NAME = 'GPK60-63R'
const DEBUG_PORT = 19222

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&')
}

async function isAvailable(locator: Locator): Promise<boolean> {
  return (await locator.count()) > 0
}

async function dismissOverlay(page: Page, backdropId: string, closeId: string, fallback: () => Promise<void>): Promise<void> {
  const backdrop = page.locator(`[data-testid="${backdropId}"]`)
  if (!(await backdrop.isVisible())) return

  const closeBtn = page.locator(`[data-testid="${closeId}"]`)
  if (await isAvailable(closeBtn)) {
    await closeBtn.click()
  } else {
    await fallback()
  }
  await page.waitForTimeout(500)
}

async function dismissOverlays(page: Page): Promise<void> {
  await dismissOverlay(page, 'settings-backdrop', 'settings-close', () => page.keyboard.press('Escape'))
  await dismissOverlay(page, 'notification-modal-backdrop', 'notification-modal-close', () =>
    page.locator('[data-testid="notification-modal-backdrop"]').click({ position: { x: 10, y: 10 } }),
  )
}

async function connectDevice(page: Page): Promise<boolean> {
  const deviceList = page.locator('[data-testid="device-list"]')
  const noDeviceMsg = page.locator('[data-testid="no-device-message"]')

  try {
    await Promise.race([
      deviceList.waitFor({ state: 'visible', timeout: 10_000 }),
      noDeviceMsg.waitFor({ state: 'visible', timeout: 10_000 }),
    ])
  } catch {
    console.log('Timed out waiting for device list.')
    return false
  }

  if (!(await deviceList.isVisible())) return false

  const targetBtn = page
    .locator('[data-testid="device-button"]')
    .filter({ has: page.locator('.font-semibold', { hasText: new RegExp(`^${escapeRegex(DEVICE_NAME)}$`) }) })

  if (!(await isAvailable(targetBtn))) return false

  await targetBtn.click()
  await page.locator('[data-testid="editor-content"]').waitFor({ state: 'visible', timeout: 20_000 })
  await page.waitForTimeout(2000)
  return true
}

async function capture(page: Page, name: string, opts?: { element?: Locator; fullPage?: boolean }): Promise<void> {
  const path = resolve(SCREENSHOT_DIR, `${name}.png`)
  if (opts?.element) {
    await opts.element.screenshot({ path })
  } else {
    await page.screenshot({ path, fullPage: opts?.fullPage ?? false })
  }
  console.log(`  Saved: ${name}.png`)
}

function launchElectronApp(): ReturnType<typeof spawn> {
  const electronPath = resolve(PROJECT_ROOT, 'node_modules/.bin/electron')
  return spawn(electronPath, [
    '.',
    '--no-sandbox',
    '--disable-gpu-sandbox',
    `--remote-debugging-port=${DEBUG_PORT}`,
  ], {
    cwd: PROJECT_ROOT,
    stdio: 'ignore',
    detached: false,
  })
}

async function waitForDebugPort(port: number, timeoutMs = 15_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Debug port ${port} not available after ${timeoutMs}ms`)
}

// --- Phase 1: Global Settings (Data tab) ---

async function captureGlobalSettings(page: Page): Promise<void> {
  console.log('\n--- Phase 1: Settings -> Data tab ---')
  const settingsBtn = page.locator('[data-testid="settings-button"]')
  if (!(await isAvailable(settingsBtn))) return

  await settingsBtn.click()
  await page.waitForTimeout(500)

  const settingsBackdrop = page.locator('[data-testid="settings-backdrop"]')
  if (!(await settingsBackdrop.isVisible())) return

  const dataTab = page.locator('[data-testid="settings-tab-data"]')
  if (await isAvailable(dataTab)) {
    await dataTab.click()
    await page.waitForTimeout(500)
    await capture(page, 'hub-settings-data-sync', { fullPage: true })
    console.log('  Data tab captured')
  }

  await page.locator('[data-testid="settings-close"]').click()
  await page.waitForTimeout(500)
}

// --- Phase 4: Editor Settings -> Data tab -> Save & Upload ---

async function findLocaleButton(container: Locator, labelEn: string, labelJa: string): Promise<Locator> {
  const enBtn = container.locator('button', { hasText: new RegExp(`^${escapeRegex(labelEn)}$`) })
  if (await isAvailable(enBtn)) return enBtn
  return container.locator('button', { hasText: new RegExp(`^${escapeRegex(labelJa)}$`) })
}

async function waitForUploadButton(page: Page): Promise<{ available: boolean; locator: Locator }> {
  const uploadBtn = page.locator('[data-testid="layout-store-upload-hub"]').first()
  if (await isAvailable(uploadBtn)) return { available: true, locator: uploadBtn }

  console.log('  Waiting for Hub initialization (up to 15s)...')
  try {
    await uploadBtn.waitFor({ state: 'attached', timeout: 15_000 })
    return { available: true, locator: uploadBtn }
  } catch {
    return { available: false, locator: uploadBtn }
  }
}

async function captureEditorDataTab(page: Page): Promise<void> {
  console.log('\n--- Phase 4: Editor Settings -> Data tab ---')
  await page.locator('[data-testid="editor-settings-button"]').click()
  await page.waitForTimeout(500)

  const backdrop = page.locator('[data-testid="editor-settings-backdrop"]')
  if (!(await isAvailable(backdrop))) {
    console.log('Editor settings not available')
    return
  }

  const dataTab = await findLocaleButton(backdrop, 'Data', 'データ')
  await dataTab.click()
  await page.waitForTimeout(300)

  console.log('\n--- Save Default snapshot ---')
  const saveInput = page.locator('[data-testid="layout-store-save-input"]')
  if (await isAvailable(saveInput)) {
    await saveInput.fill('Default')
    await page.waitForTimeout(300)
    await capture(page, 'hub-01-save-default', { fullPage: true })

    await page.locator('[data-testid="layout-store-save-submit"]').click()
    await page.waitForTimeout(1500)
    await capture(page, 'hub-02-saved-default', { fullPage: true })
  }

  console.log('\n--- Hub Upload ---')
  const { available, locator: uploadBtn } = await waitForUploadButton(page)

  if (available) {
    await capture(page, 'hub-03-upload-button', { fullPage: true })

    await uploadBtn.click()
    await page.waitForTimeout(5000)
    await capture(page, 'hub-04-uploaded', { fullPage: true })

    const shareLink = page.locator('[data-testid="layout-store-hub-share-link"]').first()
    if (await isAvailable(shareLink)) {
      await capture(page, 'hub-05-share-link', { fullPage: true })
    }
  } else {
    console.log('  [skip] Upload button not available (Hub not configured or display name not set)')
    await capture(page, 'hub-03-no-upload', { fullPage: true })
  }

  await page.locator('[data-testid="editor-settings-close"]').click()
  await page.waitForTimeout(300)
}

// --- Main ---

async function main(): Promise<void> {
  mkdirSync(SCREENSHOT_DIR, { recursive: true })

  console.log('Launching Electron app with remote debugging...')
  const child = launchElectronApp()

  try {
    await waitForDebugPort(DEBUG_PORT)
    console.log('Connected to debug port')

    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`)
    const contexts = browser.contexts()
    if (contexts.length === 0) throw new Error('No browser contexts found')

    const pages = contexts[0].pages()
    if (pages.length === 0) throw new Error('No pages found')

    const page = pages[0]
    await page.setViewportSize({ width: 1320, height: 900 })
    await page.waitForTimeout(3000)

    await dismissOverlays(page)
    await captureGlobalSettings(page)

    console.log('\n--- Phase 3: Connect device ---')
    const connected = await connectDevice(page)
    if (!connected) {
      console.log('Failed to connect to device.')
      return
    }

    await captureEditorDataTab(page)

    console.log(`\nHub screenshots saved to: ${SCREENSHOT_DIR}`)
    await browser.close()
  } finally {
    child.kill()
  }
}

main().catch((err: unknown) => {
  console.error('Script failed:', err)
  process.exit(1)
})
