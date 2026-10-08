// SPDX-License-Identifier: GPL-2.0-or-later
// Success / failure envelope shared by the sync IPC handlers (sync-ipc.ts,
// sync-reset-ipc.ts).

import { AccountSwitchBusyError, SyncCredentialError } from './sync-service'
import type { SyncOperationResult } from '../../shared/types/sync'

export type IpcResult = Pick<SyncOperationResult, 'success' | 'error' | 'reason'>

// `T` lets a handler pass a payload back through the same success/failure
// wrapping every other handler uses, instead of bypassing wrapIpc entirely
// just to add one extra field (IMPORT_LOCAL_DATA uses this to return
// `cancelled`). Most callers don't need it and leave T at its default —
// `fn` returning `void` merges nothing extra in. `Omit<T, keyof IpcResult>`
// keeps a handler's payload from clobbering the envelope: `fn` can't
// declare its own `success`/`error`/`reason` field, so the spread below can
// never overwrite the ones this wrapper sets.
export async function wrapIpc<T extends object = object>(fallbackMessage: string, fn: () => Promise<Omit<T, keyof IpcResult> | void>): Promise<IpcResult & T> {
  try {
    const payload = await fn()
    return { success: true, ...(payload ?? {}) } as IpcResult & T
  } catch (err) {
    if (err instanceof SyncCredentialError || err instanceof AccountSwitchBusyError) {
      return { success: false, error: err.message, reason: err.reason } as IpcResult & T
    }
    return { success: false, error: err instanceof Error ? err.message : fallbackMessage } as IpcResult & T
  }
}
