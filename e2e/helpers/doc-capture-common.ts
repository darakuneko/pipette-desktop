// SPDX-License-Identifier: GPL-2.0-or-later

// Shared helpers for doc-capture scripts.
// Deduplicates the notification-modal dismissal, overlay dismissal,
// availability-check, and virtual-device connect/unlock logic that was
// previously copy-pasted across every doc-capture helper.

import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const PROJECT_ROOT = resolve(import.meta.dirname, '../..')

export async function isAvailable(locator: Locator): Promise<boolean> {
  return (await locator.count()) > 0
}

/**
 * Launch the production build with the virtual GPK60-63R for a doc-capture
 * session. Strips ELECTRON_RENDERER_URL like e2e/helpers/electron.ts does,
 * so a stray dev-server env var left over from another run can't leak into
 * this production-build capture (captures must never run against a dev
 * renderer, so unlike launchApp there is deliberately no E2E_MODE escape
 * hatch). PIPETTE_VIRTUAL_DEVICE='only' swaps in the software emulator and
 * hides real HID hardware, making every capture reproducible on any
 * workstation.
 *
 * Returns the app only — callers own firstWindow/viewport setup because
 * some (doc-capture.ts) must seed userData files before the renderer loads.
 *
 * `opts.env` is merged last so a helper can add capture-specific vars
 * (e.g. the local-hub test triple in doc-capture-hub.ts).
 */
export async function launchCaptureApp(
  opts: { env?: Record<string, string> } = {},
): Promise<ElectronApplication> {
  const { ELECTRON_RENDERER_URL: _stripped, ...cleanEnv } = process.env
  return electron.launch({
    args: [
      resolve(PROJECT_ROOT, 'out/main/index.js'),
      '--no-sandbox',
      '--disable-gpu-sandbox',
    ],
    cwd: PROJECT_ROOT,
    env: {
      ...cleanEnv,
      PIPETTE_VIRTUAL_DEVICE: 'only',
      ...opts.env,
    },
  })
}

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

// The virtual device's uid as the app stores it on disk: u64 LE hex of
// VIRTUAL_DEVICE_UID_BYTES ("VIRTGPK\0") — see src/main/virtual-device/gpk60-63r.ts
// and readLE64Hex in src/preload/protocol.ts.
export const VIRTUAL_DEVICE_UID = '0x004b504754524956'

// The virtual device's device-selector display name — mirrors
// VIRTUAL_DEVICE_NAME in src/main/virtual-device/gpk60-63r.ts. Centralized
// here since every doc-capture helper (and the virtual-device e2e test) that
// connects to the emulator needs the same string.
export const VIRTUAL_DEVICE_DISPLAY_NAME = 'Virtual Keyboard'

/** Snapshot of a single file's content, as found on disk before a capture
 *  helper seeds or modifies it (or an absent-file marker). The shared
 *  backup/restore shape behind every doc-capture seed helper that needs to
 *  leave a file exactly as it found it (virtual-device settings, a
 *  downloaded language pack, ...). */
export interface FileBackup {
  path: string
  content: string | null
}

/** Snapshots `path`'s content (or records that it didn't exist yet) before
 *  a capture helper seeds or modifies it. Pass the result to `restoreFile`
 *  in a `finally` block once the capture run is done. */
export function backupFile(path: string): FileBackup {
  return { path, content: existsSync(path) ? readFileSync(path, 'utf-8') : null }
}

/** Restores the file snapshotted by `backupFile`: writes back the original
 *  content, or removes the file if it did not exist beforehand. */
export function restoreFile(backup: FileBackup): void {
  if (backup.content != null) {
    writeFileSync(backup.path, backup.content, 'utf-8')
  } else {
    try { unlinkSync(backup.path) } catch { /* absent already */ }
  }
}

/** Snapshot of the virtual device's PipetteSettings file, as found on disk
 *  before a capture run touches it (or an absent-file marker). */
export type VirtualDeviceSettingsBackup = FileBackup

/**
 * Snapshot `sync/keyboards/{VIRTUAL_DEVICE_UID}/pipette_settings.json` before
 * a capture helper enters Typing Test / Typing View / View-Only mode on the
 * virtual device. Those modes persist `viewMode` (and related fields) into
 * this file via the same PipetteSettings store a real keyboard uses, and the
 * virtual device's uid is shared across every doc-capture helper and
 * e2e/virtual-device.test.ts (all launch through the same default userData).
 * Without restoring this file, a later test run auto-restores the leaked
 * view mode on connect and can hit its unlock gate unexpectedly. Call this
 * once userData is resolved, before the helper starts clicking mode toggles,
 * and pass the result to `restoreVirtualDeviceSettings` in a `finally` block.
 */
export function backupVirtualDeviceSettings(userDataPath: string): VirtualDeviceSettingsBackup {
  return backupFile(join(userDataPath, 'sync', 'keyboards', VIRTUAL_DEVICE_UID, 'pipette_settings.json'))
}

/** Restores the file snapshotted by `backupVirtualDeviceSettings`. Call
 *  after the app has closed so no further debounced save from the running
 *  app can race with (and undo) the restore. */
export function restoreVirtualDeviceSettings(backup: VirtualDeviceSettingsBackup): void {
  restoreFile(backup)
}

// --- Local Hub test mode ----------------------------------------------------

/** Default URL of a local Hub started with `pnpm run dev:test`. */
export const HUB_LOCAL_URL = 'http://localhost:8787'

/** How to bring the local Hub up, for skip/abort messages. */
export const HUB_LOCAL_START_HINT =
  'cd ../pipette-hub && pnpm run db:migrate:local && pnpm run dev:test'

/** Probe the local Hub with an anonymous list request. */
export async function isLocalHubUp(hubUrl: string = HUB_LOCAL_URL): Promise<boolean> {
  try {
    const res = await fetch(`${hubUrl}/api/files?page=1`)
    return res.ok
  } catch {
    return false
  }
}

/** Snapshot of the `hubEnabled` key in userData/config.json (electron-store). */
export interface HubEnabledBackup {
  path: string
  original: boolean | undefined
}

/**
 * Force `hubEnabled: true` in the electron-store config file. electron-store
 * reads the file on every access, but the renderer fetches the app config
 * once on mount — callers must `page.reload()` after seeding (or seed
 * before the renderer loads) for the flag to take effect.
 */
export function seedHubEnabledConfig(userDataPath: string): HubEnabledBackup {
  const path = join(userDataPath, 'config.json')
  const config = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>)
    : {}
  const backup: HubEnabledBackup = { path, original: config.hubEnabled as boolean | undefined }
  config.hubEnabled = true
  writeFileSync(path, JSON.stringify(config, null, '\t'), 'utf-8')
  return backup
}

/** Restore the original `hubEnabled` value. Call after the app has closed
 *  (window-state saves on quit rewrite config.json) and read-modify-write
 *  so those late writes are preserved. */
export function restoreHubEnabledConfig(backup: HubEnabledBackup): void {
  if (!existsSync(backup.path)) return
  const config = JSON.parse(readFileSync(backup.path, 'utf-8')) as Record<string, unknown>
  if (backup.original === undefined) {
    delete config.hubEnabled
  } else {
    config.hubEnabled = backup.original
  }
  writeFileSync(backup.path, JSON.stringify(config, null, '\t'), 'utf-8')
}

/** Snapshot of the virtual device's saved-layout store, taken before a
 *  run that creates entries (Save + Hub upload flows). */
export interface VirtualDeviceSnapshotsBackup {
  dir: string
  indexPath: string
  indexContent: string | null
  preexisting: Set<string>
}

export function backupVirtualDeviceSnapshots(userDataPath: string): VirtualDeviceSnapshotsBackup {
  const dir = join(userDataPath, 'sync', 'keyboards', VIRTUAL_DEVICE_UID, 'snapshots')
  const indexPath = join(dir, 'index.json')
  return {
    dir,
    indexPath,
    indexContent: existsSync(indexPath) ? readFileSync(indexPath, 'utf-8') : null,
    preexisting: new Set(existsSync(dir) ? readdirSync(dir) : []),
  }
}

/** Delete files the run created and restore the original index, so repeat
 *  runs don't accumulate "Default" entries. Call after the app has closed. */
export function restoreVirtualDeviceSnapshots(backup: VirtualDeviceSnapshotsBackup): void {
  if (!existsSync(backup.dir)) return
  for (const name of readdirSync(backup.dir)) {
    if (backup.preexisting.has(name)) continue
    try { unlinkSync(join(backup.dir, name)) } catch { /* ignore */ }
  }
  if (backup.indexContent != null) {
    writeFileSync(backup.indexPath, backup.indexContent, 'utf-8')
  } else {
    try { unlinkSync(backup.indexPath) } catch { /* absent already */ }
  }
}

/** The e2e-facing surface of `globalThis.__pipetteVirtualDevice` (see
 *  src/main/virtual-device) — shared by every helper/test that drives the
 *  emulator through `app.evaluate()`. */
export interface VirtualDeviceController {
  pressKey(row: number, col: number): void
  releaseKey(row: number, col: number): void
  releaseAll(): void
  holdKeys(pairs: [number, number][]): void
  setUnlockCounterMax(n: number): void
}

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
 *  dialog up?" probe for every doc-capture helper. */
export function unlockDialogHeading(page: Page): Locator {
  return page.locator('h2', { hasText: /Unlock|unlock|アンロック/ })
}

// The unlock dialog has no close button — it clears once the firmware sees the
// unlock combo held long enough. The virtual device exposes a controller on
// globalThis in the main process (see e2e/virtual-device.test.ts) so the combo
// can be driven programmatically instead of waiting on a human at the keyboard.
export async function waitForUnlockDialog(app: ElectronApplication, page: Page): Promise<void> {
  const unlockHeading = unlockDialogHeading(page)
  if (!(await isAvailable(unlockHeading))) return

  console.log('  Unlock dialog detected — unlocking via virtual device controller...')
  try {
    await app.evaluate(() => {
      const controller = (globalThis as unknown as { __pipetteVirtualDevice: VirtualDeviceController }).__pipetteVirtualDevice
      controller.setUnlockCounterMax(3)
      controller.holdKeys([[0, 0], [0, 1]])
    })
    await unlockHeading.waitFor({ state: 'detached', timeout: 15_000 })
    console.log('  Keyboard unlocked!')
  } catch {
    console.log('  [warn] Unlock timed out')
  } finally {
    // Always release the combo — a timeout above would otherwise leave the
    // virtual keys held down for the rest of the capture session.
    await app
      .evaluate(() => {
        const controller = (globalThis as unknown as { __pipetteVirtualDevice: VirtualDeviceController }).__pipetteVirtualDevice
        controller.releaseAll()
      })
      .catch(() => { /* app may be gone */ })
  }
  await page.waitForTimeout(500)
}

/**
 * Click a control whose action is gated behind the keyboard unlock (Typing
 * Test toggle, View-Only toggle, ...) and clear the Unlock dialog it pops
 * on the still-locked virtual device. Real hardware stays unlocked across
 * script runs while powered, but the virtual device relocks on every
 * Electron launch, so any unlock-gated mode entry hits the dialog even
 * when an earlier one in the same session already cleared it once.
 */
export async function clickThroughUnlock(
  app: ElectronApplication,
  page: Page,
  locator: Locator,
): Promise<void> {
  await locator.click()
  await waitForUnlockDialog(app, page)
}

/**
 * Restore the Editor view after a prior run (or a persisted view-mode
 * auto-restore that fired now that we're connected) left the device in
 * Typing View or Typing Test mode. useDevicePrefs persists `viewMode` per
 * keyboard; since the virtual device resets to *locked* on every Electron
 * launch (unlike real hardware, which stays unlocked across separate
 * script runs as long as it stays powered), a persisted `viewMode` of
 * 'typingView'/'typingTest' can surface the Unlock dialog on connect even
 * when the calling script never intended to touch those modes. Call this
 * after `waitForUnlockDialog` so every helper starts from the same known
 * state. Uses the locale-stable `data-active`/testid attributes instead of
 * i18n-dependent label text.
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
 * Close the startup release-notes notification modal if visible.
 *
 * `useStartupNotification` fetches asynchronously after the app mounts, so
 * the modal can appear a beat after the page is "ready". Pass
 * `waitForAppearMs` on the first post-launch call to give the modal a
 * chance to show up before deciding it isn't coming. Subsequent cleanup
 * calls can leave the default (0) for an instant check.
 */
export async function dismissNotificationModal(
  page: Page,
  opts: { waitForAppearMs?: number } = {},
): Promise<void> {
  const backdrop = page.locator('[data-testid="notification-modal-backdrop"]')
  const waitMs = opts.waitForAppearMs ?? 0
  if (waitMs > 0) {
    try {
      await backdrop.waitFor({ state: 'visible', timeout: waitMs })
    } catch {
      return
    }
  } else if (!(await backdrop.isVisible())) {
    return
  }
  console.log('Dismissing notification modal...')
  const closeBtn = page.locator('[data-testid="notification-modal-close"]')
  if (await isAvailable(closeBtn)) {
    await closeBtn.click()
  } else {
    await backdrop.click({ position: { x: 10, y: 10 } })
  }
  await page.waitForTimeout(500)
}

/**
 * Generic "close an overlay if it's up" helper. Used by the hub helper for
 * the settings modal + notification modal, where a backdrop click is the
 * required fallback if the close button isn't rendered.
 */
export async function dismissOverlay(
  page: Page,
  backdropId: string,
  closeId: string,
  fallback: () => Promise<void>,
): Promise<void> {
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

/**
 * Select a specific keyboard (by uid) through the Analyze staged filter
 * modal (chip -> Keyboard row -> Apply). Polls for the option's `<select>`
 * value instead of grabbing "whichever keyboard is first" — the seeded
 * dummy keyboard (`doc-ta-keyboard-1`, product name "GPK60-63R (docs)")
 * can otherwise sort after a real "GPK60-63R" device that still has thin
 * analytics on the same machine, silently pointing every Analyze capture
 * at the wrong dataset. Leaves the modal closed either way.
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
 * modal's Keymap row is the only snapshot selector (the inline
 * quick-select next to the summary chip was removed). `optionIndex`
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
