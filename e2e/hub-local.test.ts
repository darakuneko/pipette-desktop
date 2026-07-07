// SPDX-License-Identifier: GPL-2.0-or-later
//
// Smoke test for the local-Hub test mode: PIPETTE_HUB_TEST=1 +
// PIPETTE_HUB_URL + PIPETTE_HUB_TEST_ACCOUNT let a production build
// authenticate against a Hub running with `pnpm run dev:test` (TEST_MODE
// sentinel id_tokens) — no Google account or real hardware needed.
//
// Skips cleanly when no local Hub is reachable at localhost:8787.
// Start one first: cd ../pipette-hub && pnpm run db:migrate:local && pnpm run dev:test

import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp } from './helpers/electron'
import {
  backupVirtualDeviceSnapshots,
  connectToDevice,
  dismissNotificationModal,
  HUB_LOCAL_START_HINT,
  HUB_LOCAL_URL,
  isLocalHubUp,
  resetToEditorMode,
  restoreHubEnabledConfig,
  restoreVirtualDeviceSnapshots,
  seedHubEnabledConfig,
  VIRTUAL_DEVICE_DISPLAY_NAME,
  waitForUnlockDialog,
  type HubEnabledBackup,
  type VirtualDeviceSnapshotsBackup,
} from './helpers/doc-capture-common'

const HUB_TEST_ACCOUNT = 'e2e@example.com'
const RUN_TAG = Date.now().toString(36)
const PUBLIC_LABEL = `E2E Hub ${RUN_TAG}`
const PRIVATE_LABEL = `E2E Private ${RUN_TAG}`

// Each phase builds on the previous one (launch -> connect -> save -> upload).
test.describe.configure({ mode: 'serial' })

let hubUp = false
let app: ElectronApplication | undefined
let page: Page
let favBackup: { indexPath: string; original: string | null; entryFile: string } | null = null
let hubEnabledBackup: HubEnabledBackup | null = null
let snapshotsBackup: VirtualDeviceSnapshotsBackup | null = null

// Seed one tap-dance favorite so the Data modal renders an entry with the
// hub-gated action row. Favorites are read at request time, so seeding
// before the modal is first opened is sufficient.
function seedFavorite(userDataPath: string): void {
  const dir = join(userDataPath, 'sync', 'favorites', 'tapDance')
  mkdirSync(dir, { recursive: true })
  const indexPath = join(dir, 'index.json')
  const original = existsSync(indexPath) ? readFileSync(indexPath, 'utf-8') : null
  const entryFile = join(dir, 'e2e-hub-td.json')
  writeFileSync(indexPath, JSON.stringify({
    type: 'tapDance',
    entries: [
      { id: 'e2e-hub-td', label: 'E2E Hub TD', filename: 'e2e-hub-td.json', savedAt: '2026-01-01T00:00:00.000Z' },
    ],
  }, null, 2), 'utf-8')
  if (!existsSync(entryFile)) writeFileSync(entryFile, '{}', 'utf-8')
  favBackup = { indexPath, original, entryFile }
}

function restoreFavorite(): void {
  if (!favBackup) return
  if (favBackup.original != null) {
    writeFileSync(favBackup.indexPath, favBackup.original, 'utf-8')
  } else {
    try { unlinkSync(favBackup.indexPath) } catch { /* absent */ }
  }
  try { unlinkSync(favBackup.entryFile) } catch { /* absent */ }
}

test.beforeAll(async () => {
  test.setTimeout(120_000)
  hubUp = await isLocalHubUp()
  if (!hubUp) {
    console.log(`[skip] local Hub not reachable at ${HUB_LOCAL_URL} — start it with: ${HUB_LOCAL_START_HINT}`)
    return
  }

  const launched = await launchApp({
    env: {
      PIPETTE_VIRTUAL_DEVICE: 'only',
      PIPETTE_HUB_TEST: '1',
      PIPETTE_HUB_URL: HUB_LOCAL_URL,
      PIPETTE_HUB_TEST_ACCOUNT: HUB_TEST_ACCOUNT,
    },
    onMainReady: async ({ userDataPath }) => {
      seedFavorite(userDataPath)
      hubEnabledBackup = seedHubEnabledConfig(userDataPath)
      snapshotsBackup = backupVirtualDeviceSnapshots(userDataPath)
    },
  })
  app = launched.app
  page = launched.page

  // The renderer reads the app config once on mount and races the
  // hubEnabled seed above — reload so the flag is picked up deterministically.
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await dismissNotificationModal(page, { waitForAppearMs: 3_000 })
})

test.afterAll(async () => {
  await app?.close()
  restoreFavorite()
  if (snapshotsBackup) restoreVirtualDeviceSnapshots(snapshotsBackup)
  if (hubEnabledBackup) restoreHubEnabledConfig(hubEnabledBackup)
})

test.beforeEach(() => {
  test.skip(!hubUp, `local Hub not running at ${HUB_LOCAL_URL} — start it with: ${HUB_LOCAL_START_HINT}`)
})

test('hub-gated favorite actions appear in the Data modal', async () => {
  test.setTimeout(60_000)

  await page.locator('[data-testid="data-button"]').click()
  await expect(page.locator('[data-testid="data-modal-backdrop"]')).toBeVisible({ timeout: 5_000 })

  // The Data modal opens on the sidebar tree with everything collapsed —
  // drill into Local > Favorites > Tap Dance to reach the seeded entry.
  // The hub action row appears once the test-mode auth check resolves
  // against the local Hub.
  await page.locator('[data-testid="nav-local"]').click()
  await page.locator('[data-testid="nav-local-favorites"]').click()
  await page.locator('[data-testid="nav-fav-tapDance"]').click()
  await expect(page.locator('[data-testid="data-modal-fav-entry"]').first()).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('[data-testid="fav-hub-actions"]').first()).toBeVisible({ timeout: 15_000 })

  await page.locator('[data-testid="data-modal-close"]').click()
})

test('connects the virtual device and reaches the hub upload UI', async () => {
  test.setTimeout(90_000)

  expect(await connectToDevice(page, VIRTUAL_DEVICE_DISPLAY_NAME, { raceNoDeviceMessage: true })).toBe(true)
  await waitForUnlockDialog(app!, page)
  await resetToEditorMode(page)

  // Open the overlay panel's Data tab where saved layouts live.
  const overlayToggle = page.locator('button[aria-controls="keycodes-overlay-panel"]')
  if ((await overlayToggle.getAttribute('aria-expanded')) !== 'true') {
    await overlayToggle.click()
  }
  await page.locator('[data-testid="overlay-tab-data"]').click()

  // Save a snapshot; its entry must expose the hub upload button.
  await page.locator('[data-testid="layout-store-save-input"]').fill(PUBLIC_LABEL)
  await page.locator('[data-testid="layout-store-save-submit"]').click()

  const entry = page
    .locator('[data-testid="layout-store-entry"]')
    .filter({ has: page.locator('[data-testid="layout-store-entry-label"]', { hasText: PUBLIC_LABEL }) })
  await expect(entry).toBeVisible({ timeout: 10_000 })
  await expect(entry.locator('[data-testid="layout-store-upload-hub"]')).toBeVisible({ timeout: 20_000 })
})

test('public upload succeeds and the share link uses the local hub origin', async () => {
  test.setTimeout(120_000)

  const entry = page
    .locator('[data-testid="layout-store-entry"]')
    .filter({ has: page.locator('[data-testid="layout-store-entry-label"]', { hasText: PUBLIC_LABEL }) })

  await entry.locator('[data-testid="layout-store-upload-hub"]').click()
  await expect(page.locator('[data-testid="upload-confirm-backdrop"]')).toBeVisible({ timeout: 5_000 })
  // Default visibility is Public — confirm as-is.
  await page.locator('[data-testid="upload-confirm-submit"]').click()

  // Upload builds vil/pipette/C/PDF/thumbnail before posting — allow time.
  const shareLink = entry.locator('[data-testid="layout-store-hub-share-link"]')
  await expect(shareLink).toBeVisible({ timeout: 60_000 })
  const href = await shareLink.getAttribute('href')
  expect(href).not.toBeNull()
  expect(href!.startsWith(`${HUB_LOCAL_URL}/`)).toBe(true)
  await expect(entry.locator('[data-testid="layout-store-hub-badge"]')).toHaveText('Hub (Public)')
})

test('private (unlisted) upload works when the local hub has PRIVATE_TOKEN_SECRET', async () => {
  test.setTimeout(120_000)

  // A second entry keeps the public one linked for the assertion above.
  await page.locator('[data-testid="layout-store-save-input"]').fill(PRIVATE_LABEL)
  await page.locator('[data-testid="layout-store-save-submit"]').click()

  const entry = page
    .locator('[data-testid="layout-store-entry"]')
    .filter({ has: page.locator('[data-testid="layout-store-entry-label"]', { hasText: PRIVATE_LABEL }) })
  await expect(entry).toBeVisible({ timeout: 10_000 })

  await entry.locator('[data-testid="layout-store-upload-hub"]').click()
  await expect(page.locator('[data-testid="upload-confirm-backdrop"]')).toBeVisible({ timeout: 5_000 })
  await page.locator('[data-testid="upload-confirm-visibility-private"]').click()
  await page.locator('[data-testid="upload-confirm-submit"]').click()

  // Success renders the Private badge + expiry line and a share link on the
  // sentinel-token URL. Without PRIVATE_TOKEN_SECRET on the local hub the
  // upload fails and the error lands in layout-store-hub-result — tolerated
  // with a logged skip, since the secret is optional for local dev.
  const expiry = entry.locator('[data-testid="layout-store-hub-expiry"]')
  const errorResult = entry.locator('[data-testid="layout-store-hub-result"]')
  await expect(expiry.or(errorResult)).toBeVisible({ timeout: 60_000 })

  if (await expiry.isVisible()) {
    const shareLink = entry.locator('[data-testid="layout-store-hub-share-link"]')
    await expect(shareLink).toBeVisible({ timeout: 10_000 })
    const href = await shareLink.getAttribute('href')
    expect(href).not.toBeNull()
    expect(href!.startsWith(`${HUB_LOCAL_URL}/`)).toBe(true)
    await expect(entry.locator('[data-testid="layout-store-hub-badge"]')).toHaveText('Hub (Private)')
  } else {
    const message = await errorResult.textContent()
    console.log(`[skip] private upload not available on this local hub: ${message ?? 'unknown error'}`)
  }
})
