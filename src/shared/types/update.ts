// SPDX-License-Identifier: GPL-2.0-or-later
// The in-app update of the Tauri build (src-tauri/src/updater.rs). The
// Electron build has none: its check answers `disabled`.

/** Why an update step failed. `busy`: another check or the update is
 *  running; `cancelled`: the app started quitting first. */
export type UpdateErrorCode = 'network' | 'signature' | 'permission' | 'cancelled' | 'busy' | 'unknown'

/** What a check found. `skipped`: the user chose to skip exactly this
 *  version, so it is not offered at startup. */
export type UpdateCheckResult =
  | { status: 'disabled' }
  | { status: 'upToDate' }
  | { status: 'available'; version: string; currentVersion: string; releaseUrl: string; skipped: boolean }
  | { status: 'failed'; code: UpdateErrorCode }

/** What applying the update answered; on success the app is quitting. */
export type UpdateInstallResult =
  | { status: 'restarting' }
  | { status: 'failed'; code: UpdateErrorCode; releaseUrl: string }

/** The download's progress in bytes; `total` is null without a size. */
export interface UpdateProgress {
  downloaded: number
  total: number | null
}

/** The failure the last update left for this launch (Windows, when the
 *  installer could not start). */
export interface UpdateFailure {
  version: string
  code: UpdateErrorCode
  releaseUrl: string
}
