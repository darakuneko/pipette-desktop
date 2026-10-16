// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI members of the sync password change of the Tauri build: the
// change, its status, resume, revert, abandon, the undecryptable files and
// the Drive locks. Each is a backend command
// (src-tauri/src/sync_commands/password_change.rs); the new password goes
// to the backend and never comes back to the page.
// coverage.test.ts lists the members each of these modules holds.

import type {
  PasswordChangeDeleteResult,
  PasswordChangeLockStatus,
  PasswordChangeStatus,
  SyncOperationResult,
  UndecryptableFile,
} from '../../shared/types/sync'
import type { VialAPI } from '../../shared/types/vial-api'
import { call } from '../ipc'

export const syncPasswordChangeApi = {
  syncChangePassword: (newPassword) => call<SyncOperationResult>('sync_change_password', { newPassword }),
  syncPasswordChangeStatus: () => call<PasswordChangeStatus>('sync_password_change_status'),
  syncPasswordChangeResume: () => call<SyncOperationResult>('sync_password_change_resume'),
  syncPasswordChangeRevert: () => call<SyncOperationResult>('sync_password_change_revert'),
  syncPasswordChangeAbandon: () => call<SyncOperationResult>('sync_password_change_abandon'),
  syncPasswordChangeDeleteUndecryptable: (fileIds) =>
    call<PasswordChangeDeleteResult>('sync_password_change_delete_undecryptable', { fileIds }),
  syncPasswordChangeLockStatus: () => call<PasswordChangeLockStatus | null>('sync_password_change_lock_status'),
  syncPasswordChangeReleaseLocks: () => call<SyncOperationResult>('sync_password_change_release_locks'),
  syncListUndecryptable: () => call<UndecryptableFile[]>('sync_list_undecryptable'),
} satisfies Partial<VialAPI>
