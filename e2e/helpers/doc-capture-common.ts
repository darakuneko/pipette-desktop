// SPDX-License-Identifier: GPL-2.0-or-later

// Shared helpers for doc-capture scripts.
// Deduplicates the notification-modal dismissal, overlay dismissal, and
// availability-check logic that was previously copy-pasted across every
// doc-capture helper.

import type { Locator, Page } from '@playwright/test'

export async function isAvailable(locator: Locator): Promise<boolean> {
  return (await locator.count()) > 0
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
