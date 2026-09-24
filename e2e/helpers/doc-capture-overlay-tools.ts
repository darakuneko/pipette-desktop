// SPDX-License-Identifier: GPL-2.0-or-later
//
// Adhoc capture for the keypicker overlay screenshots — `overlay-tools.png`
// (Settings / Import tab) plus `overlay-save.png` and
// `editor-settings-save.png` (Save tab). Mirrors doc-capture.ts but
// stops after the overlay tabs so we don't have
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

import type { ElectronApplication } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  connectToDevice,
  dismissNotificationModal,
  launchCaptureApp,
  openOverlayTab,
  overlayTabNotFoundMessage,
  VIRTUAL_DEVICE_DISPLAY_NAME,
} from './doc-capture-common'

const PROJECT_ROOT = resolve(import.meta.dirname, '../..')
const SCREENSHOT_DIR = resolve(PROJECT_ROOT, 'docs/screenshots')
const DEVICE_NAME = VIRTUAL_DEVICE_DISPLAY_NAME

/** Same viewport `doc-capture.ts` captures `overlay-tools.png` at. */
const VIEWPORT = { width: 1440, height: 1024 }

/**
 * Capture the current window through the main process
 * (`webContents.capturePage`) rather than Playwright's CDP screenshot path
 * — see the module doc comment for why. The image is resized to the
 * viewport's CSS size so display scaling doesn't change its dimensions.
 */
async function capture(app: ElectronApplication, name: string): Promise<void> {
  const dataUrl = await app.evaluate(async ({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0]
    const img = await win.webContents.capturePage()
    return img.resize({ ...size, quality: 'best' }).toDataURL()
  }, VIEWPORT)
  const path = resolve(SCREENSHOT_DIR, `${name}.png`)
  writeFileSync(path, Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'))
  console.log(`Saved: ${path}`)
}

async function main(): Promise<void> {
  mkdirSync(SCREENSHOT_DIR, { recursive: true })

  console.log('Launching Electron app (virtual device)...')
  const app = await launchCaptureApp()

  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.setViewportSize(VIEWPORT)
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
    if (!(await openOverlayTab(page, 'tools'))) {
      console.log(`  [skip] ${overlayTabNotFoundMessage('tools')}`)
      return
    }

    await capture(app, 'overlay-tools')

    if (await openOverlayTab(page, 'data')) {
      await capture(app, 'overlay-save')
      await capture(app, 'editor-settings-save')
    } else {
      console.log(`  [skip] ${overlayTabNotFoundMessage('data')}`)
    }
  } finally {
    await app.close().catch((err: unknown) => console.error('  [cleanup] app.close failed:', err))
  }
}

main().catch((err: unknown) => {
  console.error('Script failed:', err)
  process.exit(1)
})
