// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI members of the Data modal's Sync side in the Tauri build: the
// scan of Drive, a remote bundle, the deletes, the trash, and the export and
// import of the local data.
// The export and the import are the backend's (src-tauri/src/sync_commands/
// data.rs), which shows their file dialogs. The other members are not backed
// by a backend command yet; until one is, the shim answers each with the
// fixed answer of fakes.ts or the stub of create-vial-api.ts.
// coverage.test.ts lists the members each of these modules holds.

import type { ImportLocalDataResult, SyncOperationResult } from '../../shared/types/sync'
import type { VialAPI } from '../../shared/types/vial-api'
import { call } from '../ipc'

export const syncDataApi = {
  exportLocalData: () => call<SyncOperationResult>('export_local_data'),
  importLocalData: () => call<ImportLocalDataResult>('import_local_data'),
} satisfies Partial<VialAPI>
