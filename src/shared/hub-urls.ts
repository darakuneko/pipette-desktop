// SPDX-License-Identifier: GPL-2.0-or-later
//
// Centralised builders for Pipette Hub URLs. Renderer code should go
// through these instead of templating paths inline so the post
// ".../post/{id}" / ".../key-labels/{id}" / ".../i18n-packs/{id}"
// routes and the ".../?category={id}" listing routes stay consistent.

/** Hub category identifiers used both as `?category={id}` query params
 * on the Hub homepage and as the canonical name for each post type
 * across the renderer. Keep in sync with the Hub frontend. */
export const HUB_CATEGORY = {
  KEY_LABELS: 'keyLabels',
  I18N_PACKS: 'i18nPacks',
  THEME_PACKS: 'themePacks',
  FAVORITES: 'favorites',
} as const

export type HubCategory = typeof HUB_CATEGORY[keyof typeof HUB_CATEGORY]

function ensureHubPostId(id: string): string {
  return encodeURIComponent(id)
}

/** `https://{origin}/?category={category}` — Hub homepage filtered to
 * a specific category. */
export function buildHubCategoryUrl(origin: string, category: HubCategory): string {
  return `${origin}/?category=${category}`
}

/** `https://{origin}/post/{id}` — favorites, layouts, etc. */
export function buildHubPostUrl(origin: string, hubPostId: string): string {
  return `${origin}/post/${ensureHubPostId(hubPostId)}`
}

/** `https://{origin}/key-labels/{id}` — Pipette Hub key-label resource. */
export function buildHubKeyLabelUrl(origin: string, hubPostId: string): string {
  return `${origin}/key-labels/${ensureHubPostId(hubPostId)}`
}

/** `https://{origin}/i18n-packs/{id}` — Pipette Hub language pack resource. */
export function buildHubI18nPackUrl(origin: string, hubPostId: string): string {
  return `${origin}/i18n-packs/${ensureHubPostId(hubPostId)}`
}

/** `https://{origin}/theme-packs/{id}` — Pipette Hub theme pack resource. */
export function buildHubThemePackUrl(origin: string, hubPostId: string): string {
  return `${origin}/theme-packs/${ensureHubPostId(hubPostId)}`
}
