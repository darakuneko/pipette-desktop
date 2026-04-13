// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppConfig } from './hooks/useAppConfig'
import { useDeviceConnection } from './hooks/useDeviceConnection'
import { useKeyboard } from './hooks/useKeyboard'
import { useFileIO } from './hooks/useFileIO'
import { useLayoutStore } from './hooks/useLayoutStore'
import { useSideloadJson } from './hooks/useSideloadJson'
import { useTheme } from './hooks/useTheme'
import { useDevicePrefs } from './hooks/useDevicePrefs'
import { useSync } from './hooks/useSync'
import { useStartupNotification } from './hooks/useStartupNotification'
import { useDeviceAutoSync } from './hooks/useDeviceAutoSync'
import { useEditorUIState } from './hooks/useEditorUIState'
import { useFileHandlers } from './hooks/useFileHandlers'
import { useEntryOperations } from './hooks/useEntryOperations'
import { useHubState } from './hooks/useHubState'
import { useSnapshotMigration } from './hooks/useSnapshotMigration'
import { useDeviceLifecycle } from './hooks/useDeviceLifecycle'
import { formatDeviceId } from './app-types'
import { DeviceSelector } from './components/DeviceSelector'
import { SettingsModal } from './components/SettingsModal'
import { DataModal } from './components/DataModal'
import { NotificationModal } from './components/NotificationModal'
import { ConnectingOverlay } from './components/ConnectingOverlay'
import { StatusBar } from './components/StatusBar'
import { ComboPanelModal } from './components/editors/ComboPanelModal'
import { AltRepeatKeyPanelModal } from './components/editors/AltRepeatKeyPanelModal'
import { KeyOverridePanelModal } from './components/editors/KeyOverridePanelModal'
import { RGBConfigurator } from './components/editors/RGBConfigurator'
import { UnlockDialog } from './components/editors/UnlockDialog'
import { KeymapEditor, type KeymapEditorHandle } from './components/editors/KeymapEditor'
import { LayoutStoreContent } from './components/editors/LayoutStoreModal'
import { ROW_CLASS } from './components/editors/modal-controls'
import { ModalCloseButton } from './components/editors/ModalCloseButton'
import { decodeLayoutOptions } from '../shared/kle/layout-options'
import { generateKeymapC } from '../shared/keymap-export'
import { generateKeymapPdf } from '../shared/pdf-export'
import {
  serialize as serializeKeycode,
  serializeForCExport,
  keycodeLabel,
  isMask,
  findOuterKeycode,
  findInnerKeycode,
} from '../shared/keycodes/keycodes'
import { deserializeAllMacros } from '../preload/macro'
import { EMPTY_UID } from '../shared/constants/protocol'

export { type PipetteFileKeyboard, type PipetteFileEntry } from './app-types'

export function App() {
  const { t } = useTranslation()
  const appConfig = useAppConfig()
  const themeCtx = useTheme()
  const devicePrefs = useDevicePrefs()
  const device = useDeviceConnection()
  const keyboard = useKeyboard()
  const sync = useSync()
  const startupNotification = useStartupNotification()

  const effectiveIsDummy = device.isDummy && !device.isPipetteFile

  const deserializedMacros = useMemo(
    () => keyboard.parsedMacros
      ?? (keyboard.macroBuffer && keyboard.macroCount
        ? deserializeAllMacros(keyboard.macroBuffer, keyboard.vialProtocol, keyboard.macroCount)
        : undefined),
    [keyboard.parsedMacros, keyboard.macroBuffer, keyboard.macroCount, keyboard.vialProtocol],
  )

  useEffect(() => {
    keyboard.setSaveLayerNamesCallback(devicePrefs.setLayerNames)
  }, [keyboard.setSaveLayerNamesCallback, devicePrefs.setLayerNames])

  const decodedLayoutOptions = useMemo(() => {
    const labels = keyboard.definition?.layouts?.labels
    if (!labels) return new Map<number, number>()
    return decodeLayoutOptions(keyboard.layoutOptions, labels)
  }, [keyboard.definition, keyboard.layoutOptions])

  const deviceName = device.connectedDevice?.productName || 'keyboard'

  const keymapCGenerator = useCallback(
    () => generateKeymapC({
      layers: keyboard.layers,
      keys: keyboard.layout?.keys ?? [],
      keymap: keyboard.keymap,
      encoderLayout: keyboard.encoderLayout,
      encoderCount: keyboard.encoderCount,
      layoutOptions: decodedLayoutOptions,
      serializeKeycode: serializeForCExport,
      customKeycodes: keyboard.definition?.customKeycodes,
    }),
    [keyboard.layers, keyboard.layout, keyboard.keymap, keyboard.encoderLayout,
     keyboard.encoderCount, decodedLayoutOptions, keyboard.definition?.customKeycodes],
  )

  const pdfGenerator = useCallback(
    () => generateKeymapPdf({
      deviceName,
      layers: keyboard.layers,
      keys: keyboard.layout?.keys ?? [],
      keymap: keyboard.keymap,
      encoderLayout: keyboard.encoderLayout,
      encoderCount: keyboard.encoderCount,
      layoutOptions: decodedLayoutOptions,
      serializeKeycode,
      keycodeLabel,
      isMask,
      findOuterKeycode,
      findInnerKeycode,
      tapDance: keyboard.tapDanceEntries,
      combo: keyboard.comboEntries,
      keyOverride: keyboard.keyOverrideEntries,
      altRepeatKey: keyboard.altRepeatKeyEntries,
      macros: deserializedMacros,
    }),
    [deviceName, keyboard.layers, keyboard.layout, keyboard.keymap,
     keyboard.encoderLayout, keyboard.encoderCount, decodedLayoutOptions,
     keyboard.tapDanceEntries, keyboard.comboEntries, keyboard.keyOverrideEntries,
     keyboard.altRepeatKeyEntries, deserializedMacros],
  )

  const fileIO = useFileIO({
    deviceUid: keyboard.uid,
    deviceName: `${deviceName}_current`,
    serialize: keyboard.serialize,
    serializeVialGui: keyboard.serializeVialGui,
    applyVilFile: keyboard.applyVilFile,
    keymapCGenerator,
    pdfGenerator,
  })

  const sideload = useSideloadJson(keyboard.applyDefinition)

  const layoutStore = useLayoutStore({
    deviceUid: keyboard.uid,
    deviceName,
    serialize: keyboard.serialize,
    applyVilFile: keyboard.applyVilFile,
    currentDefinition: keyboard.definition,
  })

  // --- Extracted hooks ---

  const { deviceSyncing, phase2SyncPending } = useDeviceAutoSync({
    connectedDevice: device.connectedDevice,
    isPipetteFile: device.isPipetteFile,
    keyboardUid: keyboard.uid,
    keyboardLoading: keyboard.loading,
    syncLoading: sync.loading,
    autoSync: sync.config.autoSync,
    authenticated: sync.authStatus.authenticated,
    hasPassword: sync.hasPassword,
    syncNow: sync.syncNow,
  })

  const editorUI = useEditorUIState({
    isDummy: device.isDummy,
    effectiveIsDummy,
    supportedQsids: keyboard.supportedQsids,
    lighting: keyboard.definition?.lighting,
    dynamicCounts: keyboard.dynamicCounts,
    keymapScale: devicePrefs.keymapScale,
    setKeymapScale: devicePrefs.setKeymapScale,
  })

  const fileHandlers = useFileHandlers({
    fileIO,
    layoutLabels: keyboard.definition?.layouts?.labels,
    layoutKeys: keyboard.layout?.keys,
    decodedLayoutOptions,
    deviceName,
  })

  const entryOps = useEntryOperations({
    keyboardUid: keyboard.uid,
    definition: keyboard.definition,
    layout: keyboard.layout,
    encoderCount: keyboard.encoderCount,
    macroCount: keyboard.macroCount,
    vialProtocol: keyboard.vialProtocol,
    viaProtocol: keyboard.viaProtocol,
    rows: keyboard.rows,
    cols: keyboard.cols,
    qmkSettingsValues: keyboard.qmkSettingsValues,
    dynamicCountsFeatureFlags: keyboard.dynamicCounts.featureFlags,
    layoutStoreEntries: layoutStore.entries,
    deviceName,
  })

  const lifecycle = useDeviceLifecycle({
    connectDevice: device.connectDevice,
    disconnectDevice: device.disconnectDevice,
    connectDummy: device.connectDummy,
    connectPipetteFile: device.connectPipetteFile,
    isPipetteFile: device.isPipetteFile,
    keyboardUid: keyboard.uid,
    keyboardReload: keyboard.reload,
    keyboardReset: keyboard.reset,
    keyboardLoadDummy: keyboard.loadDummy,
    keyboardLoadPipetteFile: keyboard.loadPipetteFile,
    refreshUnlockStatus: keyboard.refreshUnlockStatus,
    unlocked: keyboard.unlockStatus.unlocked,
    activityCount: keyboard.activityCount,
    applyDevicePrefs: devicePrefs.applyDevicePrefs,
    autoLockTime: devicePrefs.autoLockTime,
    autoSync: sync.config.autoSync,
    authenticated: sync.authStatus.authenticated,
    hasPassword: sync.hasPassword,
    syncNow: sync.syncNow,
    deviceSyncing,
    resetUIState: editorUI.resetUIState,
    clearFileStatus: fileHandlers.clearFileStatus,
    resetHubState: () => hub.resetHubState(),
    matrixMode: editorUI.matrixState.matrixMode,
    typingTestMode: editorUI.typingTestMode,
    typingTestViewOnly: devicePrefs.typingTestViewOnly,
  })

  const hub = useHubState({
    hubEnabled: appConfig.config.hubEnabled,
    authenticated: sync.authStatus.authenticated,
    keyboardUid: keyboard.uid,
    layoutStoreEntries: layoutStore.entries,
    layoutStoreRefreshEntries: layoutStore.refreshEntries,
    layoutStoreDeleteEntry: layoutStore.deleteEntry,
    layoutStoreSaveLayout: layoutStore.saveLayout,
    layoutStoreRenameEntry: layoutStore.renameEntry,
    deviceName,
    effectiveIsDummy,
    loadEntryVilData: entryOps.loadEntryVilData,
    buildHubPostParams: entryOps.buildHubPostParams,
    activityCount: keyboard.activityCount,
    pipetteFileSavedActivityRef: lifecycle.pipetteFileSavedActivityRef,
  })

  const migration = useSnapshotMigration({
    connectedDevice: device.connectedDevice,
    isDummy: device.isDummy,
    keyboardLoading: keyboard.loading,
    keyboardUid: keyboard.uid,
    definition: keyboard.definition,
    viaProtocol: keyboard.viaProtocol,
    vialProtocol: keyboard.vialProtocol,
    featureFlags: keyboard.dynamicCounts.featureFlags,
    deviceSyncing,
    phase2SyncPending,
    layoutStoreRefreshEntries: layoutStore.refreshEntries,
    backfillQmkSettings: entryOps.backfillQmkSettings,
    hubCanUpload: hub.hubCanUpload,
    buildHubPostParams: entryOps.buildHubPostParams,
    refreshHubPosts: hub.refreshHubPosts,
    setHubUploadResult: hub.setHubUploadResult,
  })

  // Register boot guard unlock callback so setKey/setEncoder can trigger the dialog
  useEffect(() => {
    keyboard.setBootGuardUnlock(() => {
      editorUI.setShowUnlockDialog(true)
    })
  }, [keyboard.setBootGuardUnlock, editorUI.setShowUnlockDialog])

  const keymapEditorRef = useRef<KeymapEditorHandle>(null)

  // Hide content during view→edit transition animation
  const [viewExitTransition, setViewExitTransition] = useState(false)

  // Exit view-only mode: hide content → wait for paint → resize → show editor
  const exitViewOnlyMode = useCallback(() => {
    setViewExitTransition(true)
    requestAnimationFrame(() => { requestAnimationFrame(() => {
      window.vialAPI.setWindowCompactMode(false).then(() => {
        devicePrefs.setTypingTestViewOnly(false)
        keymapEditorRef.current?.toggleTypingTest()
        setViewExitTransition(false)
      }).catch(() => { setViewExitTransition(false) })
    }) })
  }, [devicePrefs])

  // Enter typing view-only mode (compact window + typing test). Assumes unlocked.
  const { typingTestViewOnlyWindowSize, setTypingTestViewOnly } = devicePrefs
  const enterTypingViewOnly = useCallback(() => {
    window.vialAPI.setWindowCompactMode(true, typingTestViewOnlyWindowSize).then(() => {
      setTypingTestViewOnly(true)
      if (!editorUI.typingTestMode) {
        keymapEditorRef.current?.toggleTypingTest()
      }
    }).catch(() => {})
  }, [typingTestViewOnlyWindowSize, setTypingTestViewOnly, editorUI.typingTestMode])

  // One-shot guard: prevents re-restoring the same uid after an initial restore
  const restoreRequestedUidRef = useRef<string | null>(null)

  // Pending refs for deferred user intents (set while unlock dialog is open)
  const pendingViewOnlyRef = useRef(false)
  const pendingTypingTestSaveRef = useRef(false)

  const { setViewMode } = devicePrefs
  const { resetUIState } = editorUI

  const prevConnectedRef = useRef(device.connectedDevice)
  useEffect(() => {
    const wasConnected = prevConnectedRef.current
    prevConnectedRef.current = device.connectedDevice
    if (wasConnected && !device.connectedDevice) {
      restoreRequestedUidRef.current = null
      pendingViewOnlyRef.current = false
      pendingTypingTestSaveRef.current = false
      // Auto-detect polling disconnect bypasses lifecycle.handleDisconnect,
      // so ephemeral UI state (typingTestMode etc.) must be reset here too.
      resetUIState()
      if (devicePrefs.typingTestViewOnly) {
        window.vialAPI.setWindowCompactMode(false).catch(() => {})
        window.vialAPI.setWindowAspectRatio(0).catch(() => {})
        window.vialAPI.setWindowAlwaysOnTop(false).catch(() => {})
        setTypingTestViewOnly(false)
        setViewExitTransition(false)
      }
    }
  }, [device.connectedDevice, devicePrefs.typingTestViewOnly, setTypingTestViewOnly, resetUIState])

  // Deferred view-only entry after unlock
  useEffect(() => {
    if (!device.connectedDevice) { pendingViewOnlyRef.current = false; return }
    if (pendingViewOnlyRef.current && keyboard.unlockStatus.unlocked) {
      pendingViewOnlyRef.current = false
      setViewMode('typingView')
      enterTypingViewOnly()
    }
  }, [device.connectedDevice, keyboard.unlockStatus.unlocked, enterTypingViewOnly, setViewMode])

  // Commit deferred typing-test save once state actually transitions to on.
  // Catches both immediate (unlocked click) and deferred (locked click → unlock) paths.
  useEffect(() => {
    if (pendingTypingTestSaveRef.current && editorUI.typingTestMode) {
      pendingTypingTestSaveRef.current = false
      setViewMode('typingTest')
    }
  }, [editorUI.typingTestMode, setViewMode])

  // Auto-restore last view mode once prefs are applied for the connected uid
  useEffect(() => {
    if (!device.connectedDevice || device.isDummy) return
    if (keyboard.loading || keyboard.uid === EMPTY_UID) return
    if (devicePrefs.appliedUid !== keyboard.uid) return
    if (restoreRequestedUidRef.current === keyboard.uid) return
    restoreRequestedUidRef.current = keyboard.uid
    // Restore is not a user intent — clear any stale pending save flags so the
    // watcher above does not misattribute the restore's state change to a user click.
    pendingTypingTestSaveRef.current = false
    pendingViewOnlyRef.current = false

    const mode = devicePrefs.viewMode
    if (mode === 'typingTest') {
      keymapEditorRef.current?.toggleTypingTest()
    } else if (mode === 'typingView') {
      if (keyboard.unlockStatus.unlocked) {
        enterTypingViewOnly()
      } else {
        pendingViewOnlyRef.current = true
        editorUI.setShowUnlockDialog(true)
      }
    }
  }, [
    device.connectedDevice,
    device.isDummy,
    keyboard.loading,
    keyboard.uid,
    keyboard.unlockStatus.unlocked,
    devicePrefs.appliedUid,
    devicePrefs.viewMode,
    enterTypingViewOnly,
    editorUI.setShowUnlockDialog,
  ])

  const handleLoadEntry = useCallback(async (entryId: string) => {
    const entry = layoutStore.entries.find((e) => e.id === entryId)
    const ok = await layoutStore.loadLayout(entryId)
    if (ok) {
      lifecycle.setLastLoadedLabel(entry?.label ?? '')
      fileHandlers.clearFileStatus()
    }
  }, [layoutStore, fileHandlers.clearFileStatus, lifecycle.setLastLoadedLabel])

  // --- Disconnected view ---
  if (!device.connectedDevice) {
    return (
      <>
        {deviceSyncing && (
          <div className="fixed inset-0 z-50">
            <ConnectingOverlay deviceName="" deviceId="" syncProgress={sync.progress} syncOnly />
          </div>
        )}
        <DeviceSelector
          devices={device.devices}
          connecting={device.connecting}
          error={lifecycle.fileLoadError || device.error}
          onConnect={lifecycle.handleConnect}
          onLoadDummy={lifecycle.handleLoadDummy}
          onLoadPipetteFile={lifecycle.handleLoadPipetteFile}
          pipetteFileKeyboards={lifecycle.pipetteFileKeyboards}
          pipetteFileEntries={lifecycle.pipetteFileEntries}
          connectedDeviceNames={device.devices.map((d) => d.productName)}
          onOpenPipetteFileEntry={lifecycle.handleOpenPipetteFileEntry}
          onRefreshPipetteFileEntries={lifecycle.refreshPipetteFileEntries}
          onOpenSettings={() => lifecycle.setShowSettings(true)}
          onOpenData={lifecycle.handleOpenDataModal}
          syncStatus={sync.syncStatus}
          deviceWarning={lifecycle.deviceLoadError}
          onClearError={lifecycle.clearFileLoadError}
        />
        {lifecycle.showSettings && (
          <SettingsModal
            sync={sync}
            theme={themeCtx.theme}
            onThemeChange={themeCtx.setTheme}
            defaultLayout={devicePrefs.defaultLayout}
            onDefaultLayoutChange={devicePrefs.setDefaultLayout}
            defaultAutoAdvance={devicePrefs.defaultAutoAdvance}
            onDefaultAutoAdvanceChange={devicePrefs.setDefaultAutoAdvance}
            defaultLayerPanelOpen={devicePrefs.defaultLayerPanelOpen}
            onDefaultLayerPanelOpenChange={devicePrefs.setDefaultLayerPanelOpen}
            defaultBasicViewType={devicePrefs.defaultBasicViewType}
            onDefaultBasicViewTypeChange={devicePrefs.setDefaultBasicViewType}
            defaultSplitKeyMode={devicePrefs.defaultSplitKeyMode}
            onDefaultSplitKeyModeChange={devicePrefs.setDefaultSplitKeyMode}
            defaultQuickSelect={devicePrefs.defaultQuickSelect}
            onDefaultQuickSelectChange={devicePrefs.setDefaultQuickSelect}
            autoLockTime={devicePrefs.autoLockTime}
            onAutoLockTimeChange={devicePrefs.setAutoLockTime}
            maxKeymapHistory={appConfig.config.maxKeymapHistory}
            onMaxKeymapHistoryChange={(n) => appConfig.set('maxKeymapHistory', n)}
            onClose={() => lifecycle.setShowSettings(false)}
            hubEnabled={appConfig.config.hubEnabled}
            onHubEnabledChange={(enabled) => appConfig.set('hubEnabled', enabled)}
            hubAuthenticated={sync.authStatus.authenticated}
            hubDisplayName={hub.hubDisplayName}
            onHubDisplayNameChange={hub.handleUpdateHubDisplayName}
            hubAuthConflict={hub.hubAuthConflict}
            onResolveAuthConflict={hub.handleResolveAuthConflict}
            hubAccountDeactivated={hub.hubAccountDeactivated}
          />
        )}
        {lifecycle.showDataModal && (
          <DataModal
            onClose={() => lifecycle.setShowDataModal(false)}
            sync={sync}
            hubEnabled={appConfig.config.hubEnabled}
            hubAuthenticated={sync.authStatus.authenticated}
            hubPosts={hub.hubMyPosts}
            hubPostsPagination={hub.hubMyPostsPagination}
            onHubRefresh={hub.refreshHubMyPosts}
            onHubRename={hub.handleHubRenamePost}
            onHubDelete={hub.handleHubDeletePost}
            hubOrigin={hub.hubOrigin}
            hubNeedsDisplayName={hub.hubReady && !hub.hubCanUpload}
            hubFavUploading={hub.favHubUploading}
            hubFavUploadResult={hub.favHubUploadResult}
            onFavUploadToHub={hub.hubCanUpload ? hub.handleFavUploadToHub : undefined}
            onFavUpdateOnHub={hub.hubCanUpload ? hub.handleFavUpdateOnHub : undefined}
            onFavRemoveFromHub={hub.hubReady ? hub.handleFavRemoveFromHub : undefined}
            onFavRenameOnHub={hub.hubReady ? hub.handleFavRenameOnHub : undefined}
            onResetStart={() => lifecycle.setResettingData(true)}
            onResetEnd={() => lifecycle.setResettingData(false)}
          />
        )}
        {startupNotification.visible && (
          <NotificationModal
            notifications={startupNotification.notifications}
            onClose={startupNotification.dismiss}
          />
        )}
      </>
    )
  }

  // --- Connected view ---
  const api = window.vialAPI

  const importBtnClass = 'rounded-lg border border-edge bg-surface/30 px-3 py-1.5 text-xs font-semibold text-content-muted hover:text-content hover:border-content-muted'

  const toolsExtra = (
    <>
      {(fileHandlers.handleImportVil || (!device.isDummy && sideload.sideloadJson)) && (
        <div className={ROW_CLASS} data-testid="overlay-import-row">
          <span className="text-[13px] font-medium text-content">{t('layoutStore.import')}</span>
          <div className="flex gap-2">
            <button
              type="button"
              className={importBtnClass}
              onClick={fileHandlers.handleImportVil}
              disabled={fileIO.saving || fileIO.loading}
              data-testid="overlay-import-vil"
            >
              {t('fileIO.loadLayout')}
            </button>
            {!device.isDummy && sideload.sideloadJson && (
              <button
                type="button"
                className={importBtnClass}
                onClick={sideload.sideloadJson}
                disabled={fileIO.saving || fileIO.loading}
                data-testid="overlay-sideload-json"
              >
                {t('fileIO.sideloadJson')}
              </button>
            )}
          </div>
        </div>
      )}
    </>
  )

  const dataPanel = (
    <div className="px-4 pb-3">
      <LayoutStoreContent
        entries={layoutStore.entries}
        loading={layoutStore.loading}
        saving={layoutStore.saving}
        fileStatus={fileHandlers.fileStatus}
        isDummy={effectiveIsDummy}
        defaultSaveLabel={lifecycle.lastLoadedLabel}
        onSave={async (label: string) => {
          const id = await layoutStore.saveLayout(label)
          if (id) lifecycle.pipetteFileSavedActivityRef.current = keyboard.activityCount
          return id
        }}
        onLoad={handleLoadEntry}
        onRename={hub.handleRenameEntry}
        onDelete={hub.handleDeleteEntry}
        onExportVil={fileHandlers.handleExportVil}
        onExportKeymapC={fileHandlers.handleExportKeymapC}
        onExportPdf={fileHandlers.handleExportPdf}
        onExportEntryVil={!effectiveIsDummy ? entryOps.handleExportEntryVil : undefined}
        onExportEntryKeymapC={!effectiveIsDummy ? entryOps.handleExportEntryKeymapC : undefined}
        onExportEntryPdf={!effectiveIsDummy ? entryOps.handleExportEntryPdf : undefined}
        onOverwriteSave={hub.handleOverwriteSave}
        onUploadToHub={hub.hubCanUpload ? hub.handleUploadToHub : undefined}
        onUpdateOnHub={hub.hubCanUpload ? hub.handleUpdateOnHub : undefined}
        onRemoveFromHub={hub.hubReady ? hub.handleRemoveFromHub : undefined}
        onReuploadToHub={hub.hubCanUpload ? hub.handleReuploadToHub : undefined}
        onDeleteOrphanedHubPost={hub.hubReady ? hub.handleDeleteOrphanedHubPost : undefined}
        keyboardName={deviceName}
        hubOrigin={hub.hubReady ? hub.hubOrigin : undefined}
        hubMyPosts={hub.hubReady ? hub.hubMyPosts : undefined}
        hubKeyboardPosts={hub.hubReady ? hub.hubKeyboardPosts : undefined}
        hubNeedsDisplayName={hub.hubReady && !hub.hubCanUpload}
        hubUploading={hub.hubUploading}
        hubUploadResult={hub.hubUploadResult}
        fileDisabled={fileIO.saving || fileIO.loading}
        listClassName="overflow-y-auto"
      />
    </div>
  )

  return (
    <div className="relative flex h-screen flex-col bg-surface text-content">
      {!keyboard.loading && (
        <>
          {device.isDummy && (
            <div className="flex items-center justify-between border-b border-warning/30 bg-warning/10 px-4 py-2 text-sm text-warning">
              <span>{device.isPipetteFile ? t('error.pipetteFileMode') : t('error.dummyMode')}</span>
              {device.isPipetteFile && keyboard.activityCount > lifecycle.pipetteFileSavedActivityRef.current && (
                <span className="text-danger" data-testid="unsaved-indicator">
                  {t('error.unsavedChanges')}
                </span>
              )}
            </div>
          )}

          {!device.isDummy && keyboard.uid === EMPTY_UID && (
            <div className="border-b border-warning/30 bg-warning/10 px-4 py-2 text-sm text-warning">
              {t('error.exampleUid')}
            </div>
          )}

          {keyboard.viaProtocol > 0 && keyboard.viaProtocol < 9 && (
            <div className="border-b border-danger/30 bg-danger/10 px-4 py-2 text-sm text-danger">
              {t('error.protocolVersion')}
            </div>
          )}

          {keyboard.connectionWarning && (
            <div className="border-b border-warning/30 bg-warning/10 px-4 py-2 text-sm text-warning">
              {t(keyboard.connectionWarning)}
            </div>
          )}
        </>
      )}

      {(keyboard.loading || deviceSyncing || phase2SyncPending || migration.migrationChecking || migration.migrating) && (
        <ConnectingOverlay
          deviceName={device.connectedDevice.productName || 'Unknown'}
          deviceId={formatDeviceId(device.connectedDevice)}
          loadingProgress={keyboard.loading ? keyboard.loadingProgress : migration.migrating ? migration.migrationProgress ?? undefined : undefined}
          syncProgress={deviceSyncing ? sync.progress : undefined}
          syncOnly={!keyboard.loading && !migration.migrating && !migration.migrationChecking}
        />
      )}

      {lifecycle.resettingData && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-surface" data-testid="resetting-overlay">
          <div className="flex flex-col items-center gap-4">
            <div className="h-1 w-48 overflow-hidden rounded bg-surface-dim">
              <div className="h-full w-3/5 animate-pulse rounded bg-danger" />
            </div>
            <p className="text-sm font-medium text-content-secondary">
              {t('sync.resettingData')}
            </p>
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        <div className={`flex min-h-0 flex-1 flex-col ${editorUI.typingTestMode && devicePrefs.typingTestViewOnly ? 'overflow-hidden p-0' : 'overflow-auto p-4'}`} data-testid="editor-content" style={viewExitTransition ? { display: 'none' } : undefined}>
          <KeymapEditor
            ref={keymapEditorRef}
            keyboardUid={keyboard.uid}
            layout={keyboard.layout}
            layers={keyboard.layers}
            currentLayer={editorUI.currentLayer}
            onLayerChange={editorUI.setCurrentLayer}
            keymap={keyboard.keymap}
            encoderLayout={keyboard.encoderLayout}
            encoderCount={keyboard.encoderCount}
            layoutOptions={decodedLayoutOptions}
            layoutLabels={keyboard.definition?.layouts?.labels}
            packedLayoutOptions={keyboard.layoutOptions}
            onSetLayoutOptions={keyboard.setLayoutOptions}
            remapLabel={devicePrefs.remapLabel}
            isRemapped={devicePrefs.isRemapped}
            onSetKey={keyboard.setKey}
            onSetKeysBulk={keyboard.setKeysBulk}
            onSetEncoder={keyboard.setEncoder}
            rows={keyboard.rows}
            cols={keyboard.cols}
            getMatrixState={!device.isDummy && keyboard.vialProtocol >= 3 ? api.getMatrixState : undefined}
            unlocked={keyboard.unlockStatus.unlocked}
            onUnlock={(options) => {
              editorUI.setShowUnlockDialog(true)
              editorUI.setUnlockMacroWarning(!!options?.macroWarning)
            }}
            tapDanceEntries={keyboard.tapDanceEntries}
            onSetTapDanceEntry={keyboard.setTapDanceEntry}
            macroCount={keyboard.macroCount}
            macroBufferSize={keyboard.macroBufferSize}
            macroBuffer={keyboard.macroBuffer}
            vialProtocol={keyboard.vialProtocol}
            parsedMacros={keyboard.parsedMacros}
            onSaveMacros={keyboard.setMacroBuffer}
            tapHoldSupported={editorUI.tapHoldSupported}
            mouseKeysSupported={editorUI.mouseKeysSupported}
            magicSupported={editorUI.magicSupported}
            graveEscapeSupported={editorUI.graveEscapeSupported}
            autoShiftSupported={editorUI.autoShiftSupported}
            oneShotKeysSupported={editorUI.oneShotKeysSupported}
            comboSettingsSupported={editorUI.comboSettingsSupported}
            supportedQsids={editorUI.hasAnySettings ? keyboard.supportedQsids : undefined}
            qmkSettingsGet={editorUI.hasAnySettings ? (device.isPipetteFile ? keyboard.pipetteFileQmkSettingsGet : api.qmkSettingsGet) : undefined}
            qmkSettingsSet={editorUI.hasAnySettings ? (device.isPipetteFile ? keyboard.pipetteFileQmkSettingsSet : api.qmkSettingsSet) : undefined}
            qmkSettingsReset={editorUI.hasAnySettings ? (device.isPipetteFile ? keyboard.pipetteFileQmkSettingsReset : api.qmkSettingsReset) : undefined}
            onSettingsUpdate={editorUI.hasAnySettings ? keyboard.updateQmkSettingsValue : undefined}
            autoAdvance={devicePrefs.autoAdvance}
            onAutoAdvanceChange={devicePrefs.setAutoAdvance}
            basicViewType={devicePrefs.basicViewType}
            onBasicViewTypeChange={devicePrefs.setBasicViewType}
            splitKeyMode={devicePrefs.splitKeyMode}
            onSplitKeyModeChange={devicePrefs.setSplitKeyMode}
            quickSelect={devicePrefs.quickSelect}
            onQuickSelectChange={devicePrefs.setQuickSelect}
            keyboardLayout={devicePrefs.layout}
            onKeyboardLayoutChange={devicePrefs.setLayout}
            onLock={lifecycle.handleLock}
            onMatrixModeChange={editorUI.handleMatrixModeChange}
            onOpenLighting={editorUI.lightingSupported ? () => editorUI.setShowLightingModal(true) : undefined}
            comboEntries={editorUI.comboSupported ? keyboard.comboEntries : undefined}
            onOpenCombo={editorUI.comboSupported ? (index: number) => editorUI.setComboInitialIndex(index) : undefined}
            onSetComboEntry={editorUI.comboSupported ? keyboard.setComboEntry : undefined}
            keyOverrideEntries={editorUI.keyOverrideSupported ? keyboard.keyOverrideEntries : undefined}
            onOpenKeyOverride={editorUI.keyOverrideSupported ? (index: number) => editorUI.setKeyOverrideInitialIndex(index) : undefined}
            onSetKeyOverrideEntry={editorUI.keyOverrideSupported ? keyboard.setKeyOverrideEntry : undefined}
            altRepeatKeyEntries={editorUI.altRepeatKeySupported ? keyboard.altRepeatKeyEntries : undefined}
            onOpenAltRepeatKey={editorUI.altRepeatKeySupported ? (index: number) => editorUI.setAltRepeatKeyInitialIndex(index) : undefined}
            onSetAltRepeatKeyEntry={editorUI.altRepeatKeySupported ? keyboard.setAltRepeatKeyEntry : undefined}
            layerNames={!effectiveIsDummy ? keyboard.layerNames : undefined}
            onSetLayerName={!effectiveIsDummy ? keyboard.setLayerName : undefined}
            toolsExtra={toolsExtra}
            dataPanel={dataPanel}
            onOverlayOpen={!effectiveIsDummy ? layoutStore.refreshEntries : undefined}
            layerPanelOpen={devicePrefs.layerPanelOpen}
            onLayerPanelOpenChange={devicePrefs.setLayerPanelOpen}
            scale={editorUI.keymapScale}
            onScaleChange={editorUI.adjustKeymapScale}
            typingTestMode={editorUI.typingTestMode}
            onTypingTestModeChange={editorUI.handleTypingTestModeChange}
            onSaveTypingTestResult={devicePrefs.addTypingTestResult}
            typingTestHistory={devicePrefs.typingTestResults}
            typingTestConfig={devicePrefs.typingTestConfig}
            typingTestLanguage={devicePrefs.typingTestLanguage}
            onTypingTestConfigChange={devicePrefs.setTypingTestConfig}
            onTypingTestLanguageChange={devicePrefs.setTypingTestLanguage}
            typingTestViewOnly={devicePrefs.typingTestViewOnly}
            onTypingTestViewOnlyChange={(enabled: boolean) => {
              pendingTypingTestSaveRef.current = false
              pendingViewOnlyRef.current = false
              if (!enabled) {
                setViewMode('editor')
                exitViewOnlyMode()
              } else {
                setViewMode('typingView')
                devicePrefs.setTypingTestViewOnly(true)
              }
            }}
            typingTestViewOnlyWindowSize={devicePrefs.typingTestViewOnlyWindowSize}
            onTypingTestViewOnlyWindowSizeChange={devicePrefs.setTypingTestViewOnlyWindowSize}
            typingTestViewOnlyAlwaysOnTop={devicePrefs.typingTestViewOnlyAlwaysOnTop}
            onTypingTestViewOnlyAlwaysOnTopChange={devicePrefs.setTypingTestViewOnlyAlwaysOnTop}
            deviceName={deviceName}
            isDummy={effectiveIsDummy}
            onExportLayoutPdfAll={fileHandlers.handleExportLayoutPdfAll}
            onExportLayoutPdfCurrent={fileHandlers.handleExportLayoutPdfCurrent}
            favHubOrigin={hub.hubReady ? hub.hubOrigin : undefined}
            favHubNeedsDisplayName={hub.hubReady && !hub.hubCanUpload}
            favHubUploading={hub.favHubUploading}
            favHubUploadResult={hub.favHubUploadResult}
            onFavUploadToHub={hub.hubCanUpload ? hub.handleFavUploadToHub : undefined}
            onFavUpdateOnHub={hub.hubCanUpload ? hub.handleFavUpdateOnHub : undefined}
            onFavRemoveFromHub={hub.hubReady ? hub.handleFavRemoveFromHub : undefined}
            onFavRenameOnHub={hub.hubReady ? hub.handleFavRenameOnHub : undefined}
            devices={device.devices}
            connectedDevice={device.connectedDevice}
            onDeviceListActiveChange={device.setDeviceListActive}
          />
        </div>

        {(fileIO.error || sideload.error || layoutStore.error) && (
          <div className="bg-danger/10 px-4 py-1.5 text-xs text-danger">
            {fileIO.error || sideload.error || layoutStore.error}
          </div>
        )}
      </div>

      {!(editorUI.typingTestMode && devicePrefs.typingTestViewOnly) && (
        <StatusBar
          deviceName={device.connectedDevice.productName || 'Unknown'}
          loadedLabel={lifecycle.lastLoadedLabel}
          autoAdvance={devicePrefs.autoAdvance}
          unlocked={keyboard.unlockStatus.unlocked}
          syncStatus={sync.syncStatus}
          hubConnected={sync.authStatus.authenticated ? hub.hubConnected : undefined}
          matrixMode={editorUI.matrixState.matrixMode}
          typingTestMode={editorUI.typingTestMode}
          hasMatrixTester={editorUI.matrixState.hasMatrixTester}
          comboActive={editorUI.comboSupported && keyboard.comboEntries.some((e) => e.output !== 0)}
          altRepeatKeyActive={editorUI.altRepeatKeySupported && keyboard.altRepeatKeyEntries.some((e) => e.enabled)}
          keyOverrideActive={editorUI.keyOverrideSupported && keyboard.keyOverrideEntries.some((e) => e.enabled)}
          viewOnly={devicePrefs.typingTestViewOnly}
          onViewOnlyChange={() => {
            pendingTypingTestSaveRef.current = false
            if (editorUI.typingTestMode && devicePrefs.typingTestViewOnly) {
              pendingViewOnlyRef.current = false
              setViewMode('editor')
              exitViewOnlyMode()
            } else if (!keyboard.unlockStatus.unlocked) {
              pendingViewOnlyRef.current = true
              editorUI.setShowUnlockDialog(true)
            } else {
              pendingViewOnlyRef.current = false
              setViewMode('typingView')
              enterTypingViewOnly()
            }
          }}
          onTypingTestModeChange={() => {
            pendingViewOnlyRef.current = false
            if (editorUI.typingTestMode) {
              setViewMode('editor')
              pendingTypingTestSaveRef.current = false
            } else {
              pendingTypingTestSaveRef.current = true
            }
            keymapEditorRef.current?.toggleTypingTest()
          }}
          onDisconnect={editorUI.typingTestMode ? undefined : lifecycle.handleDisconnect}
        />
      )}

      {editorUI.showUnlockDialog && !device.isDummy && (
        <UnlockDialog
          keys={keyboard.layout?.keys ?? []}
          unlockKeys={keyboard.unlockStatus.keys}
          layoutOptions={decodedLayoutOptions}
          unlockStart={() => { device.setPollSuspended(true); return api.unlockStart() }}
          unlockPoll={api.unlockPoll}
          onComplete={async () => {
            device.setPollSuspended(false)
            editorUI.setShowUnlockDialog(false)
            editorUI.setUnlockMacroWarning(false)
            await keyboard.refreshUnlockStatus()
          }}
          onDisconnect={() => {
            device.setPollSuspended(false)
            editorUI.setShowUnlockDialog(false)
            editorUI.setUnlockMacroWarning(false)
            keyboard.rejectPendingUnlock()
          }}
          macroWarning={editorUI.unlockMacroWarning}
        />
      )}

      {editorUI.showLightingModal && editorUI.lightingSupported && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          data-testid="lighting-modal-backdrop"
          onClick={() => editorUI.setShowLightingModal(false)}
        >
          <div
            className="w-[500px] max-w-[90vw] max-h-[80vh] overflow-y-auto rounded-lg bg-surface-alt p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold">{t('editor.lighting.title')}</h3>
              <ModalCloseButton testid="lighting-modal-close" onClick={() => editorUI.setShowLightingModal(false)} />
            </div>
            <RGBConfigurator
              lightingType={keyboard.definition?.lighting}
              backlightBrightness={keyboard.backlightBrightness}
              backlightEffect={keyboard.backlightEffect}
              rgblightBrightness={keyboard.rgblightBrightness}
              rgblightEffect={keyboard.rgblightEffect}
              rgblightEffectSpeed={keyboard.rgblightEffectSpeed}
              rgblightHue={keyboard.rgblightHue}
              rgblightSat={keyboard.rgblightSat}
              vialRGBVersion={keyboard.vialRGBVersion}
              vialRGBMode={keyboard.vialRGBMode}
              vialRGBSpeed={keyboard.vialRGBSpeed}
              vialRGBHue={keyboard.vialRGBHue}
              vialRGBSat={keyboard.vialRGBSat}
              vialRGBVal={keyboard.vialRGBVal}
              vialRGBMaxBrightness={keyboard.vialRGBMaxBrightness}
              vialRGBSupported={keyboard.vialRGBSupported}
              onSetBacklightBrightness={keyboard.setBacklightBrightness}
              onSetBacklightEffect={keyboard.setBacklightEffect}
              onSetRgblightBrightness={keyboard.setRgblightBrightness}
              onSetRgblightEffect={keyboard.setRgblightEffect}
              onSetRgblightEffectSpeed={keyboard.setRgblightEffectSpeed}
              onSetRgblightColor={keyboard.setRgblightColor}
              onSetVialRGBMode={keyboard.setVialRGBMode}
              onSetVialRGBSpeed={keyboard.setVialRGBSpeed}
              onSetVialRGBColor={keyboard.setVialRGBColor}
              onSetVialRGBBrightness={keyboard.setVialRGBBrightness}
              onSetVialRGBHSV={keyboard.setVialRGBHSV}
              onSave={api.saveLighting}
            />
          </div>
        </div>
      )}

      {editorUI.comboSupported && editorUI.comboInitialIndex !== null && (
        <ComboPanelModal
          entries={keyboard.comboEntries}
          onSetEntry={keyboard.setComboEntry}
          initialIndex={editorUI.comboInitialIndex}
          unlocked={keyboard.unlockStatus.unlocked}
          onUnlock={() => editorUI.setShowUnlockDialog(true)}
          tapDanceEntries={keyboard.tapDanceEntries}
          deserializedMacros={deserializedMacros}
          quickSelect={devicePrefs.quickSelect}
          splitKeyMode={devicePrefs.splitKeyMode}
          basicViewType={devicePrefs.basicViewType}
          onClose={() => editorUI.setComboInitialIndex(null)}
          hubOrigin={hub.hubReady ? hub.hubOrigin : undefined}
          hubNeedsDisplayName={hub.hubReady && !hub.hubCanUpload}
          hubUploading={hub.favHubUploading}
          hubUploadResult={hub.favHubUploadResult}
          onUploadToHub={hub.hubCanUpload ? (entryId) => hub.handleFavUploadToHub('combo', entryId) : undefined}
          onUpdateOnHub={hub.hubCanUpload ? (entryId) => hub.handleFavUpdateOnHub('combo', entryId) : undefined}
          onRemoveFromHub={hub.hubReady ? (entryId) => hub.handleFavRemoveFromHub('combo', entryId) : undefined}
          onRenameOnHub={hub.hubReady ? hub.handleFavRenameOnHub : undefined}
        />
      )}

      {editorUI.altRepeatKeySupported && editorUI.altRepeatKeyInitialIndex !== null && (
        <AltRepeatKeyPanelModal
          entries={keyboard.altRepeatKeyEntries}
          onSetEntry={keyboard.setAltRepeatKeyEntry}
          initialIndex={editorUI.altRepeatKeyInitialIndex}
          unlocked={keyboard.unlockStatus.unlocked}
          onUnlock={() => editorUI.setShowUnlockDialog(true)}
          tapDanceEntries={keyboard.tapDanceEntries}
          deserializedMacros={deserializedMacros}
          quickSelect={devicePrefs.quickSelect}
          splitKeyMode={devicePrefs.splitKeyMode}
          basicViewType={devicePrefs.basicViewType}
          onClose={() => editorUI.setAltRepeatKeyInitialIndex(null)}
          hubOrigin={hub.hubReady ? hub.hubOrigin : undefined}
          hubNeedsDisplayName={hub.hubReady && !hub.hubCanUpload}
          hubUploading={hub.favHubUploading}
          hubUploadResult={hub.favHubUploadResult}
          onUploadToHub={hub.hubCanUpload ? (entryId) => hub.handleFavUploadToHub('altRepeatKey', entryId) : undefined}
          onUpdateOnHub={hub.hubCanUpload ? (entryId) => hub.handleFavUpdateOnHub('altRepeatKey', entryId) : undefined}
          onRemoveFromHub={hub.hubReady ? (entryId) => hub.handleFavRemoveFromHub('altRepeatKey', entryId) : undefined}
          onRenameOnHub={hub.hubReady ? hub.handleFavRenameOnHub : undefined}
        />
      )}

      {editorUI.keyOverrideSupported && editorUI.keyOverrideInitialIndex !== null && (
        <KeyOverridePanelModal
          entries={keyboard.keyOverrideEntries}
          onSetEntry={keyboard.setKeyOverrideEntry}
          initialIndex={editorUI.keyOverrideInitialIndex}
          unlocked={keyboard.unlockStatus.unlocked}
          onUnlock={() => editorUI.setShowUnlockDialog(true)}
          tapDanceEntries={keyboard.tapDanceEntries}
          deserializedMacros={deserializedMacros}
          quickSelect={devicePrefs.quickSelect}
          splitKeyMode={devicePrefs.splitKeyMode}
          basicViewType={devicePrefs.basicViewType}
          onClose={() => editorUI.setKeyOverrideInitialIndex(null)}
          hubOrigin={hub.hubReady ? hub.hubOrigin : undefined}
          hubNeedsDisplayName={hub.hubReady && !hub.hubCanUpload}
          hubUploading={hub.favHubUploading}
          hubUploadResult={hub.favHubUploadResult}
          onUploadToHub={hub.hubCanUpload ? (entryId) => hub.handleFavUploadToHub('keyOverride', entryId) : undefined}
          onUpdateOnHub={hub.hubCanUpload ? (entryId) => hub.handleFavUpdateOnHub('keyOverride', entryId) : undefined}
          onRemoveFromHub={hub.hubReady ? (entryId) => hub.handleFavRemoveFromHub('keyOverride', entryId) : undefined}
          onRenameOnHub={hub.hubReady ? hub.handleFavRenameOnHub : undefined}
        />
      )}

      {startupNotification.visible && (
        <NotificationModal
          notifications={startupNotification.notifications}
          onClose={startupNotification.dismiss}
        />
      )}
    </div>
  )
}
