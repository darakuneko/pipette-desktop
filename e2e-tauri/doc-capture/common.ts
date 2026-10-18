// SPDX-License-Identifier: GPL-2.0-or-later
//
// The steps the screenshot captures share: saving a screenshot, connecting
// the virtual keyboard and clearing its unlock dialog, getting back to the
// keymap editor, the keycodes overlay, the startup notice, and picking a
// keyboard or a keymap snapshot in Analyze.

import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { UNLOCK_KEYS, virtualDevice } from '../helpers/app'
import { screenshotDir } from './capture-paths'
import type { Locator, Page } from './page'

export async function isAvailable(locator: Locator): Promise<boolean> {
  return (await locator.count()) > 0
}

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

// --- Screenshots -------------------------------------------------------------

let outputDir: string | null = null
let screenshotCounter = 0

/** The directory the screenshots of this run go to ({@link screenshotDir}),
 *  made on first use. */
export function outputDirectory(): string {
  if (outputDir === null) {
    outputDir = screenshotDir()
    mkdirSync(outputDir, { recursive: true })
  }
  return outputDir
}

interface ShotOptions {
  element?: Locator
  /** Kept for the capture steps' sake: the app's page never scrolls as a
   *  whole, so a page screenshot is the full page. */
  fullPage?: boolean
}

async function takeScreenshot(page: Page, filename: string, label: string, opts?: ShotOptions): Promise<void> {
  const path = resolve(outputDirectory(), filename)
  if (opts?.element) {
    await opts.element.screenshot({ path })
  } else {
    await page.screenshot({ path })
  }
  console.log(`  [${label}] ${filename}`)
}

/** Saves `NN-name.png`, numbered in the order of the run, for the
 *  screenshots the operation guide walks through. */
export async function capture(page: Page, name: string, opts?: ShotOptions): Promise<void> {
  screenshotCounter++
  const num = String(screenshotCounter).padStart(2, '0')
  await takeScreenshot(page, `${num}-${name}.png`, num, opts)
}

/** Saves `name.png`, for the screenshots of a state other pages refer to. */
export async function captureNamed(page: Page, name: string, opts?: ShotOptions): Promise<void> {
  await takeScreenshot(page, `${name}.png`, '--', opts)
}

// --- Device and unlock -------------------------------------------------------

/**
 * Connect to a device by its device-selector display name. Returns false
 * (without throwing) if the device never shows up, so callers can decide
 * whether to throw, skip, or fall back.
 *
 * `raceNoDeviceMessage` first races the device list against the
 * no-device-message empty state so an empty selector fails fast instead of
 * burning the full button timeout.
 */
export async function connectToDevice(
  page: Page,
  deviceName: string,
  opts: { timeoutMs?: number; raceNoDeviceMessage?: boolean } = {},
): Promise<boolean> {
  const { timeoutMs = 30_000, raceNoDeviceMessage = false } = opts

  if (raceNoDeviceMessage) {
    const deviceList = page.locator('[data-testid="device-list"]')
    const noDeviceMsg = page.locator('[data-testid="no-device-message"]')
    try {
      await Promise.any([
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
  }

  const deviceBtn = page
    .locator('[data-testid="device-button"]')
    .filter({ has: page.locator('.font-semibold', { hasText: new RegExp(`^${escapeRegex(deviceName)}$`) }) })

  try {
    await deviceBtn.waitFor({ state: 'visible', timeout: timeoutMs })
  } catch {
    console.log(`Device "${deviceName}" not found.`)
    return false
  }
  await deviceBtn.click()
  await page.locator('[data-testid="editor-content"]').waitFor({ state: 'visible', timeout: 20_000 })
  await page.waitForTimeout(2000)
  return true
}

/** Locator for the Unlock dialog's heading — the shared "is the unlock
 *  dialog up?" probe for every capture. */
export function unlockDialogHeading(page: Page): Locator {
  return page.locator('h2', { hasText: /Unlock|unlock|アンロック/ })
}

/** Clears the unlock dialog, if it is up, by holding the virtual keyboard's
 *  unlock combo through the development tools' commands (it has no close
 *  button; it clears once the firmware sees the combo held long enough). */
export async function waitForUnlockDialog(page: Page): Promise<void> {
  const unlockHeading = unlockDialogHeading(page)
  if (!(await isAvailable(unlockHeading))) return

  console.log('  Unlock dialog detected — unlocking via the virtual keyboard...')
  try {
    await virtualDevice.setUnlockCounterMax(3)
    await virtualDevice.holdKeys(UNLOCK_KEYS)
    await unlockHeading.waitFor({ state: 'detached', timeout: 15_000 })
    console.log('  Keyboard unlocked!')
  } catch {
    console.log('  [warn] Unlock timed out')
  } finally {
    // Always release the combo — a timeout above would otherwise leave the
    // virtual keys held down for the rest of the capture session.
    await virtualDevice.releaseAll().catch(() => { /* app may be gone */ })
  }
  await page.waitForTimeout(500)
}

/**
 * Click a control whose action is gated behind the keyboard unlock (Typing
 * Test toggle, View-Only toggle, ...) and clear the Unlock dialog it pops
 * on the still-locked virtual keyboard, which relocks on every launch.
 */
export async function clickThroughUnlock(page: Page, locator: Locator): Promise<void> {
  await locator.click()
  await waitForUnlockDialog(page)
}

/**
 * Restore the Editor view when a persisted view mode (Typing View or Typing
 * Test, restored on connect) left the device outside it. The virtual
 * keyboard is locked on every launch, so such a mode can also surface the
 * Unlock dialog on connect. Call this after `waitForUnlockDialog` so every
 * capture starts from the same known state. Uses the locale-stable
 * `data-active`/testid attributes instead of i18n-dependent label text.
 */
export async function resetToEditorMode(page: Page): Promise<void> {
  const typingTestBtn = page.locator('[data-testid="typing-test-button"]')
  if (!(await typingTestBtn.isVisible().catch(() => false))) {
    console.log('  [reset] Typing View detected, exiting back to editor...')
    // Open the menu pane (popup is closed by default after launch) so the
    // view-only-toggle becomes interactive.
    await page.locator('body').click({ position: { x: 400, y: 300 } })
    await page.waitForTimeout(400)
    const viewOnlyExit = page.locator('[data-testid="view-only-toggle"]')
    if (await viewOnlyExit.isVisible().catch(() => false)) {
      await viewOnlyExit.click({ force: true })
      await page.waitForTimeout(800)
    } else {
      console.log('  [warn] view-only-toggle not found; continuing anyway')
    }
  }
  const typingTestView = page.locator('[data-testid="typing-test-view"]')
  if (await typingTestView.isVisible().catch(() => false)) {
    console.log('  [reset] Typing Test detected, exiting back to editor...')
    await typingTestBtn.click().catch(() => {})
    await page.waitForTimeout(800)
  }
}

/**
 * Entering Typing Test mode starts in a 3s "countdown" state that renders a
 * Loading... placeholder instead of the word list. Waiting for 'detached'
 * alone races: it resolves immediately when the countdown hasn't mounted
 * yet. So first wait for it to appear (tolerating that it may already be
 * gone, or never shown), then wait for it to detach so the caller's next
 * screenshot shows words instead of the placeholder.
 */
export async function waitForTypingTestCountdown(page: Page): Promise<void> {
  const countdown = page.locator('[data-testid="typing-test-countdown"]')
  await countdown.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {
    /* countdown already over, or view skipped it */
  })
  await countdown.waitFor({ state: 'detached', timeout: 10000 }).catch(() => {
    console.log('  [warn] typing-test countdown did not end within 10s')
  })
}

/**
 * Close the startup notice modal if it is up. The session's notice address
 * is one nothing listens on (driver.ts), so no notice is fetched; this only
 * keeps a stray modal from covering a later screenshot.
 */
export async function dismissNotificationModal(page: Page): Promise<void> {
  const backdrop = page.locator('[data-testid="notification-modal-backdrop"]')
  if (!(await backdrop.isVisible())) return
  console.log('Dismissing notification modal...')
  const closeBtn = page.locator('[data-testid="notification-modal-close"]')
  if (await isAvailable(closeBtn)) {
    await closeBtn.click()
  } else {
    await backdrop.click({ position: { x: 10, y: 10 } })
  }
  await page.waitForTimeout(500)
}

// --- Keycodes overlay --------------------------------------------------------

/** Selector for the keycode picker's Menu-overlay toggle button, shared by
 *  every function below that opens/closes/inspects that overlay. */
const KEYCODES_OVERLAY_TOGGLE_SELECTOR = 'button[aria-controls="keycodes-overlay-panel"]'

/**
 * Open the keycode picker's Menu overlay (`keycodes-overlay-panel`) if it's
 * currently closed. Reads `aria-expanded` first so this is idempotent —
 * the toggle button has no separate open/close affordance, just one button
 * that flips state, so calling this on an already-open overlay must be a
 * no-op rather than close it again. Returns false without throwing if the
 * toggle isn't in the DOM at all: Typing Test and View Matrix mode unmount
 * the whole keycode picker, overlay included (see KeymapEditor.tsx).
 */
export async function openKeycodesOverlay(page: Page): Promise<boolean> {
  const toggle = page.locator(KEYCODES_OVERLAY_TOGGLE_SELECTOR)
  if (!(await isAvailable(toggle))) return false
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click()
    await page.waitForTimeout(500)
  }
  return true
}

/** Close the Menu overlay opened by `openKeycodesOverlay`, if it's open.
 *  Same idempotent toggle-button read, mirrored for the close direction. */
export async function closeKeycodesOverlay(page: Page): Promise<void> {
  const toggle = page.locator(KEYCODES_OVERLAY_TOGGLE_SELECTOR)
  if (!(await isAvailable(toggle))) return
  if ((await toggle.getAttribute('aria-expanded')) === 'true') {
    await toggle.click()
    await page.waitForTimeout(300)
  }
}

/** Standard "the overlay tab wasn't there" message body, shared by every
 *  capture that skips (log + return) or aborts (throw) when
 *  `openOverlayTab` returns false. */
export function overlayTabNotFoundMessage(tab: 'layout' | 'tools' | 'data'): string {
  return `overlay-tab-${tab} not found`
}

/**
 * Open the Menu overlay and switch to `tab`. Returns false immediately —
 * without waiting out a timeout — when the toggle or the tab isn't
 * available, so a misconfigured capture (e.g. a keyboard without layout
 * options) fails fast instead of hanging on a locator that will never
 * appear.
 */
export async function openOverlayTab(page: Page, tab: 'layout' | 'tools' | 'data'): Promise<boolean> {
  if (!(await openKeycodesOverlay(page))) return false

  const tabBtn = page.locator(`[data-testid="overlay-tab-${tab}"]`)
  // The panel only renders a tab *bar* (and with it, `overlay-tab-tools`)
  // once there are 2+ tabs. With `tools` as the sole tab there's no button
  // to click, but its content is already the active one.
  if ((await tabBtn.count()) === 0) return tab === 'tools'
  // Already selected: skip the click (and its settle wait) so repeat calls
  // in the same session don't re-trigger the tab's mount effects.
  if ((await tabBtn.getAttribute('aria-selected')) === 'true') return true
  await tabBtn.click()
  await page.waitForTimeout(300)
  return true
}

// --- Analyze filter modal ----------------------------------------------------

/**
 * Select a specific keyboard (by uid) through the Analyze staged filter
 * modal (chip -> Keyboard row -> Apply). Polls for the option instead of
 * grabbing "whichever keyboard is first", so every Analyze capture lands on
 * the seeded keyboard. Leaves the modal closed either way.
 */
export async function selectKeyboardViaFilterModal(
  page: Page,
  uid: string,
  opts: { pollTimeoutMs?: number } = {},
): Promise<boolean> {
  const { pollTimeoutMs = 30_000 } = opts
  const chip = page.locator('[data-testid="analyze-filter-chip"]')
  if (!(await isAvailable(chip))) {
    console.log('  [skip] analyze-filter-chip not found — keyboard selection skipped')
    return false
  }
  await chip.click()
  await page.waitForTimeout(400)

  const option = page.locator(`[data-testid="analyze-kb-${uid}"]`)
  const deadline = Date.now() + pollTimeoutMs
  let found = false
  while (Date.now() < deadline) {
    if ((await option.count()) > 0) {
      found = true
      break
    }
    await page.waitForTimeout(500)
  }
  if (!found) {
    console.log(`  [warn] keyboard ${uid} not listed in Analyze — closing modal`)
    const modalClose = page.locator('[data-testid="analyze-filter-modal-close"]')
    if (await isAvailable(modalClose)) {
      await modalClose.click()
      await page.waitForTimeout(300)
    }
    return false
  }

  await page.locator('[data-testid="analyze-filter-keyboard"]').selectOption(uid)
  await page.waitForTimeout(300)
  await page.locator('[data-testid="analyze-filter-modal-apply"]').click()
  await page.waitForTimeout(600)
  return true
}

/**
 * Pick a keymap snapshot through the Analyze staged filter modal — the
 * modal's Keymap row is the only snapshot selector. `optionIndex`
 * addresses the modal select's option list (0 = "Current keymap",
 * 1 = newest older snapshot, ...).
 *
 * Returns false — after closing the modal untouched — when fewer than
 * `minOptions` options exist (e.g. a keyboard without enough snapshots),
 * so callers can fall back gracefully.
 */
export async function selectSnapshotViaFilterModal(
  page: Page,
  optionIndex: number,
  opts: { minOptions?: number; settleMs?: number } = {},
): Promise<boolean> {
  const { minOptions = 2, settleMs = 800 } = opts
  const chip = page.locator('[data-testid="analyze-filter-chip"]')
  if (!(await isAvailable(chip))) {
    console.log('  [skip] analyze-filter-chip not found — snapshot pivot skipped')
    return false
  }
  await chip.click()
  await page.waitForTimeout(400)
  const select = page.locator('[data-testid="analyze-snapshot-timeline-select"]')
  const optionCount = await select.locator('option').count().catch(() => 0)
  if (optionCount < minOptions || optionIndex >= optionCount) {
    const closeBtn = page.locator('[data-testid="analyze-filter-modal-close"]')
    if (await isAvailable(closeBtn)) await closeBtn.click()
    await page.waitForTimeout(200)
    return false
  }
  await select.selectOption({ index: optionIndex })
  await page.waitForTimeout(300)
  await page.locator('[data-testid="analyze-filter-modal-apply"]').click()
  await page.waitForTimeout(settleMs)
  return true
}
