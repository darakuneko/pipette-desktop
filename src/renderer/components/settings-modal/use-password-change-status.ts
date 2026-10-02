// SPDX-License-Identifier: GPL-2.0-or-later
// State of an unfinished sync password change on this machine, and of a
// password-change lock another machine (or this one) left on Google Drive,
// for the Settings › Connect tab. Both are fetched on mount, whenever the
// password form stops being busy, whenever a sync finishes
// (`lastSyncResult` changes) and after every action. A progress event with
// a `sync.passwordChange.*` message refetches only the local status: the
// lock lookup lists Drive, so it isn't repeated per progress event.

import { useState, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  LastSyncResult,
  PasswordChangeLockStatus,
  PasswordChangeStatus,
  SyncOperationResult,
  SyncProgress,
} from '../../../shared/types/sync'

const PASSWORD_CHANGE_KEY_PREFIX = 'sync.passwordChange.'

export interface UsePasswordChangeStatusOptions {
  authenticated: boolean
  /** True while the password form's own set / change runs. */
  formBusy: boolean
  progress: SyncProgress | null
  lastSyncResult: LastSyncResult | null
}

export interface UsePasswordChangeStatusReturn {
  status: PasswordChangeStatus
  /** Only looked up while this machine has no change of its own. */
  lockStatus: PasswordChangeLockStatus | null
  running: boolean
  /** Translated error of the last action. */
  error: string | null
  setError: (error: string | null) => void
  resume: () => Promise<boolean>
  revert: () => Promise<boolean>
  abandon: () => Promise<boolean>
  deleteUndecryptable: (fileId: string) => Promise<boolean>
  releaseLocks: () => Promise<boolean>
}

function passwordChangeMessage(message: string | undefined): string | null {
  return message?.startsWith(PASSWORD_CHANGE_KEY_PREFIX) ? message : null
}

export function usePasswordChangeStatus({
  authenticated,
  formBusy,
  progress,
  lastSyncResult,
}: UsePasswordChangeStatusOptions): UsePasswordChangeStatusReturn {
  const { t } = useTranslation()
  const [status, setStatus] = useState<PasswordChangeStatus>({ kind: 'none' })
  const [lockStatus, setLockStatus] = useState<PasswordChangeLockStatus | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Every setState from a fetch checks that its generation is still the
  // latest: `statusGen` for the local status, `lockGen` for the lock. A
  // status response that hides the lock bumps `lockGen`, so a lock lookup
  // still in flight can't bring the banner back.
  const statusGen = useRef(0)
  const lockGen = useRef(0)
  const isMountedRef = useRef(true)
  // Read at refresh time, so a refresh after a long action uses the
  // sign-in state of that moment.
  const authenticatedRef = useRef(authenticated)

  useEffect(() => {
    authenticatedRef.current = authenticated
  }, [authenticated])

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  /** `withLock` false keeps the last lock lookup unless a local change
   *  now hides it. */
  const refresh = useCallback(async (withLock: boolean) => {
    const myStatusGen = ++statusGen.current
    const myLockGen = withLock ? ++lockGen.current : lockGen.current
    let next: PasswordChangeStatus = { kind: 'none' }
    try {
      next = await window.vialAPI.syncPasswordChangeStatus()
    } catch {
      // Unreadable status: show the normal password row.
    }
    if (!isMountedRef.current) return
    const statusCurrent = myStatusGen === statusGen.current
    if (statusCurrent) setStatus(next)
    if (next.kind !== 'none') {
      if (statusCurrent && myLockGen === lockGen.current) {
        lockGen.current++
        setLockStatus(null)
      }
      return
    }
    if (!withLock) return
    let lock: PasswordChangeLockStatus | null = null
    if (authenticatedRef.current) {
      try {
        lock = await window.vialAPI.syncPasswordChangeLockStatus()
      } catch {
        // Drive unreachable: the sync status already reports it.
      }
    }
    if (isMountedRef.current && myLockGen === lockGen.current) setLockStatus(lock)
  }, [])

  const progressTrigger = passwordChangeMessage(progress?.message)

  useEffect(() => {
    if (formBusy) return
    void refresh(true)
  }, [refresh, formBusy, lastSyncResult, authenticated])

  useEffect(() => {
    if (formBusy || !progressTrigger) return
    void refresh(false)
  }, [refresh, formBusy, progressTrigger])

  const runAction = useCallback(
    async <R extends SyncOperationResult>(
      action: () => Promise<R>,
      failureOf?: (result: R) => string | null,
    ): Promise<boolean> => {
      setRunning(true)
      setError(null)
      let failure: string | null = 'statusBar.sync.error'
      try {
        const result = await action()
        failure = result.success ? (failureOf?.(result) ?? null) : (result.error ?? 'statusBar.sync.error')
      } catch {
        // Keeps the generic error.
      }
      await refresh(true)
      if (isMountedRef.current) {
        setError(failure ? t(failure, failure) : null)
        setRunning(false)
      }
      return failure === null
    },
    [refresh, t],
  )

  const resume = useCallback(() => runAction(() => window.vialAPI.syncPasswordChangeResume()), [runAction])
  const revert = useCallback(() => runAction(() => window.vialAPI.syncPasswordChangeRevert()), [runAction])
  const abandon = useCallback(() => runAction(() => window.vialAPI.syncPasswordChangeAbandon()), [runAction])
  const releaseLocks = useCallback(() => runAction(() => window.vialAPI.syncPasswordChangeReleaseLocks()), [runAction])
  const deleteUndecryptable = useCallback(
    (fileId: string) =>
      runAction(
        () => window.vialAPI.syncPasswordChangeDeleteUndecryptable([fileId]),
        // A file one of the passwords opens is left alone by main.
        (result) => (result.skipped?.includes(fileId) ? 'sync.passwordChange.deleteSkipped' : null),
      ),
    [runAction],
  )

  return { status, lockStatus, running, error, setError, resume, revert, abandon, deleteUndecryptable, releaseLocks }
}
