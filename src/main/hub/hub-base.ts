// SPDX-License-Identifier: GPL-2.0-or-later
//
// Single source of truth for the Hub API base URL and the local test
// account override. Every getter reads process.env live (never cached
// at module load) — the same predicate style as
// src/main/virtual-device/index.ts — so tests can toggle the env vars
// per-case without vi.resetModules.

export const HUB_API_DEFAULT = 'https://pipette-hub-worker.keymaps.workers.dev'

/**
 * The PIPETTE_HUB_URL override is honored in dev (Vite renderer URL
 * present) or when PIPETTE_HUB_TEST=1 explicitly opts a production
 * build into the local-hub test mode (E2E / doc-capture runs).
 */
export function isHubUrlOverrideAllowed(): boolean {
  return !!process.env.ELECTRON_RENDERER_URL || process.env.PIPETTE_HUB_TEST === '1'
}

/** Effective Hub API base URL, trailing slashes stripped. */
export function getHubApiBase(): string {
  const override = process.env.PIPETTE_HUB_URL
  if (override && isHubUrlOverrideAllowed()) {
    return override.replace(/\/+$/, '')
  }
  return HUB_API_DEFAULT
}

/** Origin used to build share/open links — same value as the API base. */
export function getHubOrigin(): string {
  return getHubApiBase()
}

/**
 * Email of the local Hub test account (PIPETTE_HUB_TEST_ACCOUNT), or
 * null when test auth must not be used. Fail-closed: the account is
 * only returned when the *effective* API base resolves to a localhost
 * Hub, so an app pointing at the production Hub can never fake auth —
 * even with the account variable set.
 */
export function getHubTestAccount(): string | null {
  const account = process.env.PIPETTE_HUB_TEST_ACCOUNT
  if (!account) return null
  try {
    const { hostname } = new URL(getHubApiBase())
    if (hostname === 'localhost' || hostname === '127.0.0.1') return account
  } catch {
    // Malformed override URL — treat as not local.
  }
  return null
}
