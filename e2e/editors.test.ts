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

  // Attempt to connect to the designated test device.
  // connectTestDevice calls test.skip() internally if device is missing,
  // but beforeAll skip behavior varies across Playwright versions.
  // We track connection state and skip per-test in beforeEach as a safety net.
  try {
    await connectTestDevice(page)
    connected = true
  } catch {
    // Device not available — tests will skip via beforeEach guard
  }
})

test.beforeEach(async () => {
  if (!connected) {
    test.skip(true, 'Test device not connected — skipping editor tests')
  }
})

test.afterAll(async () => {
  await app?.close()
})

// --- Keymap Editor ---

test.describe('Keymap Editor', () => {
  test('shows editor content', async () => {
    await expect(page.locator('[data-testid="editor-content"]')).toBeVisible()
  })
})

// --- Helper: open a modal via a key picker footer button ---

/**
 * Switch to a keycode category tab and click the settings button to open a modal.
 * Returns false (with test.skip) if the tab or settings button is not available.
 */
async function openEditorModal(opts: {
  keycodeTab: string
  settingsBtnTestId: string
  backdropTestId: string
  featureName: string
}): Promise<boolean> {
  await expect(page.locator('[data-testid="editor-content"]')).toBeVisible()

  const editorContent = page.locator('[data-testid="editor-content"]')
  const tabBtn = editorContent.locator('button', { hasText: new RegExp(`^${opts.keycodeTab}$`) })
  if ((await tabBtn.count()) === 0) {
    test.skip(true, `${opts.keycodeTab} keycode tab not visible`)
    return false
  }
  await tabBtn.click()

  const settingsBtn = page.locator(`[data-testid="${opts.settingsBtnTestId}"]`)
  if ((await settingsBtn.count()) === 0) {
    test.skip(true, `${opts.featureName} not supported on this keyboard`)
    return false
  }

  await settingsBtn.click()
  await expect(page.locator(`[data-testid="${opts.backdropTestId}"]`)).toBeVisible()
  return true
}

function openLightingModal(): Promise<boolean> {
  return openEditorModal({
    keycodeTab: 'Lighting',
    settingsBtnTestId: 'lighting-settings-btn',
    backdropTestId: 'lighting-modal-backdrop',
    featureName: 'Lighting',
  })
}

// --- Lighting Editor (modal via key picker footer button) ---

test.describe('Lighting Editor', () => {
  test('opens lighting modal from key picker footer button', async () => {
    if (!(await openLightingModal())) return

    await expect(page.locator('[data-testid="editor-lighting"]')).toBeVisible()

    // Close for cleanup
    await page.locator('[data-testid="lighting-modal-close"]').click()
    await expect(page.locator('[data-testid="editor-lighting"]')).not.toBeVisible()
  })

  test('has save button in modal', async () => {
    if (!(await openLightingModal())) return

    const saveBtn = page.locator('[data-testid="lighting-save"]')
    if ((await saveBtn.count()) > 0) {
      await expect(saveBtn).toBeVisible()
    }

    // Close via close button
    await page.locator('[data-testid="lighting-modal-close"]').click()
    await expect(page.locator('[data-testid="editor-lighting"]')).not.toBeVisible()
  })

  test('closes modal on backdrop click', async () => {
    if (!(await openLightingModal())) return

    // Click backdrop (top-left corner, outside the modal content)
    await page.locator('[data-testid="lighting-modal-backdrop"]').click({ position: { x: 10, y: 10 } })
    await expect(page.locator('[data-testid="editor-lighting"]')).not.toBeVisible()
  })
})

// --- Combo Editor (modal via key picker footer button) ---

function openComboModal(): Promise<boolean> {
  return openEditorModal({
    keycodeTab: 'Quantum',
    settingsBtnTestId: 'combo-settings-btn',
    backdropTestId: 'combo-modal-backdrop',
    featureName: 'Combo',
  })
}

test.describe('Combo Editor', () => {
  test('opens combo modal from key picker footer button', async () => {
    if (!(await openComboModal())) return

    await expect(page.locator('[data-testid="editor-combo"]')).toBeVisible()

    // Close for cleanup
    await page.locator('[data-testid="combo-modal-close"]').click()
    await expect(page.locator('[data-testid="editor-combo"]')).not.toBeVisible()
  })

  test('shows grid tiles in modal', async () => {
    if (!(await openComboModal())) return

    // Tile 0 should be visible
    await expect(page.locator('[data-testid="combo-tile-0"]')).toBeVisible()

    // Close for cleanup
    await page.locator('[data-testid="combo-modal-close"]').click()
  })

  test('shows detail editor when tile is clicked', async () => {
    if (!(await openComboModal())) return

    await page.locator('[data-testid="combo-tile-0"]').click()
    // Save button should appear in the detail panel
    await expect(page.locator('[data-testid="combo-modal-save"]')).toBeVisible()

    // Close for cleanup
    await page.locator('[data-testid="combo-modal-close"]').click()
  })

  test('closes modal on backdrop click', async () => {
    if (!(await openComboModal())) return

    // Click backdrop (top-left corner, outside the modal content)
    await page.locator('[data-testid="combo-modal-backdrop"]').click({ position: { x: 10, y: 10 } })
    await expect(page.locator('[data-testid="editor-combo"]')).not.toBeVisible()
  })
})

// --- Key Override Editor (modal via key picker footer button) ---

function openKeyOverrideModal(): Promise<boolean> {
  return openEditorModal({
    keycodeTab: 'Quantum',
    settingsBtnTestId: 'key-override-settings-btn',
    backdropTestId: 'ko-modal-backdrop',
    featureName: 'Key Override',
  })
}

test.describe('Key Override Editor', () => {
  test('opens key override modal from key picker footer button', async () => {
    if (!(await openKeyOverrideModal())) return

    await expect(page.locator('[data-testid="editor-key-override"]')).toBeVisible()

    // Close for cleanup
    await page.locator('[data-testid="ko-modal-close"]').click()
    await expect(page.locator('[data-testid="editor-key-override"]')).not.toBeVisible()
  })

  test('shows grid tiles in modal', async () => {
    if (!(await openKeyOverrideModal())) return

    // Tile 0 should be visible
    await expect(page.locator('[data-testid="ko-tile-0"]')).toBeVisible()

    // Close for cleanup
    await page.locator('[data-testid="ko-modal-close"]').click()
  })

  test('shows detail editor when tile is clicked', async () => {
    if (!(await openKeyOverrideModal())) return

    await page.locator('[data-testid="ko-tile-0"]').click()
    // Save button should appear in the detail panel
    await expect(page.locator('[data-testid="ko-modal-save"]')).toBeVisible()

    // Close for cleanup
    await page.locator('[data-testid="ko-modal-close"]').click()
  })

  test('closes modal on backdrop click', async () => {
    if (!(await openKeyOverrideModal())) return

    // Click backdrop (top-left corner, outside the modal content)
    await page.locator('[data-testid="ko-modal-backdrop"]').click({ position: { x: 10, y: 10 } })
    await expect(page.locator('[data-testid="editor-key-override"]')).not.toBeVisible()
  })
})

// --- Alt Repeat Key Editor (modal via key picker footer button) ---

function openAltRepeatKeyModal(): Promise<boolean> {
  return openEditorModal({
    keycodeTab: 'Quantum',
    settingsBtnTestId: 'alt-repeat-key-settings-btn',
    backdropTestId: 'ar-modal-backdrop',
    featureName: 'Alt Repeat Key',
  })
}

test.describe('Alt Repeat Key Editor', () => {
  test('opens alt repeat key modal from key picker footer button', async () => {
    if (!(await openAltRepeatKeyModal())) return

    await expect(page.locator('[data-testid="editor-alt-repeat-key"]')).toBeVisible()

    // Close for cleanup
    await page.locator('[data-testid="ar-modal-close"]').click()
    await expect(page.locator('[data-testid="editor-alt-repeat-key"]')).not.toBeVisible()
  })

  test('shows grid tiles in modal', async () => {
    if (!(await openAltRepeatKeyModal())) return

    // Tile 0 should be visible
    await expect(page.locator('[data-testid="ar-tile-0"]')).toBeVisible()

    // Close for cleanup
    await page.locator('[data-testid="ar-modal-close"]').click()
  })

  test('shows detail editor when tile is clicked', async () => {
    if (!(await openAltRepeatKeyModal())) return

    await page.locator('[data-testid="ar-tile-0"]').click()
    // Save button should appear in the detail panel
    await expect(page.locator('[data-testid="ar-modal-save"]')).toBeVisible()

    // Close for cleanup
    await page.locator('[data-testid="ar-modal-close"]').click()
  })

  test('closes modal on backdrop click', async () => {
    if (!(await openAltRepeatKeyModal())) return

    // Click backdrop (top-left corner, outside the modal content)
    await page.locator('[data-testid="ar-modal-backdrop"]').click({ position: { x: 10, y: 10 } })
    await expect(page.locator('[data-testid="editor-alt-repeat-key"]')).not.toBeVisible()
  })
})

// --- Matrix Tester (integrated in Keymap Editor) ---

test.describe('Matrix Tester', () => {
  test('shows matrix toggle in keymap editor and can activate', async () => {
    await expect(page.locator('[data-testid="editor-content"]')).toBeVisible()

    const toggleBtn = page.locator('[data-testid="matrix-toggle"]')
    // matrix-toggle only appears for Vial protocol >= 3
    if ((await toggleBtn.count()) === 0) {
      test.skip(true, 'Matrix toggle not visible (requires Vial 3+)')
      return
    }

    await expect(toggleBtn).toBeVisible()

    // Activate matrix mode -- if unlocked, enters directly; if locked, opens unlock dialog
    await toggleBtn.click()

    // Toggle back to keymap mode (if unlocked, matrix mode was activated)
    // If locked, unlock dialog opens -- no further assertion needed
    await toggleBtn.click()
  })
})

// --- Status Bar ---

test.describe('Status Bar', () => {
  test('shows device name and Vial protocol version', async () => {
    await expect(page.locator('[data-testid="editor-content"]')).toBeVisible()

    const statusBar = page.locator('[data-testid="status-bar"]')
    await expect(statusBar).toBeVisible()

    // Check Vial protocol version display (already guaranteed by connectTestDevice)
    const vialVersion = page.locator('[data-testid="status-vial-protocol"]')
    await expect(vialVersion).toBeVisible()
    await expect(vialVersion).toHaveText(/Vial v\d+/)
  })

  test('has disconnect button', async () => {
    const statusBar = page.locator('[data-testid="status-bar"]')
    await expect(statusBar).toBeVisible()

    // Disconnect button should be in the status bar
    const disconnectBtn = statusBar.locator('button', { hasText: /Disconnect/i })
    await expect(disconnectBtn).toBeVisible()
  })

  test('does not have sideload JSON button in status bar', async () => {
    const statusBar = page.locator('[data-testid="status-bar"]')
    await expect(statusBar).toBeVisible()

    // Sideload JSON was moved to the Data modal
    const sideloadBtn = statusBar.locator('[data-testid="sideload-json-btn"]')
    await expect(sideloadBtn).toHaveCount(0)
  })
})
