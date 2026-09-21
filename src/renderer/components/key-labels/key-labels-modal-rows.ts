// SPDX-License-Identifier: GPL-2.0-or-later
//
// Row builders for KeyLabelsModal.tsx's Installed and Find on Hub tabs
// (InstalledRow / HubRow, defined in KeyLabelsInstalledTable.tsx), plus
// the shared Hub-error translator both tabs use.

import type { TFunction } from 'i18next'
import { resolveLayoutDisplayName } from '../../hooks/useLayoutOptions'
import { HUB_ERROR_KEY_LABEL_DUPLICATE, type HubKeyLabelItem } from '../../../shared/types/hub-key-label'
import type { KeyLabelMeta } from '../../../shared/types/key-label-store'
import { BUILTIN_QWERTY_LAYOUT_ID } from '../../data/keyboard-layouts'
import { isHubItemInstalled, type InstalledDetectionEntry } from '../pack-modal/installed-detection'
import { localizeHubError } from '../../utils/hub-error-i18n'
import { type InstalledRow, type HubRow } from './KeyLabelsInstalledTable'

/**
 * Build rows directly from the store metas. The main-side
 * `ensureQwertyEntry` guarantees a QWERTY entry exists, so QWERTY
 * participates in the same drag / sync ordering as every other label.
 * Newly downloaded labels arrive at the end of `metas` (saveRecord
 * appends), drag reorders persist via `KEY_LABEL_STORE_REORDER`.
 *
 * `name` goes through `resolveLayoutDisplayName` — the same override
 * `useLayoutOptions` applies for the footer/Settings dropdowns — so the
 * built-in QWERTY row reads "QWERTY (Default)" here too, instead of the
 * raw `meta.name` string persisted on disk.
 */
export function buildInstalledRows(
  metas: KeyLabelMeta[],
  isKeymapWritable: (id: string) => boolean,
  t: TFunction,
): InstalledRow[] {
  return metas.map((meta) => ({
    reactKey: `local:${meta.id}`,
    localId: meta.id,
    hubPostId: meta.hubPostId ?? null,
    name: resolveLayoutDisplayName(meta.id, meta.name, t),
    // The Author column shows the cached Hub `uploader_name`. Empty
    // for never-uploaded local imports.
    author: meta.uploaderName ?? '',
    isQwerty: meta.id === BUILTIN_QWERTY_LAYOUT_ID,
    keymapWritable: isKeymapWritable(meta.id),
    meta,
  }))
}

export function buildHubRows(items: HubKeyLabelItem[], metas: KeyLabelMeta[]): HubRow[] {
  // hubPostId-first + name-fallback (unified with Language/Theme Packs
  // — see installed-detection.ts). Sorting now happens upstream in
  // useHubSearchList, shared by all three modals.
  const installedEntries: InstalledDetectionEntry[] = metas.map((m) => ({ hubPostId: m.hubPostId, name: m.name }))
  return items.map((item) => ({
    reactKey: `hub:${item.id}`,
    hubPostId: item.id,
    name: item.name,
    author: item.uploader_name ?? '',
    alreadyInstalled: isHubItemInstalled(item, installedEntries),
  }))
}

export function translateError(
  t: TFunction,
  code: string | undefined,
  error: string | undefined,
): string {
  if (code === 'DUPLICATE_NAME' || error === HUB_ERROR_KEY_LABEL_DUPLICATE) {
    return t('keyLabels.errorDuplicate')
  }
  if (code === 'INVALID_FILE') return t('keyLabels.errorImportFailed')
  if (code === 'INVALID_NAME') return t('keyLabels.errorInvalidName')
  // Falls through to the shared Hub error mapper — covers RATE_LIMITED
  // (429) and the other bare sentinels/HubHttpError shapes that a
  // main-side hub call (upload/update/sync/delete) can surface, none of
  // which the codes above account for.
  return localizeHubError(error, 'keyLabels.errorGeneric', t)
}
