// SPDX-License-Identifier: GPL-2.0-or-later
//
// Adhoc capture for `overlay-tools.png`. Mirrors doc-capture.ts but
// stops after the keypicker overlay's Settings/Tools tab so we don't have
// to rerun the full multi-phase pipeline (which currently fails earlier on
// the Analyze page when device data is sparse).
//
// Usage: npx tsx e2e/helpers/doc-capture-overlay-tools.ts
//
// Connects to the virtual "Virtual Keyboard" device via launchCaptureApp()
// (PIPETTE_VIRTUAL_DEVICE=only), same as the other doc-capture helpers.
// No real hardware required. Using launchCaptureApp() — Playwright's
// electron.launch on out/main/index.js — is important: it gets its own
// isolated userData that defaults to English, so this capture always comes
// out in English regardless of the UI language set in the developer's
// installed-app profile (~/.config/Pipette).
//
// Captures go through `webContents.capturePage()` in the main process (via
// `app.evaluate`) rather than Playwright's renderer-side CDP screenshot
// path, which can hang indefinitely in some sandboxed/software-rendering
// environments even though the page is fully interactive (see
// doc-capture-language-packs.ts for the same workaround and rationale).

import type { ElectronApplication, Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  connectToDevice,
  dismissNotificationModal,
  isAvailable,
  launchCaptureApp,
  VIRTUAL_DEVICE_DISPLAY_NAME,
} from './doc-capture-common'

const PROJECT_ROOT = resolve(import.meta.dirname, '../..')
const SCREENSHOT_DIR = resolve(PROJECT_ROOT, 'docs/screenshots')
const DEVICE_NAME = VIRTUAL_DEVICE_DISPLAY_NAME

/**
 * Capture the current window through the main process
 * (`webContents.capturePage`) rather than Playwright's CDP screenshot path
 * — see the module doc comment for why. Captures the full window (the
 * original overlay-tools.png was a fullPage screenshot of the 1320x960
 * viewport).
 */
async function capture(app: ElectronApplication, name: string): Promise<void> {
  const dataUrl = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    const img = await win.webContents.capturePage()
    return img.toDataURL()
  })
  const path = resolve(SCREENSHOT_DIR, `${name}.png`)
  writeFileSync(path, Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'))
  console.log(`Saved: ${path}`)
}

async function ensureOverlayOpen(page: Page): Promise<boolean> {
  const toggle = page.locator('button[aria-controls="keycodes-overlay-panel"]')
  if (!(await isAvailable(toggle))) return false
  const isExpanded = await toggle.getAttribute('aria-expanded')
  if (isExpanded !== 'true') {
    await toggle.click()
    await page.waitForTimeout(500)
  }
  return true
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

    console.log(`Looking for ${DEVICE_NAME}...`)
    const connected = await connectToDevice(page, DEVICE_NAME)
    if (!connected) {
      console.log('Failed to connect to device')
      return
    }
    console.log(`Connected to ${DEVICE_NAME}`)
    await dismissNotificationModal(page)

    // The Tools overlay tab isn't unlock-gated, so no clickThroughUnlock is
    // needed here — just open the keycodes overlay and select the tab.
    if (!(await ensureOverlayOpen(page))) {
      console.log('[skip] overlay toggle not found')
      return
    }

    const tab = page.locator('[data-testid="overlay-tab-tools"]')
    if (await isAvailable(tab)) {
      await tab.click()
      await page.waitForTimeout(300)
    }

    await capture(app, 'overlay-tools')
  } finally {
    await app.close().catch((err: unknown) => console.error('  [cleanup] app.close failed:', err))
  }
}

main().catch((err: unknown) => {
  console.error('Script failed:', err)
  process.exit(1)
})
