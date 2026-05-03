// SPDX-License-Identifier: GPL-2.0-or-later
//
// Adhoc capture for `overlay-tools.png`. Mirrors doc-capture.ts but
// stops after the keypicker overlay's Settings tab so we don't have
// to rerun the full multi-phase pipeline (which currently fails
// earlier on the Analyze page when device data is sparse).
//
// Usage: pnpm build && npx tsx e2e/helpers/doc-capture-overlay-tools.ts
//
// Prerequisites:
// - GPK60-63R USB connected and unlocked.

import { chromium } from '@playwright/test'
import type { Page } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { dismissOverlay, isAvailable } from './doc-capture-common'

const PROJECT_ROOT = resolve(import.meta.dirname, '../..')
const SCREENSHOT_DIR = resolve(PROJECT_ROOT, 'docs/screenshots')
const DEBUG_PORT = 19224
const DEVICE_NAME = 'GPK60-63R'

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function dismissOverlays(page: Page): Promise<void> {
  await dismissOverlay(page, 'settings-backdrop', 'settings-close', () => page.keyboard.press('Escape'))
  await dismissOverlay(page, 'notification-modal-backdrop', 'notification-modal-close', () =>
    page.locator('[data-testid="notification-modal-backdrop"]').click({ position: { x: 10, y: 10 } }),
  )
}

async function connectDevice(page: Page): Promise<boolean> {
  const deviceList = page.locator('[data-testid="device-list"]')
  await deviceList.waitFor({ state: 'visible', timeout: 10_000 })
  const targetBtn = page
    .locator('[data-testid="device-button"]')
    .filter({ has: page.locator('.font-semibold', { hasText: new RegExp(`^${escapeRegex(DEVICE_NAME)}$`) }) })
  if (!(await isAvailable(targetBtn))) return false
  await targetBtn.click()
  await page.locator('[data-testid="editor-content"]').waitFor({ state: 'visible', timeout: 20_000 })
  await page.waitForTimeout(2000)
  return true
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

function launchElectronApp(): ReturnType<typeof spawn> {
  const electronPath = resolve(PROJECT_ROOT, 'node_modules/.bin/electron')
  return spawn(electronPath, ['.', '--no-sandbox', '--disable-gpu-sandbox', `--remote-debugging-port=${DEBUG_PORT}`], {
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

    if (!(await connectDevice(page))) {
      console.log('Failed to connect to device')
      return
    }

    if (!(await ensureOverlayOpen(page))) {
      console.log('[skip] overlay toggle not found')
      return
    }

    const tab = page.locator('[data-testid="overlay-tab-tools"]')
    if (await isAvailable(tab)) {
      await tab.click()
      await page.waitForTimeout(300)
    }

    const out = resolve(SCREENSHOT_DIR, 'overlay-tools.png')
    await page.screenshot({ path: out, fullPage: true })
    console.log(`Saved: ${out}`)
  } finally {
    await browser?.close()
    child.kill()
  }
}

main().catch((err: unknown) => {
  console.error('Script failed:', err)
  process.exit(1)
})
