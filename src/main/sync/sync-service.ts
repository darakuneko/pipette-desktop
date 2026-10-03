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
//   sync-password-change.ts  — resumable password change (+ -switch, -state, -lock)
//   sync-password-guard.ts   — blocks every sync while a password change is in progress
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
// facade path, never a submodule directly.
//
// New module-private mutable state must either live on `syncRuntime`
// (sync-runtime-state.ts) or ship its own `*ForTests` reset seam called
// from `_resetForTests` below — the same convention
// typing-analytics-service.ts's facade split uses.

import { syncRuntime } from './sync-runtime-state'
import { stopPolling, clearInFlightPollForTests } from './sync-polling'
import { clearQuitFinalizersForTests } from './sync-flush'
import { forgetChangeStateCache } from './sync-password-change-state'
import { clearSyncFormatStatus } from './sync-format-status'

// --- Test helpers -------------------------------------------------------

export function _resetForTests(): void {
  if (syncRuntime.debounceTimer) {
    clearTimeout(syncRuntime.debounceTimer)
    syncRuntime.debounceTimer = null
  }
  stopPolling()
  clearInFlightPollForTests()
  syncRuntime.pendingChanges.clear()
  syncRuntime.lastKnownRemoteState.clear()
  syncRuntime.isSyncing = false
  syncRuntime.isQuitting = false
  syncRuntime.progressCallback = null
  syncRuntime.validatedPasswordCheck = null
  syncRuntime.passwordCheckCreated = null
  syncRuntime.passwordCheckCreating = null
  syncRuntime.syncFormatMarkerCreatedAt = null
  syncRuntime.syncFormatMarkerSeenAt = null
  syncRuntime.syncFormatMarkerCreating = null
  syncRuntime.passwordChangeUndecryptable = null
  syncRuntime.passwordChangeLockLost = false
  syncRuntime.passwordChangeRun = null
  syncRuntime.analyticsSyncingUids.clear()
  clearQuitFinalizersForTests()
  forgetChangeStateCache()
  clearSyncFormatStatus()
}

// --- Public re-exports ---------------------------------------------------
// Explicit named re-exports only (never `export *`) so the facade's public
// surface is grep-able in one place.

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

export { SyncBlockedError, assertSyncAllowed, assertNoLocalPasswordChange } from './sync-password-guard'
export { forgetCreatedSyncFormatMarker } from './sync-format'
export {
  getCachedSyncFormatStatus,
  refreshSyncFormatStatus,
  clearSyncFormatStatus,
  setSyncFormatStatusListener,
} from './sync-format-status'
export { forgetChangeStateCache } from './sync-password-change-state'

export {
  resetPasswordCheckCache,
  checkPasswordCheckExists,
  setPasswordAndValidate,
  replacePasswordAndValidate,
} from './sync-password'

export type { DeleteUndecryptableResult, PasswordChangeRecovery } from './sync-password-change'
export {
  startPasswordChange,
  resumePasswordChange,
  revertPasswordChange,
  abandonPasswordChange,
  deletePasswordChangeUndecryptableFiles,
  recoverPasswordChangeOnStartup,
  getPasswordChangeStatus,
} from './sync-password-change'
export { getPasswordChangeLockStatus, releasePasswordChangeLocks } from './sync-password-lock-release'

export type { SyncExecuteResult } from './sync-execute'
export { executeSync } from './sync-execute'

export {
  hasAnyRemoteTypingData,
  listRemoteTypingHashesForUidFromCloud,
  listRemoteTypingDaysFor,
  deleteRemoteTypingDay,
  fetchRemoteTypingDay,
} from './sync-typing-remote'

export { startPolling, stopPolling, waitForPollPassForTests } from './sync-polling'

export { executeAnalyticsSync } from './sync-analytics'

export {
  notifyChange,
  registerPreSyncQuitFinalizer,
  registerBeforeQuitFinalizer,
  setupBeforeQuitHandler,
} from './sync-flush'
