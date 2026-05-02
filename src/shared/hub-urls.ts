// SPDX-License-Identifier: GPL-2.0-or-later
//
// Centralised builders for Pipette Hub post URLs. Renderer code
// should go through these instead of templating paths inline so the
// ".../post/{id}" / ".../key-labels/{id}" routes stay consistent
// across favorites, layouts, and key labels.

function ensureHubPostId(id: string): string {
  return encodeURIComponent(id)
}

/** `https://{origin}/post/{id}` — favorites, layouts, etc. */
export function buildHubPostUrl(origin: string, hubPostId: string): string {
  return `${origin}/post/${ensureHubPostId(hubPostId)}`
}

/** `https://{origin}/key-labels/{id}` — Pipette Hub key-label resource. */
export function buildHubKeyLabelUrl(origin: string, hubPostId: string): string {
  return `${origin}/key-labels/${ensureHubPostId(hubPostId)}`
}
