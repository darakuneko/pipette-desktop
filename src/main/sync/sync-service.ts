// SPDX-License-Identifier: GPL-2.0-or-later
// Sync orchestration: bundling, conflict resolution, debounce upload,
// before-quit flush.
//
// This file is the facade: it owns no logic of its own (besides
// `_resetForTests`, which delegates to each sibling module's own reset)
// and re-exports the full public surface from the sibling modules in
// this directory:
//
//   sync-runtime-state.ts    — shared mutable state + small accessors
//   sync-scope.ts            — SyncScope matching / download filtering
//   sync-password.ts         — credentials + password-check validation
//   sync-merge-dispatch.ts   — per-sync-unit upload/merge/dispatch
//   sync-scan.ts             — remote data inspection (scan/undecryptable)
//   sync-typing-remote.ts    — typing-analytics remote day bookkeeping
//   sync-execute.ts          — full-pass download/upload sync
//   sync-polling.ts          — 3-minute background polling
//   sync-analytics.ts        — Analyze-panel-triggered analytics sync
//   sync-flush.ts            — debounced auto-sync + before-quit handler
//
// New sync logic belongs in the sibling module whose responsibility it
// extends — not here. External consumers (sync-ipc.ts, main/index.ts,
// the 9+ store files that call `notifyChange`, and every test file's
// whole-module mock of this facade path) must keep importing this
// facade path, never a submodule directly — this facade/sibling split
// keeps every file under the project's 800-line Service/Util size
// ceiling while preserving one stable import path for consumers.
//
// New module-private mutable state must either live on `syncRuntime`
// (sync-runtime-state.ts) or ship its own `*ForTests` reset seam called
// from `_resetForTests` below — the same convention
// typing-analytics-service.ts's facade split uses.

import { syncRuntime } from './sync-runtime-state'
import { stopPolling } from './sync-polling'
import { clearQuitFinalizersForTests } from './sync-flush'

// --- Test helpers -------------------------------------------------------

export function _resetForTests(): void {
  if (syncRuntime.debounceTimer) {
    clearTimeout(syncRuntime.debounceTimer)
    syncRuntime.debounceTimer = null
  }
  stopPolling()
  syncRuntime.pendingChanges.clear()
  syncRuntime.lastKnownRemoteState.clear()
  syncRuntime.isSyncing = false
  syncRuntime.isQuitting = false
  syncRuntime.progressCallback = null
  syncRuntime.passwordCheckValidated = false
  clearQuitFinalizersForTests()
}

// --- Public re-exports ---------------------------------------------------
// Explicit named re-exports only (never `export *`) so the facade's public
// surface is grep-able in one place and stays byte-identical to what it was
// before the split.

export { SyncCredentialError } from './sync-password'

export {
  hasPendingChanges,
  cancelPendingChanges,
  isSyncInProgress,
  setProgressCallback,
} from './sync-runtime-state'

export { matchesScope, shouldDownloadSyncUnit } from './sync-scope'

// Re-export the analytics/run-log sync-unit detectors so existing
// callers (sync-ipc, tests) keep importing them from sync-service.
export { isAnalyticsSyncUnit, isRunLogSyncUnit } from './sync-bundle'

// Re-export bundle functions for backward compatibility
export { readIndexFile, bundleSyncUnit, collectAllSyncUnits } from './sync-bundle'

export { listUndecryptableFiles, scanRemoteData, fetchRemoteBundle, listRemoteFileNames } from './sync-scan'

export {
  changePassword,
  resetPasswordCheckCache,
  checkPasswordCheckExists,
  setPasswordAndValidate,
} from './sync-password'

export type { SyncExecuteResult } from './sync-execute'
export { executeSync } from './sync-execute'

export {
  hasAnyRemoteTypingData,
  listRemoteTypingHashesForUidFromCloud,
  listRemoteTypingDaysFor,
  deleteRemoteTypingDay,
  fetchRemoteTypingDay,
} from './sync-typing-remote'

export { startPolling, stopPolling } from './sync-polling'

export { executeAnalyticsSync } from './sync-analytics'

export {
  notifyChange,
  registerPreSyncQuitFinalizer,
  registerBeforeQuitFinalizer,
  setupBeforeQuitHandler,
} from './sync-flush'
