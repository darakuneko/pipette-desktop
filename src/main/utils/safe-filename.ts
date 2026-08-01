// SPDX-License-Identifier: GPL-2.0-or-later
//
// Re-export the shared path-safety helpers for backwards-compat
// with main-process call sites. The implementations live in
// `src/shared/utils/safe-filename.ts` so the renderer can use them
// without crossing the process boundary.

export { safeFilename, isSafePathSegment, isSafePackId, tsForFilename, tsForExportFilename } from '../../shared/utils/safe-filename'
