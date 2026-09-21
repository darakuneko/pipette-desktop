// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback } from 'react'
import type { TFunction } from 'i18next'
import type { HubUploadResult } from '../../shared/types/hub'
import type { HubPrivateLink } from '../../shared/types/hub-private'
import { HUB_ERROR_ACCOUNT_DEACTIVATED, HUB_ERROR_RATE_LIMITED } from '../../shared/types/hub'
import type { useUploadConfirm } from './useUploadConfirm'
import { linkFromResult } from '../utils/hub-private-link'
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
  /** Stable references (a `useRef` object and `useState` setters) —
   *  `runFavHubOperation` closes over all three without listing them as
   *  `useCallback` dependencies, so they must never be passed a value
   *  that changes identity across renders. */
  favHubUploadingRef: React.MutableRefObject<boolean>
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
    favHubUploadingRef,
    setFavHubUploading,
    setFavHubUploadResult,
  } = options

  const persistFavHubPostId = useCallback(async (type: FavoriteType, entryId: string, postId: string | null) => {
    await window.vialAPI.favoriteStoreSetHubPostId(type, entryId, postId)
  }, [])

  const persistFavHubPrivate = useCallback(async (type: FavoriteType, entryId: string, link: HubPrivateLink | null) => {
    await window.vialAPI.favoriteStoreSetHubPrivate(type, entryId, link)
  }, [])

  function hubResultErrorMessage(result: HubUploadResult, fallbackKey: string): string {
    if (result.error === HUB_ERROR_ACCOUNT_DEACTIVATED) {
      markAccountDeactivated()
      return t('hub.accountDeactivated')
    }
    if (result.error === HUB_ERROR_RATE_LIMITED) return t('hub.rateLimited')
    return result.error || t(fallbackKey)
  }

  const runFavHubOperation = useCallback(async (
    type: FavoriteType,
    entryId: string,
    requireLinked: boolean,
    operation: (entry: SavedFavoriteMeta) => Promise<void>,
  ) => {
    if (favHubUploadingRef.current) return
    favHubUploadingRef.current = true

    const listResult = await window.vialAPI.favoriteStoreList(type)
    const entry = listResult.entries?.find((e: SavedFavoriteMeta) => e.id === entryId)
    if (!entry || (requireLinked && !entry.hubPostId && !entry.hubPrivate)) {
      favHubUploadingRef.current = false
      return
    }

    setFavHubUploading(entryId)
    setFavHubUploadResult(null)
    try {
      await operation(entry)
    } finally {
      setFavHubUploading(null)
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
            setFavHubUploadResult({ kind: 'error', message: hubResultErrorMessage(result, 'hub.uploadFailed'), entryId })
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
          setFavHubUploadResult({ kind: 'error', message: hubResultErrorMessage(result, 'hub.uploadFailed'), entryId })
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
            setFavHubUploadResult({ kind: 'error', message: hubResultErrorMessage(result, 'hub.updateFailed'), entryId })
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
            setFavHubUploadResult({ kind: 'error', message: hubResultErrorMessage(result, 'hub.updateFailed'), entryId })
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
          setFavHubUploadResult({ kind: 'error', message: hubResultErrorMessage(result, 'hub.updateFailed'), entryId })
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
            setFavHubUploadResult({ kind: 'error', message: result.error || t('hub.removeFailed'), entryId })
          }
          return
        }
        const result = await window.vialAPI.hubDeletePost(entry.hubPostId!)
        if (result.success) {
          await persistFavHubPostId(type, entryId, null)
          setFavHubUploadResult({ kind: 'success', message: t('hub.removeSuccess'), entryId })
        } else {
          setFavHubUploadResult({ kind: 'error', message: result.error || t('hub.removeFailed'), entryId })
        }
      } catch {
        setFavHubUploadResult({ kind: 'error', message: t('hub.removeFailed'), entryId })
      }
    })
  }, [runFavHubOperation, persistFavHubPostId, persistFavHubPrivate, t])

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
        setFavHubUploadResult({ kind: 'error', message: hubResultErrorMessage(result, 'hub.renameFailed'), entryId })
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
