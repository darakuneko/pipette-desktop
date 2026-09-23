// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback, useRef } from 'react'
import type { TFunction } from 'i18next'
import type { HubPrivateLink } from '../../shared/types/hub-private'
import type { useUploadConfirm } from './useUploadConfirm'
import { linkFromResult } from '../utils/hub-private-link'
import { hubResultErrorMessage } from '../utils/hub-result-error'
import type { FavHubEntryResult } from '../components/editors/FavoriteHubActions'
import type { FavoriteType, SavedFavoriteMeta } from '../../shared/types/favorite-store'

interface Options {
  requestUploadOptions: ReturnType<typeof useUploadConfirm>['requestUploadOptions']
  t: TFunction
  /** `vialProtocol` passed through `isValidHubVialProtocol` with a
   *  fallback for the not-yet-connected sentinel (computed in
   *  useHubState.ts) — never the raw `vialProtocol` value. `-1` is that
   *  sentinel, and hub-ipc-favorite.ts's own `isValidHubVialProtocol`
   *  guard rejects it outright. */
  favVialProtocol: number
  markAccountDeactivated: () => void
  hubReady: boolean
  /** `useState` setters, whose identity never changes. None of the
   *  `useCallback`s below list them as dependencies: `runFavHubOperation`
   *  and `handleFavRenameOnHub` close over both, and the upload / update /
   *  remove handlers over `setFavHubUploadResult`. They must never be
   *  passed a value that changes identity across renders. */
  setFavHubUploading: React.Dispatch<React.SetStateAction<string | null>>
  setFavHubUploadResult: React.Dispatch<React.SetStateAction<FavHubEntryResult | null>>
}

export function useHubFavoriteHandlers(options: Options) {
  const {
    requestUploadOptions,
    t,
    favVialProtocol,
    markAccountDeactivated,
    hubReady,
    setFavHubUploading,
    setFavHubUploadResult,
  } = options

  const favHubUploadingRef = useRef(false)

  const persistFavHubPostId = useCallback(async (type: FavoriteType, entryId: string, postId: string | null) => {
    await window.vialAPI.favoriteStoreSetHubPostId(type, entryId, postId)
  }, [])

  const persistFavHubPrivate = useCallback(async (type: FavoriteType, entryId: string, link: HubPrivateLink | null) => {
    await window.vialAPI.favoriteStoreSetHubPrivate(type, entryId, link)
  }, [])

  const runFavHubOperation = useCallback(async (
    type: FavoriteType,
    entryId: string,
    requireLinked: boolean,
    operation: (entry: SavedFavoriteMeta) => Promise<void>,
  ) => {
    if (favHubUploadingRef.current) return
    favHubUploadingRef.current = true
    // Every exit past this point — including a rejected list read, which
    // still propagates to the caller — must release the lock, or all
    // favorite Hub operations stay ignored until this hook remounts.
    let markedUploading = false
    try {
      const listResult = await window.vialAPI.favoriteStoreList(type)
      const entry = listResult.entries?.find((e: SavedFavoriteMeta) => e.id === entryId)
      if (!entry || (requireLinked && !entry.hubPostId && !entry.hubPrivate)) return

      setFavHubUploading(entryId)
      markedUploading = true
      setFavHubUploadResult(null)
      await operation(entry)
    } finally {
      if (markedUploading) setFavHubUploading(null)
      favHubUploadingRef.current = false
    }
  }, [])

  const handleFavUploadToHub = useCallback(async (type: FavoriteType, entryId: string) => {
    const choice = await requestUploadOptions({ mode: 'create', currentVisibility: 'none' })
    if (!choice) return
    await runFavHubOperation(type, entryId, false, async (entry) => {
      try {
        if (choice.visibility === 'public') {
          const result = await window.vialAPI.hubUploadFavoritePost({
            type, entryId, title: entry.label || type, vialProtocol: favVialProtocol,
          })
          if (result.success) {
            if (result.postId) await persistFavHubPostId(type, entryId, result.postId)
            setFavHubUploadResult({ kind: 'success', message: t('hub.uploadSuccess'), entryId })
          } else {
            setFavHubUploadResult({ kind: 'error', message: hubResultErrorMessage(result.error, t('hub.uploadFailed'), t, markAccountDeactivated), entryId })
          }
          return
        }
        const result = await window.vialAPI.hubUploadPrivateFavoritePost({
          type, entryId, title: entry.label || type, vialProtocol: favVialProtocol, expiresInDays: choice.expiresInDays,
        })
        if (result.success) {
          await persistFavHubPrivate(type, entryId, linkFromResult(result))
          setFavHubUploadResult({ kind: 'success', message: t('hub.uploadSuccess'), entryId })
        } else {
          setFavHubUploadResult({ kind: 'error', message: hubResultErrorMessage(result.error, t('hub.uploadFailed'), t, markAccountDeactivated), entryId })
        }
      } catch {
        setFavHubUploadResult({ kind: 'error', message: t('hub.uploadFailed'), entryId })
      }
    })
  }, [requestUploadOptions, runFavHubOperation, persistFavHubPostId, persistFavHubPrivate, markAccountDeactivated, t, favVialProtocol])

  const handleFavUpdateOnHub = useCallback(async (type: FavoriteType, entryId: string) => {
    const listResult = await window.vialAPI.favoriteStoreList(type)
    const current = listResult.entries?.find((e: SavedFavoriteMeta) => e.id === entryId)
    if (!current) return
    const isPrivate = !!current.hubPrivate
    const currentVisibility = isPrivate ? 'private' : (current.hubPostId ? 'public' : 'none')
    if (currentVisibility === 'none') return

    const choice = await requestUploadOptions({ mode: 'update', currentVisibility })
    if (!choice) return

    await runFavHubOperation(type, entryId, true, async (entry) => {
      try {
        // public → public is a plain in-place update (URL preserved).
        if (currentVisibility === 'public' && choice.visibility === 'public') {
          const result = await window.vialAPI.hubUpdateFavoritePost({
            type, entryId, title: entry.label || type, postId: entry.hubPostId!, vialProtocol: favVialProtocol,
          })
          if (result.success) {
            setFavHubUploadResult({ kind: 'success', message: t('hub.updateSuccess'), entryId })
          } else {
            setFavHubUploadResult({ kind: 'error', message: hubResultErrorMessage(result.error, t('hub.updateFailed'), t, markAccountDeactivated), entryId })
          }
          return
        }

        // Visibility switch / private→private: delete then recreate.
        if (currentVisibility === 'public') {
          await window.vialAPI.hubDeletePost(entry.hubPostId!).catch(() => {})
        } else {
          await window.vialAPI.hubDeletePrivatePost('files', entry.hubPrivate!.id).catch(() => {})
        }

        if (choice.visibility === 'public') {
          const result = await window.vialAPI.hubUploadFavoritePost({
            type, entryId, title: entry.label || type, vialProtocol: favVialProtocol,
          })
          if (result.success) {
            if (result.postId) await persistFavHubPostId(type, entryId, result.postId)
            setFavHubUploadResult({ kind: 'success', message: t('hub.updateSuccess'), entryId })
          } else {
            setFavHubUploadResult({ kind: 'error', message: hubResultErrorMessage(result.error, t('hub.updateFailed'), t, markAccountDeactivated), entryId })
          }
          return
        }
        const result = await window.vialAPI.hubUploadPrivateFavoritePost({
          type, entryId, title: entry.label || type, vialProtocol: favVialProtocol, expiresInDays: choice.expiresInDays,
        })
        if (result.success) {
          await persistFavHubPrivate(type, entryId, linkFromResult(result))
          setFavHubUploadResult({ kind: 'success', message: t('hub.updateSuccess'), entryId })
        } else {
          setFavHubUploadResult({ kind: 'error', message: hubResultErrorMessage(result.error, t('hub.updateFailed'), t, markAccountDeactivated), entryId })
        }
      } catch {
        setFavHubUploadResult({ kind: 'error', message: t('hub.updateFailed'), entryId })
      }
    })
  }, [requestUploadOptions, runFavHubOperation, persistFavHubPostId, persistFavHubPrivate, markAccountDeactivated, t, favVialProtocol])

  const handleFavRemoveFromHub = useCallback(async (type: FavoriteType, entryId: string) => {
    await runFavHubOperation(type, entryId, true, async (entry) => {
      try {
        if (entry.hubPrivate) {
          const result = await window.vialAPI.hubDeletePrivatePost('files', entry.hubPrivate.id)
          if (result.success) {
            await persistFavHubPrivate(type, entryId, null)
            setFavHubUploadResult({ kind: 'success', message: t('hub.removeSuccess'), entryId })
          } else {
            setFavHubUploadResult({ kind: 'error', message: hubResultErrorMessage(result.error, t('hub.removeFailed'), t, markAccountDeactivated), entryId })
          }
          return
        }
        const result = await window.vialAPI.hubDeletePost(entry.hubPostId!)
        if (result.success) {
          await persistFavHubPostId(type, entryId, null)
          setFavHubUploadResult({ kind: 'success', message: t('hub.removeSuccess'), entryId })
        } else {
          setFavHubUploadResult({ kind: 'error', message: hubResultErrorMessage(result.error, t('hub.removeFailed'), t, markAccountDeactivated), entryId })
        }
      } catch {
        setFavHubUploadResult({ kind: 'error', message: t('hub.removeFailed'), entryId })
      }
    })
  }, [runFavHubOperation, persistFavHubPostId, persistFavHubPrivate, markAccountDeactivated, t])

  const handleFavRenameOnHub = useCallback(async (entryId: string, hubPostId: string, newLabel: string) => {
    if (!hubReady || favHubUploadingRef.current) return
    favHubUploadingRef.current = true
    setFavHubUploading(entryId)
    setFavHubUploadResult(null)
    try {
      const result = await window.vialAPI.hubPatchPost({ postId: hubPostId, title: newLabel })
      if (result.success) {
        setFavHubUploadResult({ kind: 'success', message: t('hub.hubSynced'), entryId })
      } else {
        setFavHubUploadResult({ kind: 'error', message: hubResultErrorMessage(result.error, t('hub.renameFailed'), t, markAccountDeactivated), entryId })
      }
    } catch {
      setFavHubUploadResult({ kind: 'error', message: t('hub.renameFailed'), entryId })
    } finally {
      setFavHubUploading(null)
      favHubUploadingRef.current = false
    }
  }, [hubReady, markAccountDeactivated, t])

  return { handleFavUploadToHub, handleFavUpdateOnHub, handleFavRemoveFromHub, handleFavRenameOnHub }
}
