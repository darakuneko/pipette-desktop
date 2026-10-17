// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI members of the Data modal's Sync side in the Tauri build: the
// scan of Drive, a remote bundle, the deletes, the trash, and the export and
// import of the local data. Each is a backend command
// (src-tauri/src/sync_commands/data.rs and trash.rs); the backend shows the
// export and import file dialogs.
// coverage.test.ts lists the members each of these modules holds.

import type {
  ImportLocalDataResult,
  SyncDataScanResult,
  SyncOperationResult,
  SyncTrashDeleteResult,
  SyncTrashListResult,
} from '../../shared/types/sync'
import type { VialAPI } from '../../shared/types/vial-api'
import { call } from '../ipc'

export const syncDataApi = {
  syncScanRemote: () => call<SyncDataScanResult>('sync_scan_remote'),
  syncFetchRemoteBundle: (syncUnit) => call<unknown>('sync_fetch_remote_bundle', { syncUnit }),
  syncDeleteFiles: (fileIds) => call<SyncOperationResult>('sync_delete_files', { fileIds }),
  syncListTrash: () => call<SyncTrashListResult>('sync_list_trash'),
  syncRestoreTrash: (fileId) => call<SyncOperationResult>('sync_restore_trash', { fileId }),
  syncDeleteTrash: (fileIds) => call<SyncTrashDeleteResult>('sync_delete_trash', { fileIds }),
  exportLocalData: () => call<SyncOperationResult>('export_local_data'),
  importLocalData: () => call<ImportLocalDataResult>('import_local_data'),
} satisfies Partial<VialAPI>
