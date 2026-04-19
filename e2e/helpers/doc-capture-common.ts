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
