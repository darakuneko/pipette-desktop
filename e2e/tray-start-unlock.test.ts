// SPDX-License-Identifier: GPL-2.0-or-later
//
// Covers the boot-hidden Unlock dialog fix: with trayResident+startInTray
// enabled and the app quit while in typing view, a relaunch with a locked
// keyboard must (a) show the hidden window with the Unlock dialog instead
// of staying tray-resident, and (b) hide the window back to the tray once
// unlocked. Exercises three restore paths — typingView (dialog opened by
// the view-mode restore effect in App.tsx), typingTest (dialog opened
// through a different call site: KeymapEditor's toggleTypingTest ->
// onUnlock) — both unlock-gated — and plain editor (no view-mode restore
// requires unlocking, so the window must stay hidden and no dialog must
// appear — useBootHiddenWindow no longer opens the dialog on its own).
//
// Uses the virtual device (PIPETTE_VIRTUAL_DEVICE='only'), which relocks
// on every launch so the Unlock dialog is guaranteed to appear on each
// relaunch below. Mutates the Playwright userData dir (~/.config/Electron)
// directly, with backup/restore around the whole run. Sessions launch
// sequentially — the app's single-instance lock means each session must
// fully exit before the next one starts, so there is no way to run these
// tests in parallel or out of order.

import { test, expect } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { launchApp, readJson, electronRunning, quitApp as quitAppProcess } from './helpers/electron'
import {
  connectToDevice,
  clickThroughUnlock,
  waitForUnlockDialog,
  unlockDialogHeading,
  dismissNotificationModal,
  backupFile,
  restoreFile,
  VIRTUAL_DEVICE_DISPLAY_NAME,
  VIRTUAL_DEVICE_UID,
  type FileBackup,
} from './helpers/doc-capture-common'

const PROJECT_ROOT = resolve(import.meta.dirname, '..')
const USER_DATA = join(homedir(), '.config', 'Electron')
const CONFIG_PATH = join(USER_DATA, 'config.json')
const SETTINGS_PATH = join(USER_DATA, 'sync', 'keyboards', VIRTUAL_DEVICE_UID, 'pipette_settings.json')

// Reset flags a previous (crashed) run may have left behind so the setup
// session starts as a normal visible launch with a device list.
function cleanTestFlags(): void {
  const cfg = readJson(CONFIG_PATH)
  if (cfg) {
    cfg.trayResident = false
    cfg.startInTray = false
    cfg.restoreLastSession = true
    delete cfg.lastDevice
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2))
  }
  // Also reset the persisted view mode from a previous run, otherwise the
  // auto-restore path opens the Unlock dialog right after connecting and
  // its overlay blocks the setup session's clicks.
  const prefs = readJson(SETTINGS_PATH)
  if (prefs && prefs.viewMode !== 'editor') {
    prefs.viewMode = 'editor'
    writeFileSync(SETTINGS_PATH, JSON.stringify(prefs, null, 2))
  }
}

// This suite's relaunch-across-sessions pattern needs a short grace period
// after requesting quit (before the Playwright connection is torn down) for
// the close handler's windowState/pipette-settings writes to land — unlike
// the shared quitApp, which closes immediately after requesting quit.
async function quitApp(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: a }) => { a.quit() }).catch(() => {})
  await new Promise((r) => setTimeout(r, 2000))
  await quitAppProcess(app)
}

let app: ElectronApplication | null = null
let configBackup: FileBackup
let settingsBackup: FileBackup

test.describe.serial('tray start-in-tray unlock reveal', { tag: '@virtual' }, () => {
  test.setTimeout(180_000)

  test.beforeAll(() => {
    if (electronRunning()) {
      throw new Error('another electron instance is already running — aborting')
    }
    // Snapshot the files this run will mutate BEFORE any launch touches them.
    configBackup = backupFile(CONFIG_PATH)
    settingsBackup = backupFile(SETTINGS_PATH)
    cleanTestFlags()
  })

  test.afterAll(async () => {
    if (app) await quitApp(app).catch(() => {})
    restoreFile(configBackup)
    restoreFile(settingsBackup)
  })

  test('setup: connect, enter typing view, enable tray flags, quit while in typing view', async () => {
    const launched = await launchApp({ env: { PIPETTE_VIRTUAL_DEVICE: 'only' } })
    app = launched.app
    const page = launched.page

    const actualUserData = await app.evaluate(({ app: a }) => a.getPath('userData'))
    expect(actualUserData).toBe(USER_DATA)

    await dismissNotificationModal(page, { waitForAppearMs: 3_000 })

    const connected = await connectToDevice(page, VIRTUAL_DEVICE_DISPLAY_NAME)
    expect(connected).toBe(true)

    // Enter view-only typing mode (unlock-gated on the freshly locked
    // virtual device).
    const viewOnlyBtn = page.locator('[data-testid="view-only-button"]')
    await viewOnlyBtn.waitFor({ state: 'visible', timeout: 10_000 })
    await clickThroughUnlock(app, page, viewOnlyBtn)
    await page.waitForTimeout(2000)

    // Enable tray-resident + start-in-tray (restoreLastSession already
    // defaults to true).
    await page.evaluate(async () => {
      const api = (window as unknown as { vialAPI: { appConfigSet: (k: string, v: unknown) => Promise<void> } }).vialAPI
      await api.appConfigSet('trayResident', true)
      await api.appConfigSet('startInTray', true)
    })
    await page.waitForTimeout(800)

    // Quit while still in typingView.
    await quitApp(app)
    app = null

    const cfg = readJson(CONFIG_PATH)
    const prefs = readJson(SETTINGS_PATH)
    expect(cfg?.trayResident).toBe(true)
    expect(cfg?.startInTray).toBe(true)
    expect(prefs?.viewMode).toBe('typingView')
  })

  test('typingView restore path: relaunch reveals the Unlock dialog then hides back to tray', async () => {
    const launched = await launchApp({ env: { PIPETTE_VIRTUAL_DEVICE: 'only' } })
    app = launched.app
    const page = launched.page

    let dialogSeenVisible = false
    await expect.poll(async () => {
      const winVisible = await app!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((w) => w.isVisible()))
      const dialogUp = (await unlockDialogHeading(page).count()) > 0
      if (dialogUp && winVisible.some(Boolean)) dialogSeenVisible = true
      return dialogSeenVisible
    }, { message: 'expected the Unlock dialog to appear in a visible window', timeout: 25_000, intervals: [1000] }).toBe(true)

    await waitForUnlockDialog(app, page)

    await expect.poll(async () => {
      const winVisible = await app!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((w) => w.isVisible()))
      return winVisible.some(Boolean)
    }, { message: 'expected the window to hide back to the tray after unlock', timeout: 15_000, intervals: [1000] }).toBe(false)
    await expect(unlockDialogHeading(page)).toHaveCount(0)

    await quitApp(app)
    app = null
  })

  test('typingTest restore path: relaunch reveals the Unlock dialog then hides back to tray', async () => {
    // Rewrite the persisted view mode to typingTest. This restore path opens
    // the dialog through a different call site than typingView's own
    // effect — App.tsx calls keymapEditorRef.current?.toggleTypingTest(),
    // which (unlocked) delegates to useInputModes' handleTypingTestToggle,
    // which calls the onUnlock callback wired to setShowUnlockDialog(true) —
    // so it is worth its own regression coverage alongside typingView.
    const prefs = readJson(SETTINGS_PATH)
    expect(prefs).not.toBeNull()
    if (prefs) {
      prefs.viewMode = 'typingTest'
      writeFileSync(SETTINGS_PATH, JSON.stringify(prefs, null, 2))
    }

    const launched = await launchApp({ env: { PIPETTE_VIRTUAL_DEVICE: 'only' } })
    app = launched.app
    const page = launched.page

    let dialogSeenVisible = false
    await expect.poll(async () => {
      const winVisible = await app!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((w) => w.isVisible()))
      const dialogUp = (await unlockDialogHeading(page).count()) > 0
      if (dialogUp && winVisible.some(Boolean)) dialogSeenVisible = true
      return dialogSeenVisible
    }, { message: 'expected the Unlock dialog to appear in a visible window', timeout: 25_000, intervals: [1000] }).toBe(true)

    await waitForUnlockDialog(app, page)

    await expect.poll(async () => {
      const winVisible = await app!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((w) => w.isVisible()))
      return winVisible.some(Boolean)
    }, { message: 'expected the window to hide back to the tray after unlock', timeout: 15_000, intervals: [1000] }).toBe(false)
    await expect(unlockDialogHeading(page)).toHaveCount(0)

    await quitApp(app)
    app = null
  })

  test('editor restore path: relaunch stays tray-resident with no Unlock dialog', async () => {
    // Rewrite the persisted view mode to plain editor so this session
    // restores into a view that does not require unlocking. Only the
    // typingView/typingTest (and matrix-test) restore paths are allowed to
    // open the Unlock dialog — a boot-hidden restore of the plain editor
    // must leave the window hidden and never show the dialog at all.
    const prefs = readJson(SETTINGS_PATH)
    expect(prefs).not.toBeNull()
    if (prefs) {
      prefs.viewMode = 'editor'
      writeFileSync(SETTINGS_PATH, JSON.stringify(prefs, null, 2))
    }

    const launched = await launchApp({ env: { PIPETTE_VIRTUAL_DEVICE: 'only' } })
    app = launched.app
    const page = launched.page

    // Gate the start of the negative-assertion window on the same signal
    // the positive restore tests above implicitly depend on: `keyboard.
    // loading` (and, in the same reload() commit, `unlockStatusKnown`)
    // flipping to known/false. `editor-content` only becomes visible once
    // the keymap/definition payloads have resolved in that same commit —
    // this is the established "connection complete" signal used elsewhere
    // in this suite (see helpers/test-device.ts:connectTestDevice). Waiting
    // for it here means sampling starts only AFTER the point where the old
    // buggy auto-open effect would have fired, instead of racing it on a
    // fixed wall-clock guess.
    await page.locator('[data-testid="editor-content"]').waitFor({ state: 'visible', timeout: 25_000 })

    // Sample repeatedly over a window matching the positive tests' ~25s
    // dialog-appearance budget above, so timing skew on a slow environment
    // cannot hide a late prompt — the window must stay hidden and the
    // dialog must never appear at any point in this window.
    for (let sample = 0; sample < 25; sample++) {
      const winVisible = await app!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((w) => w.isVisible()))
      const dialogUp = (await unlockDialogHeading(page).count()) > 0
      expect(winVisible.some(Boolean), `window became visible on sample ${sample}`).toBe(false)
      expect(dialogUp, `Unlock dialog appeared on sample ${sample}`).toBe(false)
      await page.waitForTimeout(1000)
    }

    await quitApp(app)
    app = null
  })

  test('REC gate + editor restore: relaunch reveals the Unlock dialog, hides back to tray, and the Recording indicator lights up', async () => {
    // Arm the REC-unlock gate: typingRecordEnabled=true while the keyboard
    // is locked must request an unlock even for the plain editor, which on
    // its own never prompts (see the 'editor restore path' test above).
    // The persisted view mode is already 'editor' from that test, but set
    // it explicitly here so this test does not depend on suite ordering.
    const prefs = readJson(SETTINGS_PATH)
    expect(prefs).not.toBeNull()
    if (prefs) {
      prefs.viewMode = 'editor'
      prefs.typingRecordEnabled = true
      writeFileSync(SETTINGS_PATH, JSON.stringify(prefs, null, 2))
    }

    const launched = await launchApp({ env: { PIPETTE_VIRTUAL_DEVICE: 'only' } })
    app = launched.app
    const page = launched.page

    let dialogSeenVisible = false
    await expect.poll(async () => {
      const winVisible = await app!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((w) => w.isVisible()))
      const dialogUp = (await unlockDialogHeading(page).count()) > 0
      if (dialogUp && winVisible.some(Boolean)) dialogSeenVisible = true
      return dialogSeenVisible
    }, { message: 'expected the Unlock dialog to appear in a visible window', timeout: 25_000, intervals: [1000] }).toBe(true)

    await waitForUnlockDialog(app, page)

    await expect.poll(async () => {
      const winVisible = await app!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((w) => w.isVisible()))
      return winVisible.some(Boolean)
    }, { message: 'expected the window to hide back to the tray after unlock', timeout: 15_000, intervals: [1000] }).toBe(false)
    await expect(unlockDialogHeading(page)).toHaveCount(0)

    // This only proves the REC pref itself survived the gate/unlock/hide
    // sequence (the footer's Recording indicator is wired straight to
    // devicePrefs.typingRecordEnabled with no view-mode or lock-status
    // condition, so it stays queryable through Playwright's CDP connection
    // even while the BrowserWindow itself is hidden in the tray — the DOM
    // keeps running, only the OS window surface is hidden). It does NOT
    // exercise the ambient matrix-recording pipeline itself (no keystrokes
    // are simulated here) — see the unit/component suites for that
    // (useInputModes's ambient-frame tests, use-matrix-tester's polling
    // tests) — this assertion is scoped to: the gate fired, the window
    // revealed then hid again, and REC stayed on throughout.
    await expect(page.locator('[data-testid="recording-status"]')).toHaveCount(1)

    await quitApp(app)
    app = null

    // Turn the gate back off so the next test (which relies on a boot-hidden
    // launch producing no dialog at all) isn't re-armed by this test's seed.
    const postPrefs = readJson(SETTINGS_PATH)
    if (postPrefs) {
      postPrefs.typingRecordEnabled = false
      writeFileSync(SETTINGS_PATH, JSON.stringify(postPrefs, null, 2))
    }
  })

  test('second-instance reveal: relaunching a tray-resident hidden app reveals the running instance\'s window', async () => {
    // Persisted viewMode is still 'editor' from the previous test, so the
    // primary instance boots hidden with no Unlock dialog in play — the
    // only thing that can make its window visible here is the
    // 'second-instance' handler reacting to the relaunch attempt below.
    const launched = await launchApp({ env: { PIPETTE_VIRTUAL_DEVICE: 'only' } })
    app = launched.app
    const page = launched.page

    await page.locator('[data-testid="editor-content"]').waitFor({ state: 'visible', timeout: 25_000 })

    const bootVisible = await app!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((w) => w.isVisible()))
    expect(bootVisible, 'expected the primary instance to boot hidden').toBe(false)

    // Spawn a second instance as a raw child process rather than through
    // launchApp — Playwright's electron.launch would try to attach to this
    // process, but the single-instance lock makes it exit immediately
    // (before creating any window) once it loses the lock race.
    const electronBin = resolve(PROJECT_ROOT, 'node_modules', '.bin', 'electron')
    const second = spawnSync(electronBin, ['out/main/index.js', '--no-sandbox', '--disable-gpu-sandbox'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, PIPETTE_VIRTUAL_DEVICE: 'only' },
      stdio: 'ignore',
      // The loser of the single-instance lock race exits within ~a second;
      // the timeout only bounds a pathological hang so it cannot block the
      // whole (synchronous) spawn past the suite budget.
      timeout: 30_000,
    })
    expect(second.status).toBe(0)

    await expect.poll(async () => {
      const winVisible = await app!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((w) => w.isVisible()))
      return winVisible.some(Boolean)
    }, { message: 'expected the primary instance\'s window to become visible after a second launch attempt', timeout: 15_000, intervals: [1000] }).toBe(true)

    await quitApp(app)
    app = null
  })
})
