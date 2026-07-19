// SPDX-License-Identifier: GPL-2.0-or-later
//
// Renderer-side counterpart to `enrichHubPackMeta` in `hub-ipc.ts`.
// Language/Theme Pack downloads and syncs only return the pack body —
// no `uploaderName`/`updatedAt` — so this re-uses the already-exposed
// Hub list IPC (`hubListI18nPosts` / `hubListThemePosts`) with its
// exact-name filter to look up the just-downloaded item and read its
// `uploaderName`/`updatedAt` off the list response. Best-effort: any
// failure (or the id simply not being in that name's results) yields
// `{}`, and the caller's `applyImport` options end up `undefined` for
// both fields — the store leaves any previously-cached values alone.

export interface HubPackListItemLike {
  id: string
  uploaderName?: string | null
  updatedAt?: string
}

export async function fetchHubPackMeta(
  listByName: (params: { name: string }) => Promise<{ success: boolean; data?: { items: HubPackListItemLike[] } }>,
  name: string,
  postId: string,
): Promise<{ uploaderName?: string; hubUpdatedAt?: string }> {
  try {
    const result = await listByName({ name })
    if (!result.success || !result.data) return {}
    const item = result.data.items.find((i) => i.id === postId)
    return {
      uploaderName: item?.uploaderName ?? undefined,
      hubUpdatedAt: item?.updatedAt ?? undefined,
    }
  } catch {
    return {}
  }
}
