// SPDX-License-Identifier: GPL-2.0-or-later

// Screenshot capture script for the Key Labels modal (Settings → Tools).
// Mirrors doc-capture-hub.ts: launches Electron directly so safeStorage /
// keyring keep working, then connects via Playwright remote debugging.
// Captures the Installed tab and the Find on Hub tab (with a debounced
// auto-search for "br") of the Key Labels modal.
//
// Usage: pnpm build && npx tsx e2e/helpers/doc-capture-key-labels.ts
//
// Prerequisites:
// - Hub auth + display_name set (otherwise Upload buttons are disabled
//   but the rows still render fine, so the script does not abort).
// - Existing Key Label entries in the local store make the Installed
//   capture more representative; QWERTY alone also works.

import { chromium } from '@playwright/test'
import type { Page } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  cloneUserDataForCapture,
  dismissNotificationModal,
  dismissOverlay,
  forceEnglishLanguageInClone,
  isAvailable,
  killAndWaitForExit,
} from './doc-capture-common'

const PROJECT_ROOT = resolve(import.meta.dirname, '../..')
const SCREENSHOT_DIR = resolve(PROJECT_ROOT, 'docs/screenshots')
const DEBUG_PORT = 19224

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
  // Element-only capture so the static dim backdrop doesn't dominate the
  // image and the modal lands at full crop in the docs. Uses
  // `page.screenshot({ clip })` off a plain `boundingBox()` rather than
  // `locator.screenshot()` — on this same device-selector screen,
  // `locator.screenshot()`'s "wait for element to be stable" actionability
  // pre-check can hang indefinitely on some sandboxed/software-rendering
  // hosts where the renderer's requestAnimationFrame cadence collapses to
  // ~1/sec (or drops to 0 for a stretch), even though the element itself
  // is not actually moving (see doc-capture-language-packs.ts's
  // `capture()` for the same underlying issue, solved there via
  // `webContents.capturePage()` instead — not available here since this
  // helper connects over remote debugging rather than Playwright's own
  // `_electron.launch()`). `capturePageWithRetry` below retries the CDP
  // screenshot call itself, since it too can occasionally stall on the
  // same hosts even with the clip-based approach.
  const modal = page.locator('[data-testid="key-labels-modal"]')
  const box = (await isAvailable(modal)) ? await modal.boundingBox() : null
  const clip = box
    ? { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }
    : undefined
  await capturePageWithRetry(page, path, clip)
  console.log(`  Saved: ${name}.png`)
}

/**
 * `page.screenshot()` normally returns in well under a second. On some
 * sandboxed/software-rendering hosts it can stall indefinitely after a
 * tab switch + Hub search — reproduced hanging even a raw CDP
 * `Page.captureScreenshot` for 90+s with no forward progress at all,
 * independent of whether a `clip` is passed, so it's a genuine
 * compositor hiccup (stale frame reference) rather than anything wrong
 * with the captured page or a Playwright actionability wait.
 *
 * A tiny viewport resize forces a full relayout + repaint that reliably
 * un-sticks it — but only when done *before* the compositor has already
 * been left hanging on a stale `Page.captureScreenshot` call: nudging
 * only on retry (after a first attempt that itself blocked for its full
 * timeout) was not reliable, so the nudge runs unconditionally before
 * every attempt including the first.
 */
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
 * The Settings modal (and Key Labels behind it) is only reachable from
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

async function openKeyLabelsModal(page: Page): Promise<boolean> {
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

  // The Tools tab is the default selection on first open, but click it
  // anyway to be deterministic across re-runs.
  const toolsTab = page.locator('[data-testid="settings-tab-tools"]')
  if (await isAvailable(toolsTab)) {
    await toolsTab.click({ force: true })
    await page.waitForTimeout(300)
  }

  const editBtn = page.locator('[data-testid="settings-key-labels-button"]')
  if (!(await isAvailable(editBtn))) {
    console.log('  [skip] Key Labels Manage Edit button not found')
    return false
  }
  await editBtn.click({ force: true })
  await page.waitForTimeout(500)

  const modal = page.locator('[data-testid="key-labels-modal"]')
  try {
    await modal.waitFor({ state: 'visible', timeout: 3000 })
  } catch {
    console.log('  [skip] Key Labels modal did not open')
    return false
  }
  return true
}

async function captureInstalledTab(page: Page): Promise<void> {
  console.log('\n--- Phase 1: Installed tab ---')
  const installedTab = page.locator('[data-testid="key-labels-tab-installed"]')
  if (await isAvailable(installedTab)) {
    await installedTab.click({ force: true })
    await page.waitForTimeout(300)
  }
  // Give metas refresh + sync notifications a moment to land.
  await page.waitForTimeout(500)
  // Populate the Updated column for every foreign row by invoking the
  // Sync IPC directly via window.vialAPI. Going through the UI would
  // leave a "Synced" inline badge on the last-clicked row; bypassing
  // the click handler skips that side effect so the captured screenshot
  // stays neutral. Best-effort: errors per row are logged and ignored.
  type FauxApi = { keyLabelHubSync(id: string): Promise<{ success: boolean; error?: string }> }
  type FauxWindow = Window & { vialAPI: FauxApi }
  const syncButtons = page.locator('[data-testid^="key-labels-sync-"]')
  const ids: string[] = []
  for (let i = 0; i < await syncButtons.count(); i++) {
    const testid = await syncButtons.nth(i).getAttribute('data-testid')
    if (testid) ids.push(testid.replace('key-labels-sync-', ''))
  }
  if (ids.length > 0) {
    console.log(`  Priming ${ids.length} foreign row(s) via keyLabelHubSync IPC so the Updated column shows real Hub timestamps`)
    const results = await page.evaluate(async (localIds: string[]) => {
      const api = (window as unknown as FauxWindow).vialAPI
      const out: { id: string; ok: boolean; error?: string }[] = []
      for (const id of localIds) {
        const res = await api.keyLabelHubSync(id)
        out.push({ id, ok: res.success, error: res.error })
      }
      // useKeyLabels.ts listens for this event and re-runs `keyLabelStoreList`,
      // which is how every modal instance picks up the new hubUpdatedAt.
      window.dispatchEvent(new Event('pipette:key-labels-changed'))
      return out
    }, ids)
    for (const r of results) {
      if (!r.ok) console.log(`    [warn] Sync failed for ${r.id}: ${r.error}`)
    }
    // Wait for the re-list to land in the DOM.
    await page.waitForTimeout(400)
  }
  await capture(page, 'key-labels-installed')
}

async function captureFindOnHubTab(page: Page): Promise<void> {
  console.log('\n--- Phase 2: Find on Hub tab ---')
  const hubTab = page.locator('[data-testid="key-labels-tab-hub"]')
  if (!(await isAvailable(hubTab))) {
    console.log('  [skip] Find on Hub tab not found')
    return
  }
  // `force: true`: on some sandboxed/headless-ish hosts the renderer's
  // requestAnimationFrame cadence collapses to ~1/sec right after the
  // priming step's real Hub round trips above, which makes Playwright's
  // default hover/stability actionability wait time out even though the
  // tab is genuinely clickable and its layout is not actually moving
  // (verified via elementFromPoint + a stable boundingBox poll). Skipping
  // the actionability wait is safe here — this is a screenshot capture
  // script, not a correctness test.
  await hubTab.click({ force: true })
  await page.waitForTimeout(300)

  const input = page.locator('[data-testid="key-labels-search-input"]')
  if (!(await isAvailable(input))) {
    console.log('  [skip] search input not found')
    return
  }
  // "br" is short, common, and auto-search fires after 300ms debounce.
  await input.fill('br')

  // Wait for at least one download row to render OR for the empty state
  // to settle (whichever happens first), with a hard timeout cap.
  const firstResult = page.locator('[data-testid^="key-labels-download-"]')
  try {
    await firstResult.first().waitFor({ state: 'visible', timeout: 5000 })
    console.log('  Hub results visible')
  } catch {
    console.log('  [warn] No Hub results returned (network / Hub state?)')
  }
  await page.waitForTimeout(500)
  await capture(page, 'key-labels-hub')
}

function launchElectronApp(userDataDir: string): ReturnType<typeof spawn> {
  const electronPath = resolve(PROJECT_ROOT, 'node_modules/.bin/electron')
  const args = [
    '.',
    '--no-sandbox',
    '--disable-gpu-sandbox',
    `--remote-debugging-port=${DEBUG_PORT}`,
    // Always a disposable clone from `cloneUserDataForCapture` (see
    // `main` below) — never the real profile. That also means the
    // unconditional single-instance lock (since #278,
    // `requestSingleInstanceLock` in src/main/index.ts) can no longer
    // collide with an already-running real Pipette session; a fresh temp
    // dir is never the same directory a live session owns.
    `--user-data-dir=${userDataDir}`,
  ]
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
 * On some sandboxed/software-rendering hosts, the *second* set of real
 * Hub network round trips within a single Electron session (the
 * Installed tab's per-row `keyLabelHubSync` priming, plus the Find on
 * Hub tab's own auto-search) reliably wedges the renderer badly enough
 * that `page.screenshot()` never returns — reproduced with both phase
 * orderings, a 5s settle gap between them, and a 3-attempt retry, none
 * of which helped; whichever phase runs *second* is the one that hangs.
 * The first phase in any given session always succeeds fine. Giving
 * each phase its own process sidesteps the accumulation entirely,
 * at the cost of a second ~launch+relogin cycle.
 */
async function runPhaseInFreshSession(userDataDir: string, phase: (page: Page) => Promise<void>): Promise<void> {
  console.log('Launching Electron app with remote debugging...')
  const child = launchElectronApp(userDataDir)

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

    if (!(await openKeyLabelsModal(page))) return

    await phase(page)
  } finally {
    await browser?.close()
    // Waits for the process to actually be gone (not just signaled) —
    // without this, the next `runPhaseInFreshSession()` call can race the
    // still-shutting-down previous instance and fail to bind
    // `DEBUG_PORT` (`connectOverCDP: socket hang up`).
    await killAndWaitForExit(child)
  }
}

async function main(): Promise<void> {
  mkdirSync(SCREENSHOT_DIR, { recursive: true })

  // Clone the real profile into a disposable temp dir and point every
  // launch at the CLONE — see `cloneUserDataForCapture`'s doc comment for
  // why (this used to patch the real config.json's `language` key in
  // place with a backup/restore that could not fully protect the user's
  // real data on a crash or concurrent run). Force English in the clone
  // — no backup/restore needed since the clone is thrown away afterward.
  const { userDataDir, cleanup } = cloneUserDataForCapture('key-labels')
  try {
    forceEnglishLanguageInClone(userDataDir)
    await runPhaseInFreshSession(userDataDir, captureInstalledTab)
    await runPhaseInFreshSession(userDataDir, captureFindOnHubTab)
  } finally {
    cleanup()
  }

  console.log(`\nKey Labels screenshots saved to: ${SCREENSHOT_DIR}`)
}

main().catch((err: unknown) => {
  console.error('Script failed:', err)
  process.exit(1)
})
