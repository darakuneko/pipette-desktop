// SPDX-License-Identifier: GPL-2.0-or-later
//
// Startup auto-update for Hub-linked i18n language packs.
//
// Algorithm:
//   1. Read every active local pack meta that carries a `hubPostId`.
//   2. Hit `POST /api/i18n-packs/timestamps` in 100-id chunks (the
//      server cap) to fetch the canonical Hub-side `updated_at` for
//      each pack. Missing ids signal a Hub-side deletion.
//   3. For packs whose Hub `updated_at` does not match the cached
//      `hubUpdatedAt` (or where `hubUpdatedAt` is unset), download the
//      fresh pack body, validate it, and persist via `savePack`. Pack
//      id, hubPostId, enabled state, and rename history are preserved
//      because we pass the existing local id back into `savePack`.
//   4. Errors are logged and counted but never thrown — startup must
//      not be blocked by network glitches or a single bad pack.
//
// Coverage / matchedBaseVersion are deliberately not recomputed here.
// The renderer's `useI18nPackStore` hook recomputes coverage whenever
// the meta list changes (see `refreshCoverageFromIpc` consumers), so
// the post-sync change broadcast triggers that path automatically.
//
// This module owns no IPC channel — wiring is in `main/index.ts` via
// `app.whenReady()` so the sync starts as soon as the network is
// available, runs in the background, and notifies the renderer when
// done so any open language picker reflects the refreshed packs.

import { BrowserWindow } from 'electron'
import { downloadI18nPostBody, fetchI18nPackTimestamps, validateI18nExport } from './hub-i18n'
import { listMetas, savePack } from '../i18n-pack-store'
import { log } from '../logger'
import { IpcChannels } from '../../shared/ipc/channels'
import { HUB_I18N_PACK_TIMESTAMPS_BATCH_LIMIT } from '../../shared/types/hub'
import type { I18nPackMeta } from '../../shared/types/i18n-store'

export interface I18nStartupSyncResult {
  /** Number of Hub-linked packs that were checked. */
  checked: number
  /** Number of packs that were re-downloaded because Hub had newer content. */
  updated: number
  /** Number of packs whose Hub post is missing (deleted upstream). The
   *  local copy is kept; the user can decide whether to detach it. */
  missingOnHub: number
  /** Per-pack errors collected during the sync. Empty on a clean run. */
  errors: Array<{ packId: string; hubPostId: string; reason: string }>
}

const EMPTY_RESULT: I18nStartupSyncResult = {
  checked: 0,
  updated: 0,
  missingOnHub: 0,
  errors: [],
}

interface HubLinkedPack {
  meta: I18nPackMeta
  hubPostId: string
}

function pickHubLinked(metas: I18nPackMeta[]): HubLinkedPack[] {
  // `listMetas()` already filters tombstoned entries, so we only need
  // to drop packs that have never been linked to a Hub post.
  const out: HubLinkedPack[] = []
  for (const meta of metas) {
    const hubPostId = meta.hubPostId?.trim()
    if (!hubPostId) continue
    out.push({ meta, hubPostId })
  }
  return out
}

function describeError(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err)
}

function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items]
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}

async function fetchTimestampsByPostId(
  hubPostIds: string[],
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(hubPostIds))
  if (unique.length === 0) return new Map()
  const chunks = chunk(unique, HUB_I18N_PACK_TIMESTAMPS_BATCH_LIMIT)
  const responses = await Promise.all(chunks.map((ids) => fetchI18nPackTimestamps(ids)))
  const byId = new Map<string, string>()
  for (const r of responses) {
    for (const item of r.items) byId.set(item.id, item.updated_at)
  }
  return byId
}

/**
 * Run a one-shot reconcile pass against Pipette Hub. Safe to call from
 * `app.whenReady()` as fire-and-forget — the function never throws,
 * resolves with a summary the caller can log, and skips packs that are
 * not Hub-linked.
 */
export async function syncHubI18nPacksOnStartup(): Promise<I18nStartupSyncResult> {
  let metas: I18nPackMeta[]
  try {
    metas = await listMetas()
  } catch (err) {
    log('warn', `i18n startup sync: failed to read pack index: ${describeError(err)}`)
    return EMPTY_RESULT
  }

  const linked = pickHubLinked(metas)
  if (linked.length === 0) return EMPTY_RESULT

  let hubTimestamps: Map<string, string>
  try {
    hubTimestamps = await fetchTimestampsByPostId(linked.map((p) => p.hubPostId))
  } catch (err) {
    log('warn', `i18n startup sync: timestamps fetch failed: ${describeError(err)}`)
    return { ...EMPTY_RESULT, checked: linked.length, errors: [] }
  }

  const result: I18nStartupSyncResult = {
    checked: linked.length,
    updated: 0,
    missingOnHub: 0,
    errors: [],
  }

  // Run downloads in parallel — each pack is independent and the Hub
  // download endpoint is anonymous + cached server-side.
  await Promise.all(linked.map(async ({ meta, hubPostId }): Promise<void> => {
    const remote = hubTimestamps.get(hubPostId)
    if (!remote) {
      result.missingOnHub += 1
      return
    }
    if (meta.hubUpdatedAt && meta.hubUpdatedAt === remote) return

    try {
      const exportData = await downloadI18nPostBody(hubPostId)
      const validation = validateI18nExport(exportData)
      if (!validation.ok) {
        result.errors.push({
          packId: meta.id,
          hubPostId,
          reason: `invalid pack from Hub: ${validation.reason ?? 'unknown'}`,
        })
        return
      }
      const saved = await savePack({
        id: meta.id,
        pack: exportData.pack,
        hubPostId,
        hubUpdatedAt: remote,
        // `enabled` is intentionally omitted so `savePack` inherits the
        // current local value — the user's enable/disable choice must
        // outrank a Hub re-download.
      })
      if (!saved.success) {
        result.errors.push({
          packId: meta.id,
          hubPostId,
          reason: `savePack failed: ${saved.error ?? 'unknown'}`,
        })
        return
      }
      result.updated += 1
    } catch (err) {
      result.errors.push({ packId: meta.id, hubPostId, reason: describeError(err) })
    }
  }))

  return result
}

function reportSyncResult(result: I18nStartupSyncResult): void {
  if (result.checked === 0) return
  log(
    'info',
    `i18n startup sync: checked=${String(result.checked)} updated=${String(result.updated)} missingOnHub=${String(result.missingOnHub)} errors=${String(result.errors.length)}`,
  )
  for (const err of result.errors) {
    log('warn', `i18n startup sync error pack=${err.packId} hub=${err.hubPostId}: ${err.reason}`)
  }
  if (result.updated > 0) {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IpcChannels.I18N_PACK_CHANGED)
    }
  }
}

/**
 * Fire-and-forget wrapper for `app.whenReady()`. Runs the sync,
 * reports the outcome, and broadcasts `I18N_PACK_CHANGED` when any
 * pack was refreshed. Never throws — unexpected errors land on the
 * `.catch` and are logged.
 */
export function startI18nStartupSync(): void {
  void syncHubI18nPacksOnStartup()
    .then(reportSyncResult)
    .catch((err: unknown) => {
      log('warn', `i18n startup sync threw unexpectedly: ${describeError(err)}`)
    })
}
