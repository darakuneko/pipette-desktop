// SPDX-License-Identifier: GPL-2.0-or-later
// IPC handler for the Aozora Bunko catalog importer.

import { IpcChannels } from '../../shared/ipc/channels'
import { secureHandle } from '../ipc-guard'
import { importAozoraWork } from './aozora-import'
import type { AozoraImportResult } from '../../shared/types/aozora-import'

export function setupAozoraIpc(): void {
  secureHandle(
    IpcChannels.AOZORA_IMPORT,
    async (_event, workId: unknown): Promise<AozoraImportResult> => {
      if (typeof workId !== 'string' || !workId) {
        return { success: false, errorCode: 'NOT_IN_CATALOG', error: 'Invalid work id' }
      }
      return importAozoraWork(workId)
    },
  )
}
