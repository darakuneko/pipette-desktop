// SPDX-License-Identifier: GPL-2.0-or-later
//
// Re-export the shared `safeFilename` helper for backwards-compat
// with main-process call sites. The implementation lives in
// `src/shared/utils/safe-filename.ts` so the renderer can use it
// without crossing the process boundary.

export { safeFilename } from '../../shared/utils/safe-filename'
