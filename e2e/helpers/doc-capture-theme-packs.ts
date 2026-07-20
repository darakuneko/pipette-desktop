// SPDX-License-Identifier: GPL-2.0-or-later

// Screenshot capture script for the Theme Packs modal (Settings → Tools).
// Mirrors doc-capture-language-packs.ts: launches Electron directly so safeStorage /
// keyring keep working, then connects via Playwright remote debugging.
// Captures the Installed tab and the Find on Hub tab of the Theme Packs modal.
//
// Usage: pnpm build && npx tsx e2e/helpers/doc-capture-theme-packs.ts
//
// Prerequisites:
// - At least one imported theme pack makes the Installed capture more
//   representative; built-in themes alone also work.

import { chromium } from '@playwright/test'
import type { Page } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  dismissNotificationModal,
  dismissOverlay,
  forceEnglishLanguage,
  isAvailable,
  resolveCaptureUserDataPath,
  restoreLanguageConfig,
} from './doc-capture-common'

const PROJECT_ROOT = resolve(import.meta.dirname, '../..')
const SCREENSHOT_DIR = resolve(PROJECT_ROOT, 'docs/screenshots')
const DEBUG_PORT = 19225

async function dismissOverlays(page: Page): Promise<void> {
  await dismissOverlay(page, 'settings-backdrop', 'settings-close', () => page.keyboard.press('Escape'))
  // `useStartupNotification` fetches asynchronously after mount, so an
  // instant `dismissOverlay` check can race a late-appearing modal and
  // leave its backdrop up to intercept the subsequent disconnect-button
  // click in `ensureDeviceSelectorScreen`. Give it up to 3s to show up
  // first, matching doc-capture-language-packs.ts's idiom.
  await dismissNotificationModal(page, { waitForAppearMs: 3000 })
}

async function capture(page: Page, name: string): Promise<void> {
  const path = resolve(SCREENSHOT_DIR, `${name}.png`)
  // Uses `page.screenshot({ clip })` off a plain `boundingBox()` rather
  // than `locator.screenshot()` — see doc-capture-key-labels.ts's
  // `capture()` for why (the same device-selector screen's
  // `locator.screenshot()` actionability wait can hang on some
  // sandboxed/software-rendering hosts). `capturePageWithRetry` retries
  // the CDP screenshot call itself for the same reason.
  const modal = page.locator('[data-testid="theme-packs-modal"]')
  const box = (await isAvailable(modal)) ? await modal.boundingBox() : null
  const clip = box
    ? { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }
    : undefined
  await capturePageWithRetry(page, path, clip)
  console.log(`  Saved: ${name}.png`)
}

/** See doc-capture-key-labels.ts's `capturePageWithRetry` for why this exists
 *  (including nudging the compositor with a viewport resize before every
 *  attempt, not just on retry — reliably un-sticks a reproduced
 *  stale-compositor-frame hang on this exact modal + tab). */
async function capturePageWithRetry(
  page: Page,
  path: string,
  clip: { x: number; y: number; width: number; height: number } | undefined,
  attempts = 3,
): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    const size = page.viewportSize()
    if (size) {
      await page.setViewportSize({ width: size.width + 1, height: size.height + 1 })
      await page.waitForTimeout(300)
      await page.setViewportSize(size)
      await page.waitForTimeout(500)
    }
    try {
      await page.screenshot(clip ? { path, clip, timeout: 15_000 } : { path, timeout: 15_000 })
      return
    } catch (err) {
      if (i === attempts) throw err
      console.log(`    [warn] screenshot attempt ${i} timed out, retrying with another compositor nudge...`)
    }
  }
}

/**
 * The Settings modal (and Theme Packs behind it) is only reachable from
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
    await disconnectBtn.click({ force: true })
    await page.waitForTimeout(500)
  }
}

async function openThemePacksModal(page: Page): Promise<boolean> {
  await ensureDeviceSelectorScreen(page)

  const settingsBtn = page.locator('[data-testid="settings-button"]')
  if (!(await isAvailable(settingsBtn))) {
    console.log('  [skip] settings-button not found')
    return false
  }
  await settingsBtn.click({ force: true })
  await page.waitForTimeout(500)

  const settingsBackdrop = page.locator('[data-testid="settings-backdrop"]')
  if (!(await settingsBackdrop.isVisible())) {
    console.log('  [skip] settings modal did not open')
    return false
  }

  const toolsTab = page.locator('[data-testid="settings-tab-tools"]')
  if (await isAvailable(toolsTab)) {
    await toolsTab.click({ force: true })
    await page.waitForTimeout(300)
  }

  const editBtn = page.locator('[data-testid="settings-theme-packs-button"]')
  if (!(await isAvailable(editBtn))) {
    console.log('  [skip] Theme Packs Edit button not found')
    return false
  }
  await editBtn.click({ force: true })
  await page.waitForTimeout(500)

  const modal = page.locator('[data-testid="theme-packs-modal"]')
  try {
    await modal.waitFor({ state: 'visible', timeout: 3000 })
  } catch {
    console.log('  [skip] Theme Packs modal did not open')
    return false
  }
  return true
}

async function captureInstalledTab(page: Page): Promise<void> {
  console.log('\n--- Phase 1: Installed tab ---')
  const installedTab = page.locator('[data-testid="theme-packs-tab-installed"]')
  if (await isAvailable(installedTab)) {
    await installedTab.click({ force: true })
    await page.waitForTimeout(300)
  }
  await page.waitForTimeout(500)
  await capture(page, 'theme-packs-installed')
}

async function captureFindOnHubTab(page: Page): Promise<void> {
  console.log('\n--- Phase 2: Find on Hub tab ---')
  const hubTab = page.locator('[data-testid="theme-packs-tab-hub"]')
  if (!(await isAvailable(hubTab))) {
    console.log('  [skip] Find on Hub tab not found')
    return
  }
  await hubTab.click({ force: true })
  await page.waitForTimeout(300)

  const input = page.locator('[data-testid="theme-packs-search-input"]')
  if (!(await isAvailable(input))) {
    console.log('  [skip] search input not found')
    return
  }
  await input.fill('Solarized')

  const searchBtn = page.locator('[data-testid="theme-packs-search-button"]')
  if (await isAvailable(searchBtn)) {
    await searchBtn.click({ force: true })
  }

  const firstResult = page.locator('[data-testid^="theme-packs-hub-row-"]')
  try {
    await firstResult.first().waitFor({ state: 'visible', timeout: 5000 })
    console.log('  Hub results visible')
  } catch {
    console.log('  [warn] No Hub results returned (network / Hub state?)')
  }
  await page.waitForTimeout(500)
  await capture(page, 'theme-packs-hub')
}

function launchElectronApp(): ReturnType<typeof spawn> {
  const electronPath = resolve(PROJECT_ROOT, 'node_modules/.bin/electron')
  const args = [
    '.',
    '--no-sandbox',
    '--disable-gpu-sandbox',
    `--remote-debugging-port=${DEBUG_PORT}`,
  ]
  // See doc-capture-key-labels.ts's `launchElectronApp` for why this
  // escape hatch exists (the unconditional single-instance lock from #278).
  if (process.env.PIPETTE_CAPTURE_USER_DATA_DIR) {
    args.push(`--user-data-dir=${process.env.PIPETTE_CAPTURE_USER_DATA_DIR}`)
  }
  return spawn(electronPath, args, {
    cwd: PROJECT_ROOT,
    stdio: 'ignore',
    detached: false,
    // Same virtual-device requirement as every other doc-capture helper
    // (see `launchCaptureApp` in doc-capture-common.ts) — this helper was
    // missing it, so a real HID device with a `lastDevice` persisted from
    // an earlier non-capture session could get picked up by
    // restoreLastSession instead of the virtual keyboard, landing on a
    // stuck/blocked connected-editor screen (Unlock dialog, comms error)
    // rather than the device selector.
    env: { ...process.env, PIPETTE_VIRTUAL_DEVICE: 'only' },
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

/**
 * Runs one capture phase in its own freshly-launched Electron process.
 *
 * On some sandboxed/software-rendering hosts, whichever capture phase
 * runs *second* within a single Electron session reliably wedges the
 * renderer badly enough that `page.screenshot()` never returns — this
 * happens even between two lightweight phases (Installed tab, then one
 * Hub search), so it isn't specific to any one phase's own network load.
 * The first phase in any given session always succeeds fine. Giving each
 * phase its own process sidesteps the accumulation entirely, at the cost
 * of a second launch cycle. See doc-capture-key-labels.ts's
 * `runPhaseInFreshSession` for the fuller investigation notes.
 */
async function runPhaseInFreshSession(phase: (page: Page) => Promise<void>): Promise<void> {
  console.log('Launching Electron app with remote debugging...')
  const child = launchElectronApp()

  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined
  try {
    await waitForDebugPort(DEBUG_PORT)
    console.log('Connected to debug port')

    browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`)
    const contexts = browser.contexts()
    if (contexts.length === 0) throw new Error('No browser contexts found')

    const pages = contexts[0].pages()
    if (pages.length === 0) throw new Error('No pages found')

    const page = pages[0]
    await page.setViewportSize({ width: 1320, height: 960 })
    await page.waitForTimeout(3000)

    await dismissOverlays(page)

    if (!(await openThemePacksModal(page))) return

    await phase(page)
  } finally {
    await browser?.close()
    await killAndWaitForExit(child)
  }
}

/** See doc-capture-key-labels.ts's `killAndWaitForExit` for why this exists. */
async function killAndWaitForExit(child: ReturnType<typeof spawn>, timeoutMs = 5000): Promise<void> {
  if (child.exitCode !== null || child.killed) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill()
  })
}

async function main(): Promise<void> {
  mkdirSync(SCREENSHOT_DIR, { recursive: true })

  // This helper launches Electron directly against the real userData
  // profile (see `launchElectronApp` below) rather than through
  // `launchCaptureApp`'s isolated, always-English profile — force English
  // for the run so a developer's own i18n pack setting can't leak into
  // the captured screenshots.
  const languageBackup = forceEnglishLanguage(resolveCaptureUserDataPath())
  try {
    await runPhaseInFreshSession(captureInstalledTab)
    await runPhaseInFreshSession(captureFindOnHubTab)
  } finally {
    // Both phases above already wait for their Electron process to fully
    // exit (`killAndWaitForExit`) before returning, so by the time this
    // runs there's no running app left to race the restore.
    restoreLanguageConfig(languageBackup)
  }

  console.log(`\nTheme Packs screenshots saved to: ${SCREENSHOT_DIR}`)
}

main().catch((err: unknown) => {
  console.error('Script failed:', err)
  process.exit(1)
})
