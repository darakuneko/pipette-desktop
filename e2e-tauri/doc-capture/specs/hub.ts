// SPDX-License-Identifier: GPL-2.0-or-later
//
// The Hub workflow screenshots: the Settings modal's Data tab, the Data
// modal's favorites with their Hub actions, the inline favorites of the Tap
// Dance modal, and a keymap snapshot saved and uploaded from the Import /
// Save tab. The app is signed in to the fake Hub as the Hub test account
// (wdio.conf.ts, hub-capture.ts), so the signed-in upload flow is captured
// without a Google account or the real Hub.
//
//   pnpm doc:screenshots --spec e2e-tauri/doc-capture/specs/hub.ts

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { VIRTUAL_DEVICE_NAME } from '../../helpers/app'
import { userDataPath } from '../../helpers/driver'
import {
  captureNamed,
  connectToDevice,
  dismissOverlay,
  escapeRegex,
  isAvailable,
  openOverlayTab,
  outputDirectory,
  overlayTabNotFoundMessage,
  resetToEditorMode,
  waitForUnlockDialog,
} from '../common'
import { startSignedInToHub } from '../hub-capture'
import { Page, type Locator } from '../page'

const DEVICE_NAME = VIRTUAL_DEVICE_NAME
/** How long an upload may take: it builds the keymap's PDF and thumbnail
 *  first. */
const UPLOAD_TIMEOUT_MS = 60_000

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

/** Writes the favorites above into the session's userData directory. */
function seedDocFavorites(favBase: string): void {
  for (const [type, index] of Object.entries(DUMMY_FAVORITES)) {
    const dir = join(favBase, type)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.json'), JSON.stringify(index, null, 2), 'utf-8')
    for (const entry of index.entries) writeFileSync(join(dir, entry.filename), '{}', 'utf-8')
  }
}

async function dismissOverlays(page: Page): Promise<void> {
  await dismissOverlay(page, 'settings-backdrop', 'settings-close', () => page.keyboard.press('Escape'))
  await dismissOverlay(page, 'notification-modal-backdrop', 'notification-modal-close', () =>
    page.locator('[data-testid="notification-modal-backdrop"]').click({ position: { x: 10, y: 10 } }),
  )
}

async function connectDevice(page: Page): Promise<boolean> {
  if (!(await connectToDevice(page, DEVICE_NAME))) {
    return false
  }
  // The virtual keyboard is locked on every launch; a view mode restored on
  // connect can bring the Unlock dialog up. Clear it with the virtual
  // keyboard's unlock combo, then reset back to the keymap editor.
  await waitForUnlockDialog(page)
  await resetToEditorMode(page)
  return true
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
    await captureNamed(page, 'hub-settings-data-sync', { fullPage: true })
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

  await captureNamed(page, 'hub-fav-data-modal', { fullPage: true })

  // Switch to Hub Posts tab if available
  const hubPostsTab = page.locator('[data-testid="data-modal-tab-hubPost"]')
  if (await isAvailable(hubPostsTab)) {
    await hubPostsTab.click()
    await page.waitForTimeout(1000)
    await captureNamed(page, '02-data-modal-hub-posts', { fullPage: true })
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

  await captureNamed(page, 'hub-fav-inline', { fullPage: true })

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

  if (!(await openOverlayTab(page, 'data'))) {
    console.log(`  [skip] ${overlayTabNotFoundMessage('data')}`)
    return
  }

  console.log('\n--- Save Default snapshot ---')
  const saveInput = page.locator('[data-testid="layout-store-save-input"]')
  if (await isAvailable(saveInput)) {
    await saveInput.fill('Default')
    await page.waitForTimeout(300)
    await captureNamed(page, 'hub-01-save-default', { fullPage: true })

    await page.locator('[data-testid="layout-store-save-submit"]').click()
    await page.waitForTimeout(1500)
    // The saved-entry state is what hub-03-upload-button.png shows next, so
    // no separate capture here.
  }

  console.log('\n--- Hub Upload ---')
  const { available, locator: uploadBtn } = await waitForUploadButton(page)

  if (available) {
    await captureNamed(page, 'hub-03-upload-button', { fullPage: true })

    // Upload opens the Public/Private confirmation dialog instead of
    // uploading immediately. Capture the dialog, then Confirm (default =
    // Public) to complete the public upload that hub-04/05 document.
    await uploadBtn.click()
    const confirmDialog = page.locator('[data-testid="upload-confirm-backdrop"]').first()
    await confirmDialog.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
    if (await isAvailable(confirmDialog)) {
      await page.waitForTimeout(500)
      await captureNamed(page, 'hub-upload-confirm', { fullPage: true })
      await page.locator('[data-testid="upload-confirm-submit"]').click()
    }
    // The row shows its Hub badge once the upload has finished.
    await page
      .locator('[data-testid="layout-store-hub-badge"]')
      .first()
      .waitFor({ state: 'visible', timeout: UPLOAD_TIMEOUT_MS })
      .catch(() => console.log('  [warn] the upload did not finish in time'))
    await page.waitForTimeout(1000)
    await captureNamed(page, 'hub-04-uploaded', { fullPage: true })
    // hub-04-uploaded.png already shows the Open / Update / Remove row, so
    // the share-link state needs no extra capture.
  } else {
    // No fallback screenshot: an unauthenticated run would only produce a
    // stale, unreferenced image under docs/screenshots.
    console.log('  [skip] Upload button not available (Hub not configured or display name not set)')
  }
}

describe('Hub screenshots', () => {
  it('captures the Hub settings, favorites and a keymap upload', async () => {
    const page = new Page()

    // Favorites are read when a modal opens, so the seed goes in with the
    // relaunch that signs the app in to the fake Hub.
    await startSignedInToHub(page, () => seedDocFavorites(userDataPath('sync', 'favorites')))

    await dismissOverlays(page)
    await captureGlobalSettings(page)
    await captureDataModalHub(page)

    console.log('\n--- Phase 3: Connect device ---')
    const connected = await connectDevice(page)
    if (!connected) throw new Error(`Device "${DEVICE_NAME}" not found`)

    await captureInlineFavoritesHub(page)
    await captureEditorDataTab(page)

    console.log(`\nHub screenshots saved to: ${outputDirectory()}`)
  })
})
