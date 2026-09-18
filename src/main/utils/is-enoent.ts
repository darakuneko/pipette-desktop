// SPDX-License-Identifier: GPL-2.0-or-later
//
// Shared ENOENT check for the two call sites that branch on "missing
// file" vs. "some other, more interesting failure" (local-data-import's
// strict index reader, app-behavior's autostart-entry removal). Left
// open-coded at other ENOENT check sites in the codebase whose branch
// shape doesn't match this one exactly (checking `!== 'ENOENT'` to
// rethrow, or already scoped to a single well-understood call).

export function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT'
}
