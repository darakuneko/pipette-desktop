// SPDX-License-Identifier: GPL-2.0-or-later

// Screenshot capture script for Hub workflow documentation.
// Launches the production build via Playwright (launchCaptureApp) with the
// virtual "Virtual Keyboard" device and the local-Hub test mode
// (PIPETTE_HUB_TEST), so the authed upload flow is captured without real
// hardware, a Google account, or keyring credentials. Requires a local Hub
// running in test mode:
//   cd ../pipette-hub && pnpm run db:migrate:local && pnpm run dev:test
// Usage: pnpm build && npx tsx e2e/helpers/doc-capture-hub.ts
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  connectToDevice,
  dismissOverlay,
  escapeRegex,
  HUB_LOCAL_START_HINT,
  HUB_LOCAL_URL,
  isAvailable,
  isLocalHubUp,
  launchCaptureApp,
  resetToEditorMode,
  restoreHubEnabledConfig,
  restoreVirtualDeviceSnapshots,
  seedHubEnabledConfig,
  VIRTUAL_DEVICE_DISPLAY_NAME,
  waitForUnlockDialog,
  backupVirtualDeviceSnapshots,
  type HubEnabledBackup,
  type VirtualDeviceSnapshotsBackup,
} from './doc-capture-common'

const PROJECT_ROOT = resolve(import.meta.dirname, '../..')
const SCREENSHOT_DIR = resolve(PROJECT_ROOT, 'docs/screenshots')
const DEVICE_NAME = VIRTUAL_DEVICE_DISPLAY_NAME
const HUB_TEST_ACCOUNT = 'doc@example.com'

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

// Favorites are read at request time (opening the Data modal / a TD modal),
// so seeding right after launch — before any modal is opened — is safe.
function seedDocFavorites(favBase: string): SeedBackup {
  const indexBackups = new Map<string, string | null>()
  const createdFiles = new Set<string>()

  for (const [type, index] of Object.entries(DUMMY_FAVORITES)) {
    const dir = join(favBase, type)
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

async function dismissOverlays(page: Page): Promise<void> {
  await dismissOverlay(page, 'settings-backdrop', 'settings-close', () => page.keyboard.press('Escape'))
  await dismissOverlay(page, 'notification-modal-backdrop', 'notification-modal-close', () =>
    page.locator('[data-testid="notification-modal-backdrop"]').click({ position: { x: 10, y: 10 } }),
  )
}

async function connectDevice(app: ElectronApplication, page: Page): Promise<boolean> {
  if (!(await connectToDevice(page, DEVICE_NAME, { raceNoDeviceMessage: true }))) {
    return false
  }
  // The virtual device relocks on every launch; a persisted viewMode from a
  // prior helper run can surface the Unlock dialog on connect. Clear it via
  // the virtual-device controller, then reset back to the keymap editor.
  await waitForUnlockDialog(app, page)
  await resetToEditorMode(page)
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

  // The Data modal opens on the sidebar tree with everything collapsed —
  // drill into Local > Favorites > Tap Dance to reach the seeded entries.
  for (const nav of ['nav-local', 'nav-local-favorites', 'nav-fav-tapDance']) {
    const navBtn = page.locator(`[data-testid="${nav}"]`)
    if (!(await isAvailable(navBtn))) {
      console.log(`  [warn] ${nav} not found in the Data modal tree`)
      break
    }
    await navBtn.click()
  }

  // Wait for the seeded Tap Dance favorite entries to load
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

// --- Phase 4: Inline Favorites with Hub actions (requires device) ---

async function captureInlineFavoritesHub(page: Page): Promise<void> {
  console.log('\n--- Phase 4: Inline Favorites — Hub actions ---')

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

// --- Phase 5: Editor Settings -> Data tab -> Save & Upload ---

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
  console.log('\n--- Phase 5: Overlay Panel -> Data tab (Save & Upload) ---')

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

    // Upload now opens the Public/Private confirmation dialog instead of
    // uploading immediately. Capture the dialog, then Confirm (default =
    // Public) to complete the public upload that hub-04/05 document.
    await uploadBtn.click()
    const confirmDialog = page.locator('[data-testid="upload-confirm-backdrop"]').first()
    await confirmDialog.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
    if (await isAvailable(confirmDialog)) {
      await page.waitForTimeout(500)
      await capture(page, 'hub-upload-confirm', { fullPage: true })
      await page.locator('[data-testid="upload-confirm-submit"]').click()
    }
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

/**
 * Delete the doc test account's posts left on the local Hub by a previous
 * run. The script restores local snapshots on exit but cannot restore the
 * Hub side, and a leftover same-title post would make the next run's saved
 * entry match it as an orphan — rendering "Upload?" instead of the plain
 * Upload button that hub-03 documents.
 */
async function cleanupHubTestAccountPosts(): Promise<void> {
  const authRes = await fetch(`${HUB_LOCAL_URL}/api/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id_token: `test:${HUB_TEST_ACCOUNT}` }),
  })
  if (!authRes.ok) {
    console.log(`  [warn] Hub cleanup auth failed (${authRes.status}) — continuing`)
    return
  }
  const { data: auth } = await authRes.json() as { data: { token: string } }
  const listRes = await fetch(`${HUB_LOCAL_URL}/api/files/me?per_page=100`, {
    headers: { Authorization: `Bearer ${auth.token}` },
  })
  if (!listRes.ok) {
    console.log(`  [warn] Hub cleanup list failed (${listRes.status}) — continuing`)
    return
  }
  const { data: posts } = await listRes.json() as { data: { items: { id: string; title: string }[] } }
  for (const post of posts.items) {
    const delRes = await fetch(`${HUB_LOCAL_URL}/api/files/${encodeURIComponent(post.id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    console.log(`  Deleted leftover post "${post.title}" (${delRes.ok ? 'ok' : delRes.status})`)
  }
}

async function main(): Promise<void> {
  if (!(await isLocalHubUp())) {
    console.error(`Local Hub is not reachable at ${HUB_LOCAL_URL}.`)
    console.error('Start it in test mode first:')
    console.error(`  ${HUB_LOCAL_START_HINT}`)
    process.exit(1)
  }

  console.log('Cleaning up leftover test-account posts on the local Hub...')
  await cleanupHubTestAccountPosts()

  mkdirSync(SCREENSHOT_DIR, { recursive: true })

  console.log('Launching Electron app (virtual device + local Hub test mode)...')
  const app = await launchCaptureApp({
    env: {
      PIPETTE_HUB_TEST: '1',
      PIPETTE_HUB_URL: HUB_LOCAL_URL,
      PIPETTE_HUB_TEST_ACCOUNT: HUB_TEST_ACCOUNT,
    },
  })

  let favBackups: SeedBackup | null = null
  let hubEnabledBackup: HubEnabledBackup | null = null
  let snapshotsBackup: VirtualDeviceSnapshotsBackup | null = null
  try {
    const userDataPath = await app.evaluate(async ({ app: a }) => a.getPath('userData'))
    console.log(`userData: ${userDataPath}`)

    console.log('Seeding dummy favorites + hubEnabled config...')
    favBackups = seedDocFavorites(join(userDataPath, 'sync', 'favorites'))
    hubEnabledBackup = seedHubEnabledConfig(userDataPath)
    snapshotsBackup = backupVirtualDeviceSnapshots(userDataPath)

    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.setViewportSize({ width: 1320, height: 960 })
    // The renderer reads the app config once on mount and may have loaded
    // before the hubEnabled seed landed — reload so it picks the flag up
    // deterministically.
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(3000)

    await dismissOverlays(page)
    await captureGlobalSettings(page)
    await captureDataModalHub(page)

    console.log('\n--- Phase 3: Connect device ---')
    const connected = await connectDevice(app, page)
    if (!connected) {
      console.log('Failed to connect to device.')
      return
    }

    await captureInlineFavoritesHub(page)
    await captureEditorDataTab(page)

    console.log(`\nHub screenshots saved to: ${SCREENSHOT_DIR}`)
  } finally {
    await app.close().catch((err: unknown) => console.error('  [cleanup] app.close failed:', err))
    if (favBackups) restoreDocFavorites(favBackups)
    if (snapshotsBackup) restoreVirtualDeviceSnapshots(snapshotsBackup)
    if (hubEnabledBackup) restoreHubEnabledConfig(hubEnabledBackup)
    console.log('Restored original favorites, snapshots, and config')
  }
}

main().catch((err: unknown) => {
  console.error('Script failed:', err)
  process.exit(1)
})
