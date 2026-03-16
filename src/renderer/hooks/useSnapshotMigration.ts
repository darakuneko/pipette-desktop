// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  isVilFile,
  isVilFileV1,
  migrateVilFileToV2,
  VILFILE_CURRENT_VERSION,
} from '../../shared/vil-file'
import { EMPTY_UID } from '../../shared/constants/protocol'
import type { DeviceInfo, VilFile, KeyboardDefinition } from '../../shared/types/protocol'
import type { HubEntryResult } from '../components/editors/LayoutStoreModal'

interface Options {
  connectedDevice: DeviceInfo | null
  isDummy: boolean
  keyboardLoading: boolean
  keyboardUid: string | undefined
  definition: KeyboardDefinition | null
  viaProtocol: number
  vialProtocol: number
  featureFlags: number
  deviceSyncing: boolean
  phase2SyncPending: boolean
  layoutStoreRefreshEntries: () => Promise<void>
  backfillQmkSettings: (vil: VilFile) => boolean
  hubCanUpload: boolean
  buildHubPostParams: (entry: { label: string }, vilData: VilFile) => Promise<{
    title: string
    keyboardName: string
    vilJson: string
    pipetteJson: string
    keymapC: string
    pdfBase64: string
    thumbnailBase64: string
  }>
  refreshHubPosts: () => Promise<void>
  setHubUploadResult: (result: HubEntryResult | null) => void
}

interface MigrationResult {
  migrationChecking: boolean
  migrating: boolean
  migrationProgress: string | null
}

export function useSnapshotMigration(options: Options): MigrationResult {
  const {
    connectedDevice,
    isDummy,
    keyboardLoading,
    keyboardUid,
    definition,
    viaProtocol,
    vialProtocol,
    featureFlags,
    deviceSyncing,
    phase2SyncPending,
    layoutStoreRefreshEntries,
    backfillQmkSettings,
    hubCanUpload,
    buildHubPostParams,
    refreshHubPosts,
    setHubUploadResult,
  } = options

  const { t } = useTranslation()

  const [migrationChecking, setMigrationChecking] = useState(false)
  const [migrating, setMigrating] = useState(false)
  const [migrationProgress, setMigrationProgress] = useState<string | null>(null)
  const hasMigratedRef = useRef<string | null>(null)
  const pendingHubMigrationRef = useRef<Array<{ id: string; label: string; hubPostId: string; upgraded: VilFile }>>([])
  const [hubMigrationReady, setHubMigrationReady] = useState(false)

  // Keep overlay visible between loading and migration check
  useLayoutEffect(() => {
    if (!connectedDevice || isDummy) return
    if (keyboardLoading || deviceSyncing || phase2SyncPending) return
    if (!keyboardUid || keyboardUid === EMPTY_UID) return
    if (!definition) return
    if (hasMigratedRef.current === keyboardUid) return
    setMigrationChecking(true)
  }, [connectedDevice, isDummy, keyboardLoading, keyboardUid,
      definition, deviceSyncing, phase2SyncPending])

  // Auto-migrate v1 snapshots to v2
  useEffect(() => {
    if (!migrationChecking) return
    if (hasMigratedRef.current === keyboardUid) return

    hasMigratedRef.current = keyboardUid!
    const uid = keyboardUid!
    const def = definition!

    ;(async () => {
      try {
        const listResult = await window.vialAPI.snapshotStoreList(uid)
        if (!listResult.success || !listResult.entries) return

        const candidates = listResult.entries.filter(
          (e) => e.vilVersion == null || e.vilVersion < VILFILE_CURRENT_VERSION,
        )
        if (candidates.length === 0) return

        setMigrating(true)
        setMigrationProgress('loading.migrating')

        let migratedCount = 0
        const hubUpdateEntries: Array<{ id: string; label: string; hubPostId: string; upgraded: VilFile }> = []

        for (const entry of candidates) {
          setMigrationProgress(t('loading.migratingEntry', {
            current: migratedCount + 1,
            total: candidates.length,
          }))

          const loadResult = await window.vialAPI.snapshotStoreLoad(uid, entry.id)
          if (!loadResult.success || !loadResult.data) continue

          try {
            const parsed: unknown = JSON.parse(loadResult.data)
            if (!isVilFile(parsed) || !isVilFileV1(parsed)) continue

            const upgraded = migrateVilFileToV2(parsed, {
              definition: def,
              viaProtocol,
              vialProtocol,
              featureFlags,
            })
            backfillQmkSettings(upgraded)
            await window.vialAPI.snapshotStoreUpdate(
              uid, entry.id, JSON.stringify(upgraded, null, 2), upgraded.version,
            )
            migratedCount++

            if (entry.hubPostId) {
              hubUpdateEntries.push({ id: entry.id, label: entry.label, hubPostId: entry.hubPostId, upgraded })
            }
          } catch {
            console.warn(`[Migration] Failed to migrate snapshot ${entry.id}`)
          }
        }

        if (migratedCount > 0) {
          await layoutStoreRefreshEntries()

          if (hubUpdateEntries.length > 0) {
            pendingHubMigrationRef.current = hubUpdateEntries
            setHubMigrationReady(true)
          }
        }
      } catch (err) {
        console.warn('[Migration] Snapshot migration failed:', err)
      } finally {
        setMigrationChecking(false)
        setMigrating(false)
        setMigrationProgress(null)
      }
    })()
  }, [migrationChecking, keyboardUid, definition,
      layoutStoreRefreshEntries, t])

  // Update Hub posts after migration
  useEffect(() => {
    if (!hubMigrationReady || !hubCanUpload) return
    const entries = pendingHubMigrationRef.current
    if (entries.length === 0) return

    pendingHubMigrationRef.current = []
    setHubMigrationReady(false)

    ;(async () => {
      try {
        const succeededIds: string[] = []
        const results = await Promise.allSettled(
          entries.map(async ({ id, label, hubPostId, upgraded }) => {
            const postParams = await buildHubPostParams({ label }, upgraded)
            const result = await window.vialAPI.hubUpdatePost({ ...postParams, postId: hubPostId })
            if (!result.success) {
              console.warn(`[Migration] Hub update returned error for "${label}":`, result.error)
            } else {
              succeededIds.push(id)
            }
          }),
        )
        for (const r of results) {
          if (r.status === 'rejected') {
            console.warn('[Migration] Hub update failed:', r.reason)
          }
        }
        await refreshHubPosts()

        if (succeededIds.length > 0) {
          setHubUploadResult({
            kind: 'success',
            message: t('hub.updateSuccess'),
            entryId: succeededIds[0],
            entryIds: succeededIds,
          })
        }
      } catch (err) {
        console.warn('[Migration] Hub post update failed:', err)
      }
    })()
  }, [hubMigrationReady, hubCanUpload, buildHubPostParams, refreshHubPosts, t, setHubUploadResult])

  return { migrationChecking, migrating, migrationProgress }
}
