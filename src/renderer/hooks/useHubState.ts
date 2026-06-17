// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { HubMyPost, HubUploadResult, HubPaginationMeta, HubFetchMyPostsParams } from '../../shared/types/hub'
import type { HubPrivateLink } from '../../shared/types/hub-private'
import { HUB_ERROR_DISPLAY_NAME_CONFLICT, HUB_ERROR_ACCOUNT_DEACTIVATED, HUB_ERROR_RATE_LIMITED } from '../../shared/types/hub'
import { useUploadConfirm } from './useUploadConfirm'
import { linkFromResult } from '../utils/hub-private-link'
import type { HubEntryResult } from '../components/editors/LayoutStoreModal'
import type { FavHubEntryResult } from '../components/editors/FavoriteHubActions'
import type { SnapshotMeta } from '../../shared/types/snapshot-store'
import type { FavoriteType, SavedFavoriteMeta } from '../../shared/types/favorite-store'
import type { VilFile } from '../../shared/types/protocol'

interface Options {
  hubEnabled: boolean
  authenticated: boolean
  keyboardUid: string | undefined
  layoutStoreEntries: SnapshotMeta[]
  layoutStoreRefreshEntries: () => Promise<void>
  layoutStoreDeleteEntry: (id: string) => Promise<boolean>
  layoutStoreSaveLayout: (label: string) => Promise<string | undefined>
  layoutStoreRenameEntry: (id: string, label: string) => Promise<boolean>
  deviceName: string
  effectiveIsDummy: boolean
  loadEntryVilData: (id: string) => Promise<VilFile | null>
  buildHubPostParams: (entry: { label: string }, vilData: VilFile) => Promise<{
    title: string
    keyboardName: string
    vilJson: string
    pipetteJson: string
    keymapC: string
    pdfBase64: string
    thumbnailBase64: string
  }>
  activityCount: number
  pipetteFileSavedActivityRef: React.MutableRefObject<number>
  /** Vial protocol of the live keyboard. Forwarded to favorite Hub uploads (v3 export). */
  vialProtocol: number
}

export function useHubState(options: Options) {
  const {
    hubEnabled,
    authenticated,
    keyboardUid,
    layoutStoreEntries,
    layoutStoreRefreshEntries,
    layoutStoreDeleteEntry,
    layoutStoreSaveLayout,
    layoutStoreRenameEntry,
    deviceName,
    effectiveIsDummy,
    loadEntryVilData,
    buildHubPostParams,
    activityCount,
    pipetteFileSavedActivityRef,
    vialProtocol,
  } = options

  const { t } = useTranslation()
  const { requestUploadOptions } = useUploadConfirm()

  const [hubMyPosts, setHubMyPosts] = useState<HubMyPost[]>([])
  const [hubMyPostsPagination, setHubMyPostsPagination] = useState<HubPaginationMeta | undefined>()
  const [hubKeyboardPosts, setHubKeyboardPosts] = useState<HubMyPost[]>([])
  const [hubOrigin, setHubOrigin] = useState('')
  useEffect(() => { window.vialAPI.hubGetOrigin().then(setHubOrigin).catch(() => {}) }, [])
  const [hubConnected, setHubConnected] = useState(false)
  const [hubDisplayName, setHubDisplayName] = useState<string | null>(null)
  const [hubAuthConflict, setHubAuthConflict] = useState(false)
  const [hubAccountDeactivated, setHubAccountDeactivated] = useState(false)
  const [hubUploading, setHubUploading] = useState<string | null>(null)
  const hubUploadingRef = useRef(false)
  const [hubUploadResult, setHubUploadResult] = useState<HubEntryResult | null>(null)
  const [favHubUploading, setFavHubUploading] = useState<string | null>(null)
  const favHubUploadingRef = useRef(false)
  const [favHubUploadResult, setFavHubUploadResult] = useState<FavHubEntryResult | null>(null)

  const clearHubPostsState = useCallback(() => {
    setHubMyPosts([])
    setHubMyPostsPagination(undefined)
    setHubConnected(false)
  }, [])

  const markAccountDeactivated = useCallback(() => {
    setHubAccountDeactivated(true)
    clearHubPostsState()
  }, [clearHubPostsState])

  const fetchHubUser = useCallback(async () => {
    if (!hubEnabled || !authenticated) return
    try {
      const result = await window.vialAPI.hubFetchAuthMe()
      if (result.success && result.user) {
        setHubDisplayName(result.user.display_name)
      }
    } catch {}
  }, [hubEnabled, authenticated])

  const handleUpdateHubDisplayName = useCallback(async (name: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const result = await window.vialAPI.hubPatchAuthMe(name)
      if (result.success && result.user) {
        setHubDisplayName(result.user.display_name)
        return { success: true }
      }
      return { success: false, error: result.error }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : undefined }
    }
  }, [])

  const refreshHubMyPosts = useCallback(async (params?: HubFetchMyPostsParams) => {
    if (hubEnabled && authenticated) {
      try {
        const result = await window.vialAPI.hubFetchMyPosts(params)
        if (result.success && Array.isArray(result.posts)) {
          setHubMyPosts(result.posts)
          setHubMyPostsPagination(result.pagination)
          setHubConnected(true)
          setHubAuthConflict(false)
          setHubAccountDeactivated(false)
          return
        }
        if (result.error === HUB_ERROR_DISPLAY_NAME_CONFLICT) {
          setHubAuthConflict(true)
          clearHubPostsState()
          return
        }
        if (result.error === HUB_ERROR_ACCOUNT_DEACTIVATED) {
          markAccountDeactivated()
          return
        }
      } catch {}
    }
    clearHubPostsState()
  }, [hubEnabled, authenticated, clearHubPostsState, markAccountDeactivated])

  const refreshHubKeyboardPosts = useCallback(async () => {
    if (!hubEnabled || !authenticated || !deviceName || effectiveIsDummy) {
      setHubKeyboardPosts([])
      return
    }
    try {
      const result = await window.vialAPI.hubFetchMyKeyboardPosts(deviceName)
      setHubKeyboardPosts(result.success && result.posts ? result.posts : [])
    } catch {
      setHubKeyboardPosts([])
    }
  }, [hubEnabled, authenticated, deviceName, effectiveIsDummy])

  const refreshHubPosts = useCallback(async () => {
    await refreshHubKeyboardPosts()
    await refreshHubMyPosts()
  }, [refreshHubMyPosts, refreshHubKeyboardPosts])

  const handleResolveAuthConflict = useCallback(async (name: string): Promise<{ success: boolean; error?: string }> => {
    try {
      await window.vialAPI.hubSetAuthDisplayName(name)
      const result = await window.vialAPI.hubFetchAuthMe()
      if (!result.success) {
        return { success: false, error: result.error }
      }
      if (result.user) {
        setHubAuthConflict(false)
        setHubDisplayName(result.user.display_name)
        await refreshHubPosts()
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : undefined }
    } finally {
      await window.vialAPI.hubSetAuthDisplayName(null).catch(() => {})
    }
  }, [refreshHubPosts])

  const getHubPostId = useCallback((entry: { hubPostId?: string; label: string }): string | undefined => {
    return entry.hubPostId || hubKeyboardPosts.find((p) => p.title === entry.label)?.id
  }, [hubKeyboardPosts])

  const persistHubPostId = useCallback(async (entryId: string, postId: string | null) => {
    await window.vialAPI.snapshotStoreSetHubPostId(keyboardUid!, entryId, postId)
    await layoutStoreRefreshEntries()
  }, [keyboardUid, layoutStoreRefreshEntries])

  const persistHubPrivate = useCallback(async (entryId: string, link: HubPrivateLink | null) => {
    await window.vialAPI.snapshotStoreSetHubPrivate(keyboardUid!, entryId, link)
    await layoutStoreRefreshEntries()
  }, [keyboardUid, layoutStoreRefreshEntries])

  const handleHubRenamePost = useCallback(async (postId: string, newTitle: string) => {
    const result = await window.vialAPI.hubPatchPost({ postId, title: newTitle })
    if (!result.success) throw new Error(result.error ?? 'Rename failed')
    await refreshHubPosts()
  }, [refreshHubPosts])

  const handleHubDeletePost = useCallback(async (postId: string) => {
    const result = await window.vialAPI.hubDeletePost(postId)
    if (!result.success) throw new Error(result.error ?? 'Delete failed')
    await refreshHubPosts()
  }, [refreshHubPosts])

  // Auto-check Hub connectivity when auth status changes
  useEffect(() => {
    void refreshHubPosts()
    void fetchHubUser()
  }, [refreshHubPosts, fetchHubUser])

  const hubReady = hubEnabled && authenticated && hubConnected
  const hubCanUpload = hubReady && !!hubDisplayName?.trim()

  const runHubOperation = useCallback(async (
    entryId: string,
    findEntry: (entries: SnapshotMeta[]) => SnapshotMeta | undefined,
    operation: (entry: SnapshotMeta) => Promise<HubUploadResult>,
    successMsg: string,
    failMsg: string,
  ) => {
    if (hubUploadingRef.current) return
    hubUploadingRef.current = true

    const entry = findEntry(layoutStoreEntries)
    if (!entry) { hubUploadingRef.current = false; return }

    setHubUploading(entryId)
    setHubUploadResult(null)
    try {
      const result = await operation(entry)
      if (result.success) {
        setHubUploadResult({ kind: 'success', message: successMsg, entryId })
      } else {
        let message: string
        if (result.error === HUB_ERROR_ACCOUNT_DEACTIVATED) {
          markAccountDeactivated()
          message = t('hub.accountDeactivated')
        } else if (result.error === HUB_ERROR_RATE_LIMITED) {
          message = t('hub.rateLimited')
        } else {
          message = result.error || failMsg
        }
        setHubUploadResult({ kind: 'error', message, entryId })
      }
    } catch {
      setHubUploadResult({ kind: 'error', message: failMsg, entryId })
    } finally {
      setHubUploading(null)
      hubUploadingRef.current = false
    }
  }, [layoutStoreEntries, markAccountDeactivated, t])

  const handleUploadToHub = useCallback(async (entryId: string) => {
    const choice = await requestUploadOptions({ mode: 'create', currentVisibility: 'none' })
    if (!choice) return
    await runHubOperation(
      entryId,
      (entries) => entries.find((e) => e.id === entryId),
      async (entry) => {
        const vilData = await loadEntryVilData(entryId)
        if (!vilData) return { success: false, error: t('hub.uploadFailed') }
        const postParams = await buildHubPostParams(entry, vilData)
        if (choice.visibility === 'public') {
          const result = await window.vialAPI.hubUploadPost(postParams)
          if (result.success) {
            if (result.postId) await persistHubPostId(entryId, result.postId)
            await refreshHubPosts()
          }
          return result
        }
        const result = await window.vialAPI.hubUploadPrivatePost({ ...postParams, expiresInDays: choice.expiresInDays })
        if (result.success) {
          await persistHubPrivate(entryId, linkFromResult(result))
          await refreshHubPosts()
        }
        return result
      },
      t('hub.uploadSuccess'),
      t('hub.uploadFailed'),
    )
  }, [requestUploadOptions, runHubOperation, loadEntryVilData, buildHubPostParams, persistHubPostId, persistHubPrivate, refreshHubPosts, t])

  const handleUpdateOnHub = useCallback(async (entryId: string) => {
    const entry = layoutStoreEntries.find((e) => e.id === entryId)
    if (!entry) return
    const isPrivate = !!entry.hubPrivate
    const publicPostId = isPrivate ? undefined : getHubPostId(entry)
    const currentVisibility = isPrivate ? 'private' : (publicPostId ? 'public' : 'none')
    if (currentVisibility === 'none') return

    const choice = await requestUploadOptions({ mode: 'update', currentVisibility })
    if (!choice) return

    await runHubOperation(
      entryId,
      () => entry,
      async () => {
        const vilData = await loadEntryVilData(entryId)
        if (!vilData) return { success: false, error: t('hub.updateFailed') }
        const postParams = await buildHubPostParams(entry, vilData)

        // public → public keeps the same post (and URL): a plain update.
        if (currentVisibility === 'public' && choice.visibility === 'public') {
          const result = await window.vialAPI.hubUpdatePost({ ...postParams, postId: publicPostId! })
          if (result.success) await refreshHubPosts()
          return result
        }

        // Any visibility switch (and private→private) rebuilds the post:
        // delete the old one, then create fresh in the target visibility.
        if (currentVisibility === 'public') {
          await window.vialAPI.hubDeletePost(publicPostId!).catch(() => {})
        } else {
          await window.vialAPI.hubDeletePrivatePost('files', entry.hubPrivate!.id).catch(() => {})
        }

        if (choice.visibility === 'public') {
          const result = await window.vialAPI.hubUploadPost(postParams)
          if (result.success) {
            if (result.postId) await persistHubPostId(entryId, result.postId)
            await refreshHubPosts()
          }
          return result
        }
        const result = await window.vialAPI.hubUploadPrivatePost({ ...postParams, expiresInDays: choice.expiresInDays })
        if (result.success) {
          await persistHubPrivate(entryId, linkFromResult(result))
          await refreshHubPosts()
        }
        return result
      },
      t('hub.updateSuccess'),
      t('hub.updateFailed'),
    )
  }, [requestUploadOptions, runHubOperation, layoutStoreEntries, loadEntryVilData, buildHubPostParams, getHubPostId, persistHubPostId, persistHubPrivate, refreshHubPosts, t])

  const handleRemoveFromHub = useCallback(async (entryId: string) => {
    const entry = layoutStoreEntries.find((e) => e.id === entryId)
    if (!entry) return
    const isPrivate = !!entry.hubPrivate
    const publicPostId = isPrivate ? undefined : getHubPostId(entry)
    if (!isPrivate && !publicPostId) return

    await runHubOperation(
      entryId,
      () => entry,
      async () => {
        if (isPrivate) {
          const result = await window.vialAPI.hubDeletePrivatePost('files', entry.hubPrivate!.id)
          if (result.success) {
            await persistHubPrivate(entryId, null)
            await refreshHubPosts()
          }
          return result
        }
        const result = await window.vialAPI.hubDeletePost(publicPostId!)
        if (result.success) {
          await persistHubPostId(entryId, null)
          await refreshHubPosts()
        }
        return result
      },
      t('hub.removeSuccess'),
      t('hub.removeFailed'),
    )
  }, [runHubOperation, layoutStoreEntries, getHubPostId, persistHubPostId, persistHubPrivate, refreshHubPosts, t])

  const handleReuploadToHub = useCallback(async (entryId: string, orphanedPostId: string) => {
    await runHubOperation(
      entryId,
      (entries) => entries.find((e) => e.id === entryId),
      async (entry) => {
        await window.vialAPI.hubDeletePost(orphanedPostId).catch(() => {})
        const vilData = await loadEntryVilData(entryId)
        if (!vilData) return { success: false, error: t('hub.uploadFailed') }
        const postParams = await buildHubPostParams(entry, vilData)
        const result = await window.vialAPI.hubUploadPost(postParams)
        if (result.success) {
          if (result.postId) await persistHubPostId(entryId, result.postId)
          await refreshHubPosts()
        }
        return result
      },
      t('hub.uploadSuccess'),
      t('hub.uploadFailed'),
    )
  }, [runHubOperation, loadEntryVilData, buildHubPostParams, persistHubPostId, refreshHubPosts, t])

  const handleDeleteOrphanedHubPost = useCallback(async (entryId: string, orphanedPostId: string) => {
    await runHubOperation(
      entryId,
      (entries) => entries.find((e) => e.id === entryId),
      async () => {
        const result = await window.vialAPI.hubDeletePost(orphanedPostId)
        await refreshHubPosts()
        return result
      },
      t('hub.removeSuccess'),
      t('hub.removeFailed'),
    )
  }, [runHubOperation, refreshHubPosts, t])

  const handleOverwriteSave = useCallback(async (overwriteEntryId: string, label: string) => {
    const overwriteEntry = layoutStoreEntries.find((e) => e.id === overwriteEntryId)
    const existingPostId = overwriteEntry ? getHubPostId(overwriteEntry) : undefined

    await layoutStoreDeleteEntry(overwriteEntryId)
    const newEntryId = await layoutStoreSaveLayout(label)
    if (!newEntryId) return
    pipetteFileSavedActivityRef.current = activityCount

    if (existingPostId) {
      await persistHubPostId(newEntryId, existingPostId)

      if (hubReady) {
        await runHubOperation(
          newEntryId,
          () => ({ id: newEntryId, label, filename: '', savedAt: '', hubPostId: existingPostId }),
          async () => {
            const vilData = await loadEntryVilData(newEntryId)
            if (!vilData) return { success: false, error: t('hub.updateFailed') }
            const postParams = await buildHubPostParams({ label }, vilData)
            const result = await window.vialAPI.hubUpdatePost({ ...postParams, postId: existingPostId })
            if (result.success) await refreshHubPosts()
            return result
          },
          t('hub.updateSuccess'),
          t('hub.updateFailed'),
        )
      }
    }
  }, [layoutStoreEntries, getHubPostId, layoutStoreDeleteEntry, layoutStoreSaveLayout,
      persistHubPostId, hubReady, runHubOperation, loadEntryVilData, buildHubPostParams,
      refreshHubPosts, t, activityCount, pipetteFileSavedActivityRef])

  const handleDeleteEntry = useCallback(async (entryId: string) => {
    const entry = layoutStoreEntries.find((e) => e.id === entryId)
    const postId = entry ? getHubPostId(entry) : undefined
    const deleted = await layoutStoreDeleteEntry(entryId)
    if (deleted && postId && hubReady) {
      try {
        const result = await window.vialAPI.hubDeletePost(postId)
        if (result.success) await refreshHubPosts()
      } catch {
        // Hub deletion is best-effort
      }
    }
  }, [layoutStoreEntries, getHubPostId, layoutStoreDeleteEntry, hubReady, refreshHubPosts])

  const handleRenameEntry = useCallback(async (entryId: string, newLabel: string): Promise<boolean> => {
    const entry = layoutStoreEntries.find((e) => e.id === entryId)
    const postId = entry ? getHubPostId(entry) : undefined
    const ok = await layoutStoreRenameEntry(entryId, newLabel)
    if (ok && hubReady && postId) {
      void runHubOperation(
        entryId,
        (entries) => entries.find((e) => e.id === entryId),
        async () => {
          const result = await window.vialAPI.hubPatchPost({ postId, title: newLabel })
          if (result.success) await refreshHubPosts()
          return result
        },
        t('hub.hubSynced'),
        t('hub.renameFailed'),
      )
    }
    return ok
  }, [layoutStoreEntries, getHubPostId, layoutStoreRenameEntry, hubReady, runHubOperation, refreshHubPosts, t])

  // --- Favorite Hub handlers ---

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
            type, entryId, title: entry.label || type, vialProtocol,
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
          type, entryId, title: entry.label || type, vialProtocol, expiresInDays: choice.expiresInDays,
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
  }, [requestUploadOptions, runFavHubOperation, persistFavHubPostId, persistFavHubPrivate, markAccountDeactivated, t, vialProtocol])

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
            type, entryId, title: entry.label || type, postId: entry.hubPostId!, vialProtocol,
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
            type, entryId, title: entry.label || type, vialProtocol,
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
          type, entryId, title: entry.label || type, vialProtocol, expiresInDays: choice.expiresInDays,
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
  }, [requestUploadOptions, runFavHubOperation, persistFavHubPostId, persistFavHubPrivate, markAccountDeactivated, t, vialProtocol])

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

  const resetHubState = useCallback(() => {
    setHubConnected(false)
    setHubMyPosts([])
    setHubKeyboardPosts([])
  }, [])

  return {
    // State
    hubMyPosts,
    hubMyPostsPagination,
    hubKeyboardPosts,
    hubOrigin,
    hubConnected,
    hubDisplayName,
    hubAuthConflict,
    hubAccountDeactivated,
    hubUploading,
    hubUploadResult,
    setHubUploadResult,
    favHubUploading,
    favHubUploadResult,
    // Derived
    hubReady,
    hubCanUpload,
    // Handlers
    fetchHubUser,
    handleUpdateHubDisplayName,
    refreshHubMyPosts,
    refreshHubKeyboardPosts,
    refreshHubPosts,
    handleResolveAuthConflict,
    getHubPostId,
    persistHubPostId,
    handleHubRenamePost,
    handleHubDeletePost,
    handleUploadToHub,
    handleUpdateOnHub,
    handleRemoveFromHub,
    handleReuploadToHub,
    handleDeleteOrphanedHubPost,
    handleOverwriteSave,
    handleDeleteEntry,
    handleRenameEntry,
    // Favorite Hub
    handleFavUploadToHub,
    handleFavUpdateOnHub,
    handleFavRemoveFromHub,
    handleFavRenameOnHub,
    // Reset
    resetHubState,
  }
}
