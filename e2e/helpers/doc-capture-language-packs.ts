// SPDX-License-Identifier: GPL-2.0-or-later

// Screenshot capture script for the Language Packs modal (Settings → Tools).
// Mirrors doc-capture-key-labels.ts: launches Electron directly so safeStorage /
// keyring keep working, then connects via Playwright remote debugging.
// Captures the Installed tab and the Find on Hub tab of the Language Packs modal.
//
// Usage: pnpm build && npx tsx e2e/helpers/doc-capture-language-packs.ts
//
// Prerequisites:
// - At least one imported language pack makes the Installed capture more
//   representative; built-in English alone also works.

import { chromium } from '@playwright/test'
import type { Page } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { dismissOverlay, isAvailable } from './doc-capture-common'

const PROJECT_ROOT = resolve(import.meta.dirname, '../..')
const SCREENSHOT_DIR = resolve(PROJECT_ROOT, 'docs/screenshots')
const DEBUG_PORT = 19224

async function dismissOverlays(page: Page): Promise<void> {
  await dismissOverlay(page, 'settings-backdrop', 'settings-close', () => page.keyboard.press('Escape'))
  await dismissOverlay(page, 'notification-modal-backdrop', 'notification-modal-close', () =>
    page.locator('[data-testid="notification-modal-backdrop"]').click({ position: { x: 10, y: 10 } }),
  )
}

async function capture(page: Page, name: string): Promise<void> {
  const path = resolve(SCREENSHOT_DIR, `${name}.png`)
  const modal = page.locator('[data-testid="language-packs-modal"]')
  if (await isAvailable(modal)) {
    await modal.screenshot({ path })
  } else {
    await page.screenshot({ path })
  }
  console.log(`  Saved: ${name}.png`)
}

async function openLanguagePacksModal(page: Page): Promise<boolean> {
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

async function captureInstalledTab(page: Page): Promise<void> {
  console.log('\n--- Phase 1: Installed tab ---')
  const installedTab = page.locator('[data-testid="language-packs-tab-installed"]')
  if (await isAvailable(installedTab)) {
    await installedTab.click()
    await page.waitForTimeout(300)
  }
  await page.waitForTimeout(500)
  await capture(page, 'language-packs-installed')
}

async function captureFindOnHubTab(page: Page): Promise<void> {
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
    console.log('  [warn] No Hub results returned (network / Hub state?)')
  }
  await page.waitForTimeout(500)
  await capture(page, 'language-packs-hub')
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

async function main(): Promise<void> {
  mkdirSync(SCREENSHOT_DIR, { recursive: true })

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

    if (!(await openLanguagePacksModal(page))) return

    await captureInstalledTab(page)
    await captureFindOnHubTab(page)

    console.log(`\nLanguage Packs screenshots saved to: ${SCREENSHOT_DIR}`)
  } finally {
    await browser?.close()
    child.kill()
  }
}

main().catch((err: unknown) => {
  console.error('Script failed:', err)
  process.exit(1)
})
