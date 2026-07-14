// SPDX-License-Identifier: GPL-2.0-or-later

// Screenshot capture script for the Language Packs modal (Settings → Tools).
// Captures the Installed tab and the Find on Hub tab of the Language Packs modal.
//
// Usage: npx tsx e2e/helpers/doc-capture-language-packs.ts
//
// Connects to the virtual "Virtual Keyboard" device (PIPETTE_VIRTUAL_DEVICE=only)
// via launchCaptureApp(), same as the other doc-capture helpers. No real
// hardware required.
//
// Settings (and Language Packs behind it) is only reachable from the
// device-selector screen — see App.tsx, where SettingsModal is only
// rendered in the `!device.connectedDevice` branch. This means the whole
// capture happens on the device-selector screen, never the connected
// editor.
//
// Captures go through `webContents.capturePage()` in the main process
// (via `app.evaluate`) instead of Playwright's `page.screenshot()` /
// `locator.screenshot()`. On this screen specifically, the renderer-side
// CDP screenshot path (`Page.captureScreenshot`) can hang indefinitely in
// some sandboxed/software-rendering environments even though the page is
// fully interactive (locators, clicks and `boundingBox()` all still work
// fine) — `capturePage()` goes through Electron's own compositor path in
// the browser process and reliably returns a frame. Cropped to the
// `language-packs-modal` element's bounding box to match the framing of
// every other doc-capture screenshot; falls back to the full window if the
// modal isn't found.
//
// Prerequisites:
// - At least one imported language pack makes the Installed capture more
//   representative; built-in English alone also works.
// - The "Find on Hub" tab needs network/Hub reachability — if no results
//   come back within the timeout, the capture is taken anyway (showing
//   whatever offline/empty state the modal renders) and a warning is
//   logged rather than throwing.

import type { ElectronApplication, Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  dismissNotificationModal,
  isAvailable,
  launchCaptureApp,
} from './doc-capture-common'

const PROJECT_ROOT = resolve(import.meta.dirname, '../..')
const SCREENSHOT_DIR = resolve(PROJECT_ROOT, 'docs/screenshots')

interface CaptureRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Capture the current window through the main process
 * (`webContents.capturePage`) rather than Playwright's CDP screenshot path
 * — see the module doc comment for why. `testId`, when found, crops to
 * that element's bounding box; otherwise (or if the element isn't found)
 * the full window is captured.
 */
async function capture(app: ElectronApplication, page: Page, name: string, testId: string): Promise<void> {
  let rect: CaptureRect | undefined
  const locator = page.locator(`[data-testid="${testId}"]`)
  if (await isAvailable(locator)) {
    const box = await locator.boundingBox()
    if (box) {
      rect = { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }
    }
  }

  const dataUrl = await app.evaluate(async ({ BrowserWindow }, r) => {
    const win = BrowserWindow.getAllWindows()[0]
    const img = r ? await win.webContents.capturePage(r) : await win.webContents.capturePage()
    return img.toDataURL()
  }, rect)

  const path = resolve(SCREENSHOT_DIR, `${name}.png`)
  writeFileSync(path, Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'))
  console.log(`  Saved: ${name}.png`)
}

/**
 * The Settings modal (and Language Packs behind it) is only reachable from
 * the device-selector screen (see App.tsx — SettingsModal is only rendered
 * in the `!device.connectedDevice` branch). With PIPETTE_VIRTUAL_DEVICE=only
 * plus a `lastDevice` persisted from any earlier doc-capture/e2e run on this
 * userData profile, `useSessionRestore` auto-connects to the virtual device
 * on launch and skips straight to the editor. Disconnect first so the
 * device-selector (and its settings-button) is reachable regardless of
 * whether this run started fresh or auto-restored a session.
 */
async function ensureDeviceSelectorScreen(page: Page): Promise<void> {
  const disconnectBtn = page.locator('[data-testid="disconnect-button"]')
  if (await isAvailable(disconnectBtn)) {
    console.log('  Auto-connected on launch (restoreLastSession) — disconnecting to reach the device selector...')
    await disconnectBtn.click()
    await page.waitForTimeout(500)
  }
}

async function openLanguagePacksModal(page: Page): Promise<boolean> {
  await ensureDeviceSelectorScreen(page)

  const settingsBtn = page.locator('[data-testid="settings-button"]')
  if (!(await isAvailable(settingsBtn))) {
    console.log('  [skip] settings-button not found')
    return false
  }
  await settingsBtn.click()
  await page.waitForTimeout(500)

  const settingsBackdrop = page.locator('[data-testid="settings-backdrop"]')
  if (!(await settingsBackdrop.isVisible())) {
    console.log('  [skip] settings modal did not open')
    return false
  }

  const toolsTab = page.locator('[data-testid="settings-tab-tools"]')
  if (await isAvailable(toolsTab)) {
    await toolsTab.click()
    await page.waitForTimeout(300)
  }

  const editBtn = page.locator('[data-testid="settings-language-packs-button"]')
  if (!(await isAvailable(editBtn))) {
    console.log('  [skip] Language Packs Edit button not found')
    return false
  }
  await editBtn.click()
  await page.waitForTimeout(500)

  const modal = page.locator('[data-testid="language-packs-modal"]')
  try {
    await modal.waitFor({ state: 'visible', timeout: 3000 })
  } catch {
    console.log('  [skip] Language Packs modal did not open')
    return false
  }
  return true
}

async function captureInstalledTab(app: ElectronApplication, page: Page): Promise<void> {
  console.log('\n--- Phase 1: Installed tab ---')
  const installedTab = page.locator('[data-testid="language-packs-tab-installed"]')
  if (await isAvailable(installedTab)) {
    await installedTab.click()
    await page.waitForTimeout(300)
  }
  await page.waitForTimeout(500)
  await capture(app, page, 'language-packs-installed', 'language-packs-modal')
}

async function captureFindOnHubTab(app: ElectronApplication, page: Page): Promise<void> {
  console.log('\n--- Phase 2: Find on Hub tab ---')
  const hubTab = page.locator('[data-testid="language-packs-tab-hub"]')
  if (!(await isAvailable(hubTab))) {
    console.log('  [skip] Find on Hub tab not found')
    return
  }
  await hubTab.click()
  await page.waitForTimeout(300)

  const input = page.locator('[data-testid="language-packs-search-input"]')
  if (!(await isAvailable(input))) {
    console.log('  [skip] search input not found')
    return
  }
  await input.fill('ja')

  const firstResult = page.locator('[data-testid^="language-packs-hub-row-"]')
  try {
    await firstResult.first().waitFor({ state: 'visible', timeout: 5000 })
    console.log('  Hub results visible')
  } catch {
    console.log('  [skip] No Hub results returned within timeout (network / Hub unreachable in this environment) — capturing current state anyway')
  }
  await page.waitForTimeout(500)
  await capture(app, page, 'language-packs-hub', 'language-packs-modal')
}

async function main(): Promise<void> {
  mkdirSync(SCREENSHOT_DIR, { recursive: true })

  console.log('Launching Electron app (virtual device)...')
  const app = await launchCaptureApp()

  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.setViewportSize({ width: 1320, height: 960 })
  await page.waitForTimeout(3000)

  try {
    await dismissNotificationModal(page, { waitForAppearMs: 3000 })

    if (!(await openLanguagePacksModal(page))) return

    await captureInstalledTab(app, page)
    await captureFindOnHubTab(app, page)

    console.log(`\nLanguage Packs screenshots saved to: ${SCREENSHOT_DIR}`)
  } finally {
    await app.close().catch((err: unknown) => console.error('  [cleanup] app.close failed:', err))
  }
}

main().catch((err: unknown) => {
  console.error('Script failed:', err)
  process.exit(1)
})
