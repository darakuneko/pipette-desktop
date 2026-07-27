// SPDX-License-Identifier: GPL-2.0-or-later
//
// Regression coverage for PR #316: Auto Move carries the key popover to the
// next key without unmounting it. This drives the real Auto Move path
// through the software-emulated Virtual Keyboard device (no real hardware
// required) and asserts against internal popover state that only resets on
// a genuine remount — a plain `keymap`/props assertion would pass whether
// or not the fix is in place, since the displayed value is always resolved
// from the (correct) target position regardless of remount.

import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { launchApp } from './helpers/electron'
import {
  backupVirtualDeviceSettings,
  connectToDevice,
  dismissNotificationModal,
  isAvailable,
  nullifyLastDeviceConfig,
  resetToEditorMode,
  restoreLastDeviceConfig,
  restoreVirtualDeviceSettings,
  VIRTUAL_DEVICE_DISPLAY_NAME,
  waitForUnlockDialog,
  type LastDeviceBackup,
  type VirtualDeviceSettingsBackup,
} from './helpers/doc-capture-common'

const SCREENSHOT_DIR = resolve(import.meta.dirname, 'screenshots')
const DEVICE_NAME = VIRTUAL_DEVICE_DISPLAY_NAME

let app: ElectronApplication
let page: Page
let lastDeviceBackup: LastDeviceBackup
let virtualDeviceSettingsBackup: VirtualDeviceSettingsBackup

test.beforeAll(async () => {
  const launched = await launchApp({
    env: { PIPETTE_VIRTUAL_DEVICE: 'only' },
    // e2e Electron sessions share ~/.config/Electron across runs (unlike
    // doc-capture's launchCaptureApp, which gets an isolated profile). A
    // `lastDevice` persisted by an earlier run's `restoreLastSession` would
    // otherwise skip the device-selector screen entirely and reconnect
    // straight into the editor before we get a chance to pick "Virtual
    // Keyboard" ourselves — see tray-start-unlock.test.ts for the same
    // gotcha and doc-capture-common.ts's own doc comment on this helper.
    onMainReady: async ({ userDataPath }) => {
      lastDeviceBackup = nullifyLastDeviceConfig(userDataPath)
      // ensureAutoMoveOn() below flips Auto Move on, and that toggle is
      // persisted into the virtual device's pipette_settings.json (same
      // store a real keyboard uses) — not just in-memory React state. Back
      // it up here so afterAll can restore it and this run doesn't leave a
      // real developer's Auto Move preference flipped on behind their back.
      virtualDeviceSettingsBackup = backupVirtualDeviceSettings(userDataPath)
    },
  })
  app = launched.app
  page = launched.page

  await dismissNotificationModal(page, { waitForAppearMs: 3_000 })

  const connected = await connectToDevice(page, DEVICE_NAME)
  if (!connected) throw new Error(`Device "${DEVICE_NAME}" not found`)

  await dismissNotificationModal(page)
  // Same defensive order as doc-capture-key-popover.ts: a viewMode
  // persisted from an earlier run can surface the Unlock dialog via the
  // auto-restore effect before we touch anything ourselves.
  await waitForUnlockDialog(app, page)
  await dismissNotificationModal(page)
  await resetToEditorMode(page)

  const editorContent = page.locator('[data-testid="editor-content"]')
  const layer0Btn = editorContent.locator('button', { hasText: /^0$/ })
  if (await isAvailable(layer0Btn)) {
    await layer0Btn.first().click()
    await page.waitForTimeout(300)
  }
  const basicBtn = editorContent.locator('button', { hasText: /^Basic$/ })
  if (await isAvailable(basicBtn)) {
    await basicBtn.first().click()
    await page.waitForTimeout(300)
  }
})

test.afterAll(async () => {
  await app?.close()
  // Restore after close — window-state saves on quit rewrite config.json,
  // so restoring first would just be overwritten by that later write.
  if (lastDeviceBackup) restoreLastDeviceConfig(lastDeviceBackup)
  // Undo the Auto Move persistence from ensureAutoMoveOn() so this test run
  // doesn't leave the virtual device's settings file changed on disk.
  if (virtualDeviceSettingsBackup) restoreVirtualDeviceSettings(virtualDeviceSettingsBackup)
})

/** Saves a full-page screenshot for local visual review only. CI runners
 *  don't upload these anywhere and there's no pixel comparison against
 *  them, so writing them there is pure waste — skip on CI and keep the
 *  local-inspection workflow. */
async function capture(name: string): Promise<void> {
  if (process.env.CI) return
  mkdirSync(SCREENSHOT_DIR, { recursive: true })
  await page.screenshot({ path: resolve(SCREENSHOT_DIR, `${name}.png`), fullPage: true })
}

/** Opens the keycode picker's Menu overlay and switches to the Tools tab —
 *  same `aria-controls="keycodes-overlay-panel"` button doc-capture-overlay-
 *  tools.ts and virtual-device.test.ts already rely on for this panel. */
async function openToolsTab(): Promise<void> {
  const menuButton = page.locator('button[aria-controls="keycodes-overlay-panel"]')
  const isExpanded = await menuButton.getAttribute('aria-expanded')
  if (isExpanded !== 'true') {
    await menuButton.click()
    await page.waitForTimeout(300)
  }
  await page.locator('[data-testid="overlay-tab-tools"]').click()
  await page.waitForTimeout(200)
}

async function closeMenuIfOpen(): Promise<void> {
  const menuButton = page.locator('button[aria-controls="keycodes-overlay-panel"]')
  const isExpanded = await menuButton.getAttribute('aria-expanded')
  if (isExpanded === 'true') {
    await menuButton.click()
    await page.waitForTimeout(300)
  }
}

/** Turns Auto Move on if it isn't already — never writes the settings file
 *  directly (virtual-device uid/userData layout is an implementation
 *  detail the test shouldn't depend on). */
async function ensureAutoMoveOn(): Promise<void> {
  await openToolsTab()
  const toggle = page.locator('[data-testid="overlay-auto-advance-toggle"]')
  await expect(toggle).toBeVisible()
  const checked = await toggle.getAttribute('aria-checked')
  if (checked !== 'true') {
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
  }
  await closeMenuIfOpen()
}

async function openPopoverOnFirstKey(): Promise<void> {
  const editorContent = page.locator('[data-testid="editor-content"]')
  const keyLabel = editorContent.locator('svg text').first()
  await expect(keyLabel).toBeVisible()
  await page.evaluate(() => window.scrollTo(0, 0))
  await keyLabel.evaluate((el) => {
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
  })
  await expect(page.locator('[data-testid="key-popover"]')).toBeVisible()
}

/** Closes the popover via its close button and confirms it's gone — the
 *  standard teardown every test in this file ends with. */
async function closePopover(): Promise<void> {
  await page.locator('[data-testid="popover-close"]').click()
  await expect(page.locator('[data-testid="key-popover"]')).not.toBeVisible()
}

test.describe('Key popover behavior', { tag: '@virtual' }, () => {
  test('Auto Move does not carry the previous key\'s wrapper mode onto a plain landed key', async () => {
    // Without the fix, `wrapperMode` is React state that survives the
    // follow-along (no remount), so switching into Mod-Mask on the source
    // key would still show the Mod-Mask checkbox strip after landing on a
    // key whose own current keycode is plain — the exact "still showing
    // the previous one" bug PR #316 describes, just on the mode-button
    // wrapper instead of the Code-tab value (which is prop-driven and
    // would look correct either way).
    await ensureAutoMoveOn()
    await openPopoverOnFirstKey()
    const popover = page.locator('[data-testid="key-popover"]')
    const startKey = await popover.getAttribute('data-popover-target-key')

    // Switch the source key into Mod-Mask mode — a non-confirm raw call
    // (see handleModeSwitch's `advance: false`), so the popover stays put
    // and now shows the modifier checkbox strip.
    await page.locator('[data-testid="popover-mode-mod-mask"]').click()
    await expect(page.locator('[data-testid="modifier-checkbox-strip"]')).toBeVisible()

    // Confirm a plain keycode pick while still in Mod-Mask mode (wraps it
    // into a Mod-Mask keycode, a genuine confirm) — Auto Move advances to
    // the next key.
    const result = page.locator('[data-testid^="popover-result-"]').first()
    await result.click()
    await page.keyboard.press('Enter')
    await expect
      .poll(async () => popover.getAttribute('data-popover-target-key'))
      .not.toBe(startKey)

    // The landed key's own current keycode is plain (never touched by this
    // test before now), so a fresh mount detects wrapperMode 'none' and
    // hides the strip. A stale wrapperMode carried over from the source
    // key would leave it visible.
    await expect(page.locator('[data-testid="modifier-checkbox-strip"]')).not.toBeVisible()

    await capture('auto-move-follow-along')
    await closePopover()
  })

  test('layer sidebar keeps the Code tab active while the target layer changes', async () => {
    await openPopoverOnFirstKey()

    const popover = page.locator('[data-testid="key-popover"]')
    const startLayer = await popover.getAttribute('data-popover-target-layer')

    await page.locator('[data-testid="popover-tab-code"]').click()
    const hexInput = page.locator('[data-testid="popover-hex-input"]')
    await expect(hexInput).toBeVisible()

    const layer1Btn = page.locator('[data-testid="popover-layer-1"]')
    await expect(layer1Btn).toBeVisible()
    await layer1Btn.click()

    // Code tab must survive the layer switch (it's the same KeyPopover
    // instance — only the layer sidebar effect re-derives state, it does
    // not remount and reset activeTab).
    await expect(hexInput).toBeVisible()

    // The layer itself did switch (from whatever layer0Btn left us on in
    // beforeAll, to layer 1).
    expect(startLayer).not.toBe('1')
    await expect(popover).toHaveAttribute('data-popover-target-layer', '1')

    await capture('layer-sidebar-code-tab')
    await closePopover()
  })
})
