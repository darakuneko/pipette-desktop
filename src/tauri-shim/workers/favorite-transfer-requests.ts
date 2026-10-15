// SPDX-License-Identifier: GPL-2.0-or-later
// What the favorite transfer worker (favorite-transfer.worker.ts) does for
// each request: the keycode conversion and file building of the favorite
// export and import (src/shared/favorite-transfer.ts), on the worker's own
// copy of the keycode tables. Every answer is a value; an exception is
// answered as `{ error: String(err) }`, the text the Electron handlers
// answer for it.

import {
  buildCurrentFavoriteExport,
  buildFavoriteExport,
  favoriteDataForCurrent,
  planFavoriteImport,
  readFavoriteExportFile,
  type FavoriteExportBody,
  type FavoriteExportBuild,
  type FavoriteImportPlan,
} from '../../shared/favorite-transfer'
import type { FavoriteType } from '../../shared/types/favorite-store'

export type FavoriteTransferRequest =
  /** The export file of stored favorites, as the backend read them. */
  | { op: 'export'; scope: FavoriteType; vialProtocol: number; bodies: FavoriteExportBody[]; single: boolean }
  /** The export file of the editor's current value. */
  | { op: 'exportCurrent'; scope: FavoriteType; vialProtocol: number; dataJson: string }
  /** The first `scope` favorite of the export file `raw`, for the editor. */
  | { op: 'importToCurrent'; scope: FavoriteType; raw: string }
  /** The batches to store for the export file `raw`. */
  | { op: 'import'; raw: string }

export interface FavoriteTransferResults {
  export: FavoriteExportBuild
  exportCurrent: FavoriteExportBuild
  importToCurrent: { data: unknown } | { error: string }
  import: { plan: FavoriteImportPlan } | { error: string }
}

export type FavoriteTransferResult<R extends FavoriteTransferRequest> = FavoriteTransferResults[R['op']]

const INVALID_FILE = { error: 'Invalid export file format' }

function answer(request: FavoriteTransferRequest): FavoriteTransferResults[FavoriteTransferRequest['op']] {
  const now = new Date()
  switch (request.op) {
    case 'export':
      return buildFavoriteExport(request.scope, request.vialProtocol, request.bodies, request.single, now)
    case 'exportCurrent':
      return buildCurrentFavoriteExport(request.scope, request.vialProtocol, request.dataJson, now)
    case 'importToCurrent': {
      const file = readFavoriteExportFile(request.raw)
      return file ? favoriteDataForCurrent(request.scope, file) : INVALID_FILE
    }
    case 'import': {
      const file = readFavoriteExportFile(request.raw)
      return file ? { plan: planFavoriteImport(file) } : INVALID_FILE
    }
  }
}

export function runFavoriteTransfer<R extends FavoriteTransferRequest>(request: R): FavoriteTransferResult<R> {
  try {
    return answer(request) as FavoriteTransferResult<R>
  } catch (err) {
    return { error: String(err) } as FavoriteTransferResult<R>
  }
}
