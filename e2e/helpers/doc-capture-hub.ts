// SPDX-License-Identifier: GPL-2.0-or-later

// Screenshot capture script for Hub workflow documentation.
// Launches app directly (not via Playwright electron.launch) to preserve safeStorage/keyring,
// then connects Playwright via remote debugging to capture screenshots.
// Usage: pnpm build && npx tsx e2e/helpers/doc-capture-hub.ts
import { chromium } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const PROJECT_ROOT = resolve(import.meta.dirname, '../..')
const SCREENSHOT_DIR = resolve(PROJECT_ROOT, 'docs/screenshots')
const DEVICE_NAME = 'GPK60-63R'
const DEBUG_PORT = 19222

// Resolve real userData path for the installed app (Linux: ~/.config/pipette-desktop/)
const USER_DATA_PATH = join(homedir(), '.config', 'pipette-desktop')
const FAV_BASE = join(USER_DATA_PATH, 'sync', 'favorites')

interface FavoriteEntry {
  id: string
  label: string
  filename: string
  savedAt: string
  updatedAt?: string
  hubPostId?: string
}

interface FavoriteIndex {
  type: string
  entries: FavoriteEntry[]
}

interface SeedBackup {
  indexBackups: Map<string, string | null>
  createdFiles: Set<string>
}

const DUMMY_FAVORITES: Record<string, FavoriteIndex> = {
  tapDance: {
    type: 'tapDance',
    entries: [
      { id: 'doc-td-1', label: 'Ctrl/Esc', filename: 'doc-td-1.json', savedAt: '2026-02-20T10:00:00.000Z', updatedAt: '2026-02-25T12:30:00.000Z', hubPostId: 'hub-td-001' },
      { id: 'doc-td-2', label: 'Shift/CapsWord', filename: 'doc-td-2.json', savedAt: '2026-02-21T08:15:00.000Z', updatedAt: '2026-02-24T09:00:00.000Z' },
      { id: 'doc-td-3', label: 'Layer Toggle', filename: 'doc-td-3.json', savedAt: '2026-02-22T14:30:00.000Z' },
    ],
  },
  macro: {
    type: 'macro',
    entries: [
      { id: 'doc-mc-1', label: 'Email Signature', filename: 'doc-mc-1.json', savedAt: '2026-02-19T09:00:00.000Z', updatedAt: '2026-02-25T10:00:00.000Z', hubPostId: 'hub-mc-001' },
      { id: 'doc-mc-2', label: 'Git Commit', filename: 'doc-mc-2.json', savedAt: '2026-02-22T16:00:00.000Z' },
    ],
  },
}

function seedDocFavorites(): SeedBackup {
  const indexBackups = new Map<string, string | null>()
  const createdFiles = new Set<string>()

  for (const [type, index] of Object.entries(DUMMY_FAVORITES)) {
    const dir = join(FAV_BASE, type)
    mkdirSync(dir, { recursive: true })

    const indexPath = join(dir, 'index.json')
    indexBackups.set(indexPath, existsSync(indexPath) ? readFileSync(indexPath, 'utf-8') : null)
    writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8')

    for (const entry of index.entries) {
      const fp = join(dir, entry.filename)
      if (!existsSync(fp)) {
        writeFileSync(fp, '{}', 'utf-8')
        createdFiles.add(fp)
      }
    }
  }
  return { indexBackups, createdFiles }
}

function restoreDocFavorites({ indexBackups, createdFiles }: SeedBackup): void {
  for (const [indexPath, original] of indexBackups) {
    if (original != null) {
      writeFileSync(indexPath, original, 'utf-8')
    } else {
      try { unlinkSync(indexPath) } catch { /* ignore */ }
    }
  }
  for (const fp of createdFiles) {
    try { unlinkSync(fp) } catch { /* ignore */ }
  }
}

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

// --- Phase 2: Data Modal — Favorites with Hub actions ---

async function captureDataModalHub(page: Page): Promise<void> {
  console.log('\n--- Phase 2: Data Modal — Favorites Hub actions ---')

  const dataBtn = page.locator('[data-testid="data-button"]')
  if (!(await isAvailable(dataBtn))) {
    console.log('  [skip] data-button not found')
    return
  }

  await dataBtn.click()
  await page.waitForTimeout(1000)

  const backdrop = page.locator('[data-testid="data-modal-backdrop"]')
  try {
    await backdrop.waitFor({ state: 'visible', timeout: 3000 })
  } catch {
    console.log('  [skip] Data modal did not open')
    return
  }

  // Wait for favorite entries to load (default tab: Tap Dance)
  const entries = page.locator('[data-testid="data-modal-fav-entry"]')
  try {
    await entries.first().waitFor({ state: 'visible', timeout: 5000 })
  } catch {
    console.log('  [warn] No favorite entries loaded')
  }

  // Wait for Hub initialization — the Upload button appears after Hub auth check
  const hubActions = page.locator('[data-testid="fav-hub-actions"]')
  try {
    await hubActions.first().waitFor({ state: 'visible', timeout: 15_000 })
    console.log('  Hub actions visible')
  } catch {
    console.log('  [warn] Hub actions not available (Hub not configured?)')
  }

  await capture(page, 'hub-fav-data-modal', { fullPage: true })

  // Switch to Hub Posts tab if available
  const hubPostsTab = page.locator('[data-testid="data-modal-tab-hubPost"]')
  if (await isAvailable(hubPostsTab)) {
    await hubPostsTab.click()
    await page.waitForTimeout(1000)
    await capture(page, '02-data-modal-hub-posts', { fullPage: true })
  }

  await page.locator('[data-testid="data-modal-close"]').click()
  await page.waitForTimeout(300)
}

// --- Phase 5: Inline Favorites with Hub actions (requires device) ---

async function captureInlineFavoritesHub(page: Page): Promise<void> {
  console.log('\n--- Phase 5: Inline Favorites — Hub actions ---')

  const editorContent = page.locator('[data-testid="editor-content"]')
  const tdTabLabel = 'Tap-Hold / Tap Dance'

  // Try both English and Japanese tab labels
  let tdTabBtn = editorContent.locator('button', { hasText: new RegExp(`^${escapeRegex(tdTabLabel)}$`) })
  if (!(await isAvailable(tdTabBtn))) {
    tdTabBtn = editorContent.locator('button', { hasText: /タップダンス/ })
  }
  if (!(await isAvailable(tdTabBtn))) {
    console.log(`  [skip] ${tdTabLabel} tab not found`)
    return
  }
  await tdTabBtn.first().click()
  await page.waitForTimeout(300)

  // Click tile 0 to open the TD modal
  const tdTile = page.locator('[data-testid="td-tile-0"]')
  if (!(await isAvailable(tdTile))) {
    console.log('  [skip] td-tile-0 not found')
    return
  }
  await tdTile.click()
  await page.waitForTimeout(500)

  const tdBackdrop = page.locator('[data-testid="td-modal-backdrop"]')
  try {
    await tdBackdrop.waitFor({ state: 'visible', timeout: 3000 })
  } catch {
    console.log('  [skip] TD modal did not open')
    return
  }

  // Wait for Hub actions in the inline favorites panel
  const hubActions = page.locator('[data-testid="fav-hub-actions"]')
  try {
    await hubActions.first().waitFor({ state: 'visible', timeout: 10_000 })
    console.log('  Hub actions visible in inline favorites')
  } catch {
    console.log('  [warn] Hub actions not visible in inline favorites')
  }

  await capture(page, 'hub-fav-inline', { fullPage: true })

  await page.locator('[data-testid="td-modal-close"]').click()
  await page.waitForTimeout(300)
}

// --- Phase 4: Editor Settings -> Data tab -> Save & Upload ---

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

async function switchOverlayTab(page: Page, tabTestId: string): Promise<boolean> {
  const tab = page.locator(`[data-testid="${tabTestId}"]`)
  if (!(await isAvailable(tab))) {
    console.log(`  [skip] ${tabTestId} not found`)
    return false
  }
  await tab.click()
  await page.waitForTimeout(300)
  return true
}

async function captureEditorDataTab(page: Page): Promise<void> {
  console.log('\n--- Phase 4: Overlay Panel -> Data tab (Save & Upload) ---')

  // Dismiss any overlays that may have appeared (unlock dialog, notifications)
  await dismissOverlays(page)

  // Switch to Basic tab to ensure overlay toggle is visible
  const editorContent = page.locator('[data-testid="editor-content"]')
  const basicBtn = editorContent.locator('button:visible', { hasText: /^Basic$/ })
  if (await isAvailable(basicBtn)) {
    await basicBtn.first().click()
    await page.waitForTimeout(300)
  }

  if (!(await ensureOverlayOpen(page))) {
    console.log('  [skip] overlay toggle not found')
    return
  }

  if (!(await switchOverlayTab(page, 'overlay-tab-data'))) {
    console.log('  [skip] data tab not found in overlay')
    return
  }

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
}

// --- Main ---

async function main(): Promise<void> {
  mkdirSync(SCREENSHOT_DIR, { recursive: true })

  // Seed dummy favorites with hubPostId before launching
  console.log('Seeding dummy favorites...')
  const favBackups = seedDocFavorites()

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
    await captureGlobalSettings(page)
    await captureDataModalHub(page)

    console.log('\n--- Phase 3: Connect device ---')
    const connected = await connectDevice(page)
    if (!connected) {
      console.log('Failed to connect to device.')
      return
    }

    await captureInlineFavoritesHub(page)
    await captureEditorDataTab(page)

    console.log(`\nHub screenshots saved to: ${SCREENSHOT_DIR}`)
  } finally {
    await browser?.close()
    child.kill()
    restoreDocFavorites(favBackups)
    console.log('Restored original favorites')
  }
}

main().catch((err: unknown) => {
  console.error('Script failed:', err)
  process.exit(1)
})
