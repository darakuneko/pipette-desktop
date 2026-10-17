// SPDX-License-Identifier: GPL-2.0-or-later
// The input checks the favorite post members run before they read the
// entry, as the Electron handlers run them before they read it: copies of
// src/main/hub/hub-ipc-shared.ts, byte for byte between the markers.
// __tests__/hub-favorite.test.ts compares them with that file; when it
// changes, copy them again.

// --- copied from src/main/hub/hub-ipc-shared.ts ---
export const POST_ID_RE = /^[a-zA-Z0-9_-]+$/

export function validatePostId(postId: string): void {
  if (!postId || !POST_ID_RE.test(postId)) {
    throw new Error('Invalid post ID')
  }
}

const TITLE_MAX_LENGTH = 200

export function validateTitle(title: unknown): string {
  if (typeof title !== 'string' || title.trim().length === 0) throw new Error('Title must not be empty')
  const trimmed = title.trim()
  if (trimmed.length > TITLE_MAX_LENGTH) throw new Error('Title too long')
  return trimmed
}

export function extractError(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}
// --- end of the copy ---
