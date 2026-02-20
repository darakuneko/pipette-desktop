// SPDX-License-Identifier: GPL-2.0-or-later

// Screenshot capture script for Pipette operation guide documentation.
// Usage: pnpm build && pnpm doc:screenshots
import { _electron as electron } from '@playwright/test'
import type { Page, Locator } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const PROJECT_ROOT = resolve(import.meta.dirname, '../..')
const SCREENSHOT_DIR = resolve(PROJECT_ROOT, 'docs/screenshots')
const DEVICE_NAME = 'GPK60-63R'

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&')
}

async function isAvailable(locator: Locator): Promise<boolean> {
  return (await locator.count()) > 0
}

// Uses fixed filenames that match OPERATION-GUIDE.md references.
// A global counter tracks sequential numbering.
let screenshotCounter = 0

async function capture(
  page: Page,
  name: string,
  opts?: { element?: Locator; fullPage?: boolean },
): Promise<void> {
  screenshotCounter++
  const num = String(screenshotCounter).padStart(2, '0')
  const filename = `${num}-${name}.png`
  const path = resolve(SCREENSHOT_DIR, filename)

  if (opts?.element) {
    await opts.element.screenshot({ path })
  } else {
    await page.screenshot({ path, fullPage: opts?.fullPage ?? false })
  }

  console.log(`  [${num}] ${filename}`)
}

async function dismissNotificationModal(page: Page): Promise<void> {
  const backdrop = page.locator('[data-testid="notification-modal-backdrop"]')
  if (await backdrop.isVisible()) {
    console.log('Dismissing notification modal...')
    const closeBtn = page.locator('[data-testid="notification-modal-close"]')
    if (await isAvailable(closeBtn)) {
      await closeBtn.click()
    } else {
      await backdrop.click({ position: { x: 10, y: 10 } })
    }
    await page.waitForTimeout(500)
  }
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

  if (!(await deviceList.isVisible())) {
    console.log('No devices found.')
    return false
  }

  const targetBtn = page
    .locator('[data-testid="device-button"]')
    .filter({ has: page.locator('.font-semibold', { hasText: new RegExp(`^${escapeRegex(DEVICE_NAME)}$`) }) })

  if (!(await isAvailable(targetBtn))) {
    console.log(`Device "${DEVICE_NAME}" not found.`)
    return false
  }

  await targetBtn.click()
  await page.locator('[data-testid="editor-content"]').waitFor({ state: 'visible', timeout: 20_000 })
  await page.waitForTimeout(2000)
  console.log(`Connected to ${DEVICE_NAME}`)
  return true
}

// --- Phase 1: Device Selection ---

async function captureDeviceSelection(page: Page): Promise<void> {
  console.log('\n--- Phase 1: Device Selection ---')
  await capture(page, 'device-selection', { fullPage: true })
}

// --- Phase 2: Keymap Editor Overview ---

async function captureKeymapEditor(page: Page): Promise<void> {
  console.log('\n--- Phase 2: Keymap Editor ---')
  await capture(page, 'keymap-editor-overview', { fullPage: true })
}

// --- Phase 3: Layer Navigation ---

async function captureLayerNavigation(page: Page): Promise<void> {
  console.log('\n--- Phase 3: Layer Navigation ---')

  await capture(page, 'layer-0', { fullPage: true })

  const editorContent = page.locator('[data-testid="editor-content"]')

  for (const layerNum of [1, 2]) {
    const btn = editorContent.locator('button', { hasText: new RegExp(`^${layerNum}$`) })
    if (await isAvailable(btn)) {
      await btn.first().click()
      await page.waitForTimeout(500)
      await capture(page, `layer-${layerNum}`, { fullPage: true })
    }
  }

  const layer0Btn = editorContent.locator('button', { hasText: /^0$/ })
  if (await isAvailable(layer0Btn)) {
    await layer0Btn.first().click()
    await page.waitForTimeout(500)
  }
}

// --- Phase 4: Keycode Category Tabs ---

const KEYCODE_TABS = [
  { id: 'basic', label: 'Basic' },
  { id: 'layers', label: 'Layers' },
  { id: 'modifiers', label: 'Modifiers' },
  { id: 'tapDance', label: 'Tap-Hold / Tap Dance' },
  { id: 'macro', label: 'Macro' },
  { id: 'quantum', label: 'Quantum' },
  { id: 'media', label: 'Media' },
  { id: 'midi', label: 'MIDI' },
  { id: 'backlight', label: 'Lighting' },
  { id: 'user', label: 'User' },
]

async function captureKeycodeCategories(page: Page): Promise<void> {
  console.log('\n--- Phase 4: Keycode Categories ---')

  const editorContent = page.locator('[data-testid="editor-content"]')

  for (const tab of KEYCODE_TABS) {
    const tabBtn = editorContent.locator('button', { hasText: new RegExp(`^${escapeRegex(tab.label)}$`) })
    if (!(await isAvailable(tabBtn))) {
      console.log(`  [skip] Tab "${tab.label}" not found`)
      continue
    }
    await tabBtn.first().click()
    await page.waitForTimeout(300)
    await capture(page, `tab-${tab.id}`, { fullPage: true })
  }

  const basicBtn = editorContent.locator('button', { hasText: /^Basic$/ })
  if (await isAvailable(basicBtn)) {
    await basicBtn.first().click()
    await page.waitForTimeout(300)
  }
}

// --- Phase 5: Toolbar / Sidebar ---

async function captureSidebarTools(page: Page): Promise<void> {
  console.log('\n--- Phase 5: Toolbar ---')

  await capture(page, 'toolbar', { fullPage: true })

  const dualModeBtn = page.locator('[data-testid="dual-mode-button"]')
  if (await isAvailable(dualModeBtn)) {
    await dualModeBtn.click()
    await page.waitForTimeout(500)
    await capture(page, 'dual-mode', { fullPage: true })
    await dualModeBtn.click()
    await page.waitForTimeout(500)
  } else {
    console.log('  [skip] dual-mode-button not found')
  }

  const zoomInBtn = page.locator('[data-testid="zoom-in-button"]')
  if (await isAvailable(zoomInBtn)) {
    await zoomInBtn.click()
    await zoomInBtn.click()
    await page.waitForTimeout(300)
    await capture(page, 'zoom-in', { fullPage: true })
    const zoomOutBtn = page.locator('[data-testid="zoom-out-button"]')
    if (await isAvailable(zoomOutBtn)) {
      await zoomOutBtn.click()
      await zoomOutBtn.click()
    }
    await page.waitForTimeout(300)
  } else {
    console.log('  [skip] zoom-in-button not found')
  }

  const typingTestBtn = page.locator('[data-testid="typing-test-button"]')
  if (await isAvailable(typingTestBtn)) {
    await typingTestBtn.click()
    await page.waitForTimeout(1000)
    await capture(page, 'typing-test', { fullPage: true })
    await typingTestBtn.click()
    await page.waitForTimeout(500)
  } else {
    console.log('  [skip] typing-test-button not found')
  }
}

// --- Phase 6: Modal Editors ---

interface ModalCapture {
  name: string
  keycodeTab: string
  settingsTestId: string
  backdropPrefix: string
  detailTileTestId?: string
}

const MODAL_CAPTURES: ModalCapture[] = [
  {
    name: 'lighting',
    keycodeTab: 'Lighting',
    settingsTestId: 'lighting-settings-btn',
    backdropPrefix: 'lighting-modal',
  },
  {
    name: 'combo',
    keycodeTab: 'Quantum',
    settingsTestId: 'combo-settings-btn',
    backdropPrefix: 'combo-modal',
    detailTileTestId: 'combo-tile-0',
  },
  {
    name: 'key-override',
    keycodeTab: 'Quantum',
    settingsTestId: 'key-override-settings-btn',
    backdropPrefix: 'ko-modal',
    detailTileTestId: 'ko-tile-0',
  },
  {
    name: 'alt-repeat-key',
    keycodeTab: 'Quantum',
    settingsTestId: 'alt-repeat-key-settings-btn',
    backdropPrefix: 'ar-modal',
    detailTileTestId: 'ar-tile-0',
  },
]

async function openEditorModal(
  page: Page,
  keycodeTab: string,
  settingsTestId: string,
  backdropTestId: string,
): Promise<boolean> {
  const editorContent = page.locator('[data-testid="editor-content"]')
  const tabBtn = editorContent.locator('button', { hasText: new RegExp(`^${escapeRegex(keycodeTab)}$`) })
  if (!(await isAvailable(tabBtn))) return false
  await tabBtn.first().click()
  await page.waitForTimeout(300)

  const settingsBtn = page.locator(`[data-testid="${settingsTestId}"]`)
  if (!(await isAvailable(settingsBtn))) return false
  await settingsBtn.click()

  try {
    await page.locator(`[data-testid="${backdropTestId}"]`).waitFor({ state: 'visible', timeout: 3000 })
    return true
  } catch {
    return false
  }
}

async function captureModalEditors(page: Page): Promise<void> {
  console.log('\n--- Phase 6: Modal Editors ---')

  for (const modal of MODAL_CAPTURES) {
    const backdropTestId = `${modal.backdropPrefix}-backdrop`
    if (!(await openEditorModal(page, modal.keycodeTab, modal.settingsTestId, backdropTestId))) {
      console.log(`  [skip] ${modal.name} modal not available`)
      continue
    }

    await capture(page, `${modal.name}-modal`, { fullPage: true })

    if (modal.detailTileTestId) {
      const tile = page.locator(`[data-testid="${modal.detailTileTestId}"]`)
      if (await isAvailable(tile)) {
        await tile.click()
        await page.waitForTimeout(300)
        await capture(page, `${modal.name}-detail`, { fullPage: true })
      }
    }

    await page.locator(`[data-testid="${modal.backdropPrefix}-close"]`).click()
    await page.waitForTimeout(300)
  }
}

// --- Phase 7: Editor Settings Panel ---

const EDITOR_SETTINGS_TABS = [
  { name: 'tools', labelEn: 'Tools', labelJa: 'ツール' },
  { name: 'data', labelEn: 'Data', labelJa: 'データ' },
]

async function captureEditorSettings(page: Page): Promise<void> {
  console.log('\n--- Phase 7: Editor Settings ---')

  const settingsBtn = page.locator('[data-testid="editor-settings-button"]')
  if (!(await isAvailable(settingsBtn))) {
    console.log('  [skip] editor-settings-button not found')
    return
  }

  await settingsBtn.click()
  await page.waitForTimeout(500)

  const backdrop = page.locator('[data-testid="editor-settings-backdrop"]')
  if (!(await isAvailable(backdrop))) return

  await capture(page, 'editor-settings-layers', { fullPage: true })

  for (const tab of EDITOR_SETTINGS_TABS) {
    // Try English first, then Japanese — handles both locales
    let tabBtn = backdrop.locator('button', { hasText: new RegExp(`^${escapeRegex(tab.labelEn)}$`) })
    if (!(await isAvailable(tabBtn))) {
      tabBtn = backdrop.locator('button', { hasText: new RegExp(`^${escapeRegex(tab.labelJa)}$`) })
    }
    if (await isAvailable(tabBtn)) {
      await tabBtn.click()
      await page.waitForTimeout(300)
      await capture(page, `editor-settings-${tab.name}`, { fullPage: true })
    }
  }

  await page.locator('[data-testid="editor-settings-close"]').click()
  await page.waitForTimeout(300)
}

// --- Phase 8: Status Bar ---

async function captureStatusBar(page: Page): Promise<void> {
  console.log('\n--- Phase 8: Status Bar ---')

  const statusBar = page.locator('[data-testid="status-bar"]')
  if (await isAvailable(statusBar)) {
    await capture(page, 'status-bar', { element: statusBar })
  } else {
    console.log('  [skip] status-bar not found')
  }
}

// --- Phase 9: Favorites ---

async function captureFavorites(page: Page): Promise<void> {
  console.log('\n--- Phase 9: Favorites ---')

  const editorContent = page.locator('[data-testid="editor-content"]')
  const tdTabLabel = 'Tap-Hold / Tap Dance'

  const tdTabBtn = editorContent.locator('button', { hasText: new RegExp(`^${escapeRegex(tdTabLabel)}$`) })
  if (!(await isAvailable(tdTabBtn))) {
    console.log(`  [skip] ${tdTabLabel} tab not found`)
    return
  }
  await tdTabBtn.first().click()
  await page.waitForTimeout(300)

  const tdEntry = page.locator('button', { hasText: new RegExp(`^${escapeRegex('TD(0)')}$`) })
  if (!(await isAvailable(tdEntry))) {
    console.log('  [skip] TD(0) entry not found')
    return
  }
  await tdEntry.first().click()
  await page.waitForTimeout(500)

  const tdBackdrop = page.locator('[data-testid="td-modal-backdrop"]')
  try {
    await tdBackdrop.waitFor({ state: 'visible', timeout: 3000 })
  } catch {
    console.log('  [skip] TD modal did not open')
    return
  }

  await capture(page, 'fav-button', { fullPage: true })

  const favBtn = page.locator('[data-testid="td-fav-btn"]')
  if (!(await isAvailable(favBtn))) {
    console.log('  [skip] Fav button not found')
    await page.locator('[data-testid="td-modal-close"]').click()
    await page.waitForTimeout(300)
    return
  }
  await favBtn.click()
  await page.waitForTimeout(500)

  const favBackdrop = page.locator('[data-testid="favorite-store-modal-backdrop"]')
  try {
    await favBackdrop.waitFor({ state: 'visible', timeout: 3000 })
  } catch {
    console.log('  [skip] Favorite modal did not open')
    await page.locator('[data-testid="td-modal-close"]').click()
    await page.waitForTimeout(300)
    return
  }

  await capture(page, 'fav-modal', { fullPage: true })

  await page.locator('[data-testid="favorite-store-modal-close"]').click()
  await page.waitForTimeout(300)
  await page.locator('[data-testid="td-modal-close"]').click()
  await page.waitForTimeout(300)
}

// --- Main ---

async function main(): Promise<void> {
  mkdirSync(SCREENSHOT_DIR, { recursive: true })

  console.log('Launching Electron app...')
  const app = await electron.launch({
    args: [
      resolve(PROJECT_ROOT, 'out/main/index.js'),
      '--no-sandbox',
      '--disable-gpu-sandbox',
    ],
    cwd: PROJECT_ROOT,
  })

  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.waitForTimeout(3000)

  try {
    await dismissNotificationModal(page)
    await captureDeviceSelection(page)

    const connected = await connectDevice(page)
    if (!connected) {
      console.log('Failed to connect. Only device selection screenshots captured.')
      return
    }

    await captureKeymapEditor(page)
    await captureLayerNavigation(page)
    await captureKeycodeCategories(page)
    await captureSidebarTools(page)
    await captureModalEditors(page)
    await captureEditorSettings(page)
    await captureStatusBar(page)
    await captureFavorites(page)

    console.log(`\nAll screenshots saved to: ${SCREENSHOT_DIR}`)
  } finally {
    await app.close()
  }
}

main().catch((err: unknown) => {
  console.error('Script failed:', err)
  process.exit(1)
})
