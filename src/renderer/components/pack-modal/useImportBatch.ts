// SPDX-License-Identifier: GPL-2.0-or-later
//
// Shared multi-file import batch handler for the three pack-management
// modals (Language Packs, Theme Packs, Key Labels). Each modal's
// `handleImportFile`/`handleImport` was ~80 lines, structurally
// identical: an `importInFlightRef` latch → dedupe-by-id (keep-last) →
// a hub-sync loop building per-row success badges + hub-sync failures
// → `placement.placeMany` → single-result auto-select → a 2+ file
// summary gate → failure-banner assembly. They differed only in:
//
//   (a) how the per-file raw results are obtained — Language/Theme run
//       a `store.applyImport` loop over dialog-picked files; Key Labels
//       reads a single main-side batch result (`imported`/`rejections`)
//   (b) the hub-sync function (`pushPackToHub` vs `labels.hubUpdate`)
//   (c) the optional single-result auto-select callback
//       (`handleSelectLanguage`/`handleSelectTheme`; Key Labels has none)
//
// This hook owns everything else. `collectResults` is the seam for
// (a): it runs the file-picker/save step (in whatever shape the
// feature needs) and returns every per-file outcome plus the
// placement snapshot, captured by the caller at the exact point its
// own store mutation begins — see each modal's `collectResults` for
// why that point differs (a per-file save loop vs. one batched IPC
// call). Returning `null` means there is nothing to place: either the
// user canceled, or the whole batch failed before any per-file outcome
// existed (the callback is responsible for surfacing that failure
// itself via `setActionError`, since it doesn't fit the per-file
// success/failure shape below).
//
// RE-ENTRANCY (mirrors the keymap-apply latch, previously duplicated in
// each modal): a double-click on Import before React re-renders the
// now-disabled button must not queue a second concurrent batch on top
// of the first. `importInFlightRef` is the actual guard, checked
// synchronously; `importing` just mirrors it into render so the
// disabled UI reflects it a frame sooner than a double-click could
// slip through.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import type { BatchSnapshot, UseImportPlacementResult } from './useImportPlacement'
import { buildImportBatchFailureSummary, buildImportSummary, dedupeByIdKeepLast, type ImportBatchFailure } from './import-batch-summary'
import type { PackActionResult } from './pack-modal-types'

/** One file's successfully-saved outcome within a batch: the
 *  originating filename (for failure/summary reporting, never the
 *  pack's own internal name) plus the store's own meta. */
export interface ImportBatchItem<TMeta> {
  fileName: string
  meta: TMeta
}

/** Minimal shape `useImportBatch` needs from a feature's meta type —
 *  satisfied by `I18nPackMeta` / `ThemePackMeta` / `KeyLabelMeta`. */
interface ImportBatchMeta {
  id: string
  name: string
  hubPostId?: string
}

export interface CollectedImportBatch<TMeta> {
  successes: ImportBatchItem<TMeta>[]
  /** Files that never actually landed on disk (parse/validate/store
   *  failure) — what the toolbar headline's "failure" count means; see
   *  `buildImportSummary`'s doc. */
  notSavedFailures: ImportBatchFailure[]
  snapshot: BatchSnapshot
}

export interface UseImportBatchOptions<TMeta extends ImportBatchMeta> {
  /** Gates the `importSummary` reset on close, mirroring
   *  `useImportPlacement`'s own `open`-gated resets. */
  open: boolean
  placement: UseImportPlacementResult
  setLastResult: (result: PackActionResult[] | null) => void
  setActionError: (error: string | null) => void
  t: TFunction
  /** Runs the file-picker + save step and returns every per-file
   *  outcome, or `null` when there is nothing to place (see module doc). */
  collectResults: () => Promise<CollectedImportBatch<TMeta> | null>
  /** Pushes one freshly-saved item to its already-linked Hub post.
   *  Called only when `meta.hubPostId` is set; omit for a feature with
   *  no Hub auto-sync step. Any failure reason should already be
   *  translated by the caller — this hook uses it verbatim in the
   *  failure banner. */
  hubSync?: (meta: TMeta) => Promise<{ success: boolean; error?: string }>
  /** Mirrors the single-file behavior of activating the freshly
   *  imported pack — called once, only when the batch collapses to
   *  exactly one saved result. Omitted for Key Labels, which has no
   *  such concept. */
  onCollapsedToOne?: (meta: TMeta) => void
}

export interface UseImportBatchResult {
  importing: boolean
  /** Toolbar headline for a 2+ file batch, superseding
   *  `placement.feedback`'s per-name text at each call site via
   *  `importFeedback={importSummary ?? placement.feedback}`. */
  importSummary: string | null
  runImport: () => Promise<void>
}

export function useImportBatch<TMeta extends ImportBatchMeta>({
  open,
  placement,
  setLastResult,
  setActionError,
  t,
  collectResults,
  hubSync,
  onCollapsedToOne,
}: UseImportBatchOptions<TMeta>): UseImportBatchResult {
  const [importing, setImporting] = useState(false)
  const [importSummary, setImportSummary] = useState<string | null>(null)
  const importInFlightRef = useRef(false)

  useEffect(() => {
    if (!open) setImportSummary(null)
  }, [open])

  const runImport = useCallback(async (): Promise<void> => {
    if (importInFlightRef.current) return
    importInFlightRef.current = true
    setImporting(true)
    try {
      setActionError(null)
      setLastResult(null)
      setImportSummary(null)

      const collected = await collectResults()
      if (!collected) return
      const { successes, notSavedFailures, snapshot } = collected

      // Two files resolving to the same pack (e.g. same name, so the
      // store's auto-overwrite reuses the same id) are deduped, keeping
      // only the last file's outcome — that's what actually ended up on
      // disk — so hub-sync and the row badge only run/appear once per id.
      const deduped = dedupeByIdKeepLast(successes, (item) => item.meta.id)

      const hubSyncFailures: ImportBatchFailure[] = []
      const successBadges: PackActionResult[] = []
      for (const { fileName, meta } of deduped) {
        let message = t('common.saved')
        if (meta.hubPostId && hubSync) {
          const upd = await hubSync(meta)
          if (upd.success) {
            message = t('common.synced')
          } else {
            hubSyncFailures.push({ fileName, reason: upd.error ?? t('hub.updateFailed') })
          }
        }
        successBadges.push({ id: meta.id, kind: 'success', message })
      }

      if (deduped.length > 0) {
        await placement.placeMany(
          deduped.map(({ meta }) => ({ id: meta.id, name: meta.name })),
          snapshot,
        )
        setLastResult(successBadges)
        // Mirror the single-file behaviour of activating the freshly
        // imported pack — only when the batch collapsed to a single
        // result; a 2+ batch has no single "the" import to activate.
        if (deduped.length === 1) onCollapsedToOne?.(deduped[0].meta)
      }

      // Toolbar headline for a 2+ file batch only — a single-file
      // import keeps its existing per-name "Imported {{name}}" /
      // "Updated {{name}}" feedback via `placement.feedback` untouched.
      // `buildImportSummary` self-gates below that threshold.
      const summary = buildImportSummary(t, deduped, notSavedFailures)
      if (summary) setImportSummary(summary)

      const failureSummary = buildImportBatchFailureSummary(t, [...notSavedFailures, ...hubSyncFailures])
      if (failureSummary) setActionError(failureSummary)
    } finally {
      importInFlightRef.current = false
      setImporting(false)
    }
  }, [collectResults, hubSync, onCollapsedToOne, placement, setActionError, setLastResult, t])

  return { importing, importSummary, runImport }
}
