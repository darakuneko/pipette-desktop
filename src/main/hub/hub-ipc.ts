// SPDX-License-Identifier: GPL-2.0-or-later
// IPC handler for Hub upload operations.
//
// This file is the facade: it owns no logic of its own and re-exports
// the full public surface from the sibling modules in this directory:
//
//   hub-ipc-shared.ts             — input validators + small pure helpers
//   hub-ipc-token.ts              — JWT cache + auth-retry wrapper
//   hub-ipc-analytics-prepare.ts  — shared analytics-export assembly
//   hub-ipc-posts.ts              — keymap post CRUD + auth-me handlers
//   hub-ipc-favorite.ts           — favorite (feature) post handlers
//   hub-ipc-analytics.ts          — analytics post upload/update/preview
//   hub-ipc-private.ts            — private (unlisted) upload handlers
//   hub-ipc-packs.ts              — i18n + theme pack handlers
//   hub-ipc-key-labels.ts         — Key Label Hub handlers
//
// New Hub IPC logic belongs in the sibling module whose responsibility
// it extends — not here. External consumers (sync-ipc.ts, main/index.ts,
// and every test file's mock of this facade path) must keep importing
// this facade path, never a submodule directly. See
// .claude/tasks/backlog/Task-split-hub-ipc.md and
// .claude/rules/file-splitting.md for the split rationale.

import { registerHubPostHandlers } from './hub-ipc-posts'
import { registerHubFavoriteHandlers } from './hub-ipc-favorite'
import { registerHubAnalyticsHandlers } from './hub-ipc-analytics'
import { registerHubPrivateHandlers } from './hub-ipc-private'
import { registerHubPackHandlers } from './hub-ipc-packs'
import { registerHubKeyLabelHandlers } from './hub-ipc-key-labels'

export function setupHubIpc(): void {
  registerHubPostHandlers()
  registerHubFavoriteHandlers()
  registerHubAnalyticsHandlers()
  registerHubPrivateHandlers()
  registerHubPackHandlers()
  registerHubKeyLabelHandlers()
}

export { clearHubTokenCache } from './hub-ipc-token'
