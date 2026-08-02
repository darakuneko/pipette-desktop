// SPDX-License-Identifier: GPL-2.0-or-later
//
// Local store for user-imported i18n language packs.
//
// Layout (under userData):
//   sync/i18n/index.json                    — I18nPackIndex (LWW + tombstone, drag order)
//   sync/i18n/packs/{packId}.json           — I18nPackEntryFile.raw (pack JSON verbatim)
//
// Unlike `key-labels` (one sync unit covering both index + files), i18n
// uses two sync unit families: `i18n/index` for the index and
// `i18n/packs/{packId}` for each pack body. notifyChange is split
// accordingly so a single pack edit does not bump every other pack's
// remote LWW timestamp.
//
// This file is the facade: it owns no logic of its own and re-exports
// the full public surface from the sibling modules in this directory:
//
//   i18n-pack-store-internal.ts — path helpers, write-lock, result type, index I/O
//   i18n-pack-store-sync.ts     — sync entry points (pack-bundle-merge.ts)
//   i18n-pack-store-gc.ts       — tombstone purge + orphan-file sweep
//   i18n-pack-store-crud.ts     — public CRUD API + built-in English entry
//
// New logic belongs in the sibling module whose responsibility it
// extends — not here. External consumers (i18n-pack-ipc.ts,
// pack-bundle-merge.ts, pack-gc.ts, i18n-startup-sync.ts, hub-ipc-packs.ts,
// and every test file's partial mock of this facade path) must keep
// importing this facade path, never a submodule directly. See
// .claude/tasks/backlog/Task-split-i18n-pack-store.md and
// .claude/rules/file-splitting.md for the split rationale.

export type { I18nPackRecord } from '../shared/types/i18n-store'

export type { I18nPackStoreErrorCode, I18nPackStoreResult } from './i18n-pack-store-internal'
export { readIndex, __testing } from './i18n-pack-store-internal'

export type { ApplyPackBodyOutcome } from './i18n-pack-store-sync'
export { mergeSyncedIndex, statLocalPackMtime, applySyncedPackBody, pinPackBodyMtime } from './i18n-pack-store-sync'

export { runGcUnderLock } from './i18n-pack-store-gc'

export type { SavePackInput } from './i18n-pack-store-crud'
export {
  listMetas,
  listAllMetas,
  getPack,
  savePack,
  renamePack,
  setEnabled,
  deletePack,
  setHubPostId,
  hasActiveName,
  reorderActive,
  exportPackToDialog,
  resetAllI18nPacks,
} from './i18n-pack-store-crud'
