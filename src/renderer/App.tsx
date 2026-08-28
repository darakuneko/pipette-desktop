// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { useSessionRestore } from './hooks/useSessionRestore'
import { useBootHiddenWindow } from './hooks/useBootHiddenWindow'
import { useMissingKeyLabelNotice } from './hooks/useMissingKeyLabelNotice'
import { useTypingRecordingTray } from './hooks/use-typing-recording-tray'
import { useFileGenerators } from './hooks/use-file-generators'
import { formatDeviceId } from './app-types'
import { AppBanners } from './components/AppBanners'
import { AppDisconnectedView } from './components/AppDisconnectedView'
import { AppModals } from './components/AppModals'
import { AppEditorSurface } from './components/AppEditorSurface'
import { ConnectingOverlay } from './components/ConnectingOverlay'
import { AppStatusBar } from './components/AppStatusBar'
import type { KeymapEditorHandle } from './components/editors/KeymapEditor'
import type { KeymapApplyResult } from './components/editors/keymap-editor-types'
import { useKeymapApplyPrompt } from './hooks/useKeymapApplyPrompt'
import { useViewModeRouting } from './hooks/use-view-mode-routing'
import type { KeymapRewriteTable } from '../shared/keymap/keymap-apply'
import { AnalyzePage } from './components/analyze/AnalyzePage'
import type { ConnectedTappingTerm } from './components/analyze/analyze-types'
import { decodeLayoutOptions } from '../shared/kle/layout-options'
import { resolveConnectedTappingTerm, resolveTappingTerm } from '../shared/qmk-settings-tapping-term'
import { deserializeAllMacros } from '../preload/macro'
import { EMPTY_UID } from '../shared/constants/protocol'

export { type PipetteFileKeyboard, type PipetteFileEntry } from './app-types'

export function App() {
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

  const { keymapCGenerator, pdfGenerator } = useFileGenerators({
    keyboard,
    deviceName,
    decodedLayoutOptions,
    deserializedMacros,
  })

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
    macroCount: keyboard.macroCount,
    vialProtocol: keyboard.vialProtocol,
    viaProtocol: keyboard.viaProtocol,
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
    packsPulledOnce: sync.config.packsPulledOnce,
    markPacksPulledOnce: () => appConfig.set('packsPulledOnce', true),
    resetUIState: editorUI.resetUIState,
    clearFileStatus: fileHandlers.clearFileStatus,
    resetHubState: () => hub.resetHubState(),
    matrixMode: editorUI.matrixState.matrixMode,
    typingTestMode: editorUI.typingTestMode,
    typingTestViewOnly: devicePrefs.typingTestViewOnly,
    typingRecordEnabled: devicePrefs.typingRecordEnabled ?? false,
    // Same-value guards: every appConfig.set rewrites the whole config
    // file and re-renders all useAppConfig consumers, so skip the write
    // when reconnecting the same keyboard / disconnecting with nothing
    // remembered.
    saveLastDevice: (dev) => {
      const cur = appConfig.config.lastDevice
      if (cur &&
          cur.vendorId === dev.vendorId &&
          cur.productId === dev.productId &&
          cur.serialNumber === (dev.serialNumber || undefined)) return
      appConfig.set('lastDevice', {
        vendorId: dev.vendorId,
        productId: dev.productId,
        ...(dev.serialNumber ? { serialNumber: dev.serialNumber } : {}),
      })
    },
    clearLastDevice: () => {
      if (appConfig.config.lastDevice == null) return
      appConfig.set('lastDevice', null)
    },
  })

  useSessionRestore({
    configLoaded: !appConfig.loading,
    restoreEnabled: appConfig.config.restoreLastSession === true,
    devices: device.devices,
    connectedDevice: device.connectedDevice,
    lastDevice: appConfig.config.lastDevice ?? null,
    connect: lifecycle.handleConnect,
  })

  // Show the window only for the Unlock dialog while a hidden launch
  // (startInTray) is restoring the last session; hide it again once the
  // dialog resolves. Opening the dialog itself is owned solely by the
  // view-restore effects below (typingView restore, typingTest/matrix-test
  // entry) — they are view-mode aware, so a boot-hidden restore into a
  // view that does not require unlocking (e.g. the plain keymap editor)
  // never forces a prompt. No-ops entirely once the boot-hidden phase ends.
  useBootHiddenWindow({
    unlockDialogVisible: editorUI.showUnlockDialog,
  })

  const missingKeyLabel = useMissingKeyLabelNotice(keyboard.uid || null)

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
    vialProtocol: keyboard.vialProtocol,
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

  // Resolved once here and reused both for KeymapEditor's `tappingTermMs`
  // prop below and for `connectedTappingTerm` — a single source so the
  // two can't read a different `reported` rule from each other.
  const tappingTerm = useMemo(
    () => resolveTappingTerm(keyboard.qmkSettingsValues),
    [keyboard.qmkSettingsValues],
  )
  // TAPPING_TERM of the physically connected keyboard, threaded down to
  // the Analyze page's TappingTermCard (AnalyzePane matches this
  // against its own selected keyboard — see AnalyzePaneProps). The
  // live-connection / file-backed gating is tested directly on
  // `resolveConnectedTappingTerm` (see its doc comment) rather than
  // here — `keyboard.uid` alone would lag behind an auto-disconnect.
  const connectedTappingTerm: ConnectedTappingTerm | null = useMemo(
    () => resolveConnectedTappingTerm(!!device.connectedDevice, device.isPipetteFile, keyboard.uid, tappingTerm),
    [device.connectedDevice, device.isPipetteFile, keyboard.uid, tappingTerm],
  )

  // REC-unlock gate's callback (use-typing-recording-tray.ts) — reuses the
  // same dialog as the boot-guard/restore paths above, just requested from
  // a different trigger.
  const requestUnlockDialog = useCallback(() => {
    editorUI.setShowUnlockDialog(true)
  }, [editorUI.setShowUnlockDialog])

  const { handleTypingRecordEnabledChange, recKeystroke } = useTypingRecordingTray({
    keyboard,
    devicePrefs,
    typingTestMode: editorUI.typingTestMode,
    isDummy: device.isDummy,
    connectedDevice: device.connectedDevice,
    onRequestUnlockDialog: requestUnlockDialog,
  })

  // Whether an editor typing test is mid-run — surfaced from KeymapEditor so
  // the StatusBar's "View Analytics" button can be disabled mid-run.
  const [typingTestRunning, setTypingTestRunning] = useState(false)

  const handleApplyKeymapRewrite = useCallback(async (table: KeymapRewriteTable): Promise<KeymapApplyResult> => {
    return await (keymapEditorRef.current?.applyKeymapRewrite(table) ?? Promise.resolve({ appliedCount: 0 }))
  }, [])

  // Plan-qwerty-select-no-rewrite v7 — シミュレーションタブ方式: lifted out of
  // QuickSettingsSelects (the footer's Keyboard Layout select) because the
  // Apply button that now opens this modal lives on KeymapEditor's
  // simulation tab instead — both need the same pending/apply state, so it
  // is owned here and threaded down to each. `handleKeyboardLayoutChange`
  // still goes to the select as a plain display switch; `requestApply` goes
  // to KeymapEditor's Apply button. `isApplying` (aliased `keymapApplyBusy`
  // below) is also what gates the footer's Analyze button while a rewrite
  // is mid-flight (see its own comment at the `analyzeDisabled` prop) — its
  // true window fully contains the actual `applyKeymapRewrite` call (it
  // flips true just before `onApplyKeymapRewrite` is invoked and clears
  // only once that call settles), so no separate in-flight flag is needed.
  const {
    handleKeyboardLayoutChange: handleKeyboardLayoutSelectChange,
    requestApply: requestKeymapApply,
    pendingApply: pendingKeymapApply,
    handleApplyCancel: handleKeymapApplyCancel,
    handleApplyConfirm: handleKeymapApplyConfirm,
    applyError: keymapApplyError,
    isApplying: keymapApplyBusy,
  } = useKeymapApplyPrompt({
    keymapEditable: keyboard.keymap.size > 0,
    keyboardLayout: devicePrefs.layout,
    onKeyboardLayoutChange: devicePrefs.setLayout,
    onApplyKeymapRewrite: handleApplyKeymapRewrite,
    keymapRestoreSeq: keyboard.keymapRestoreSeq,
    activeRewriteTable: devicePrefs.activeRewriteTable,
    activeLayoutName: devicePrefs.activeLayoutName,
  })

  const {
    viewExitTransition,
    analyticsPageOpen,
    handleViewAnalytics,
    handleAnalyticsBack,
    timelineHandoff,
    openRunTimeline,
    onTypingTestViewOnlyChange,
    onStatusBarViewOnlyChange,
    onStatusBarTypingTestModeChange,
  } = useViewModeRouting({
    device,
    keyboard,
    devicePrefs,
    editorUI,
    appConfig,
    keymapEditorRef,
  })

  // Restore cleanup (Plan-qwerty-select-no-rewrite §snapshot/.vil 復元時の
  // クリーンアップ): snapshot/layout-store restore and .vil import both
  // converge on `applyVilFile`, which bumps `keymapRestoreSeq` on success.
  // Reacting here (rather than inside KeymapEditor) is what reaches the
  // Keyboard Layout select's confirm modal in QuickSettingsSelects (see its
  // own `keymapRestoreSeq` prop below), which lives outside KeymapEditor.
  // The counter is monotonic for the session (disconnect carries it forward
  // instead of zeroing it, see keyboard-types.ts), so any change here means
  // a restore landed.
  const prevKeymapRestoreSeqRef = useRef(keyboard.keymapRestoreSeq)
  useEffect(() => {
    const prev = prevKeymapRestoreSeqRef.current
    prevKeymapRestoreSeqRef.current = keyboard.keymapRestoreSeq
    if (keyboard.keymapRestoreSeq === prev) return
    keymapEditorRef.current?.clearHistory()
  }, [keyboard.keymapRestoreSeq])

  // --- Disconnected view ---
  if (!device.connectedDevice) {
    return (
      <AppDisconnectedView
        deviceSyncing={deviceSyncing}
        device={device}
        sync={sync}
        lifecycle={lifecycle}
        themeCtx={themeCtx}
        devicePrefs={devicePrefs}
        appConfig={appConfig}
        hub={hub}
        startupNotification={startupNotification}
      />
    )
  }

  // --- Connected view ---

  return (
    <div className="relative flex h-screen flex-col bg-surface text-content">
      <AppBanners device={device} keyboard={keyboard} lifecycle={lifecycle} />

      {(keyboard.loading || deviceSyncing || phase2SyncPending || migration.migrationChecking || migration.migrating) && (
        <ConnectingOverlay
          deviceName={device.connectedDevice.productName || 'Unknown'}
          deviceId={formatDeviceId(device.connectedDevice)}
          loadingProgress={keyboard.loading ? keyboard.loadingProgress : migration.migrating ? migration.migrationProgress ?? undefined : undefined}
          syncProgress={deviceSyncing ? sync.progress : undefined}
          syncOnly={!keyboard.loading && !migration.migrating && !migration.migrationChecking}
        />
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        {analyticsPageOpen ? (
          <AnalyzePage
            initialUid={keyboard.uid && keyboard.uid !== EMPTY_UID ? keyboard.uid : undefined}
            onBack={handleAnalyticsBack}
            connectedTappingTerm={connectedTappingTerm}
            onOpenRunTimeline={openRunTimeline}
          />
        ) : (
          <AppEditorSurface
            device={device}
            keyboard={keyboard}
            editorUI={editorUI}
            devicePrefs={devicePrefs}
            appConfig={appConfig}
            hub={hub}
            layoutStore={layoutStore}
            fileHandlers={fileHandlers}
            entryOps={entryOps}
            fileIO={fileIO}
            sideload={sideload}
            lifecycle={lifecycle}
            deviceName={deviceName}
            effectiveIsDummy={effectiveIsDummy}
            decodedLayoutOptions={decodedLayoutOptions}
            tappingTerm={tappingTerm}
            viewExitTransition={viewExitTransition}
            editorRef={keymapEditorRef}
            requestKeymapApply={requestKeymapApply}
            pendingKeymapApply={pendingKeymapApply}
            handleKeymapApplyConfirm={handleKeymapApplyConfirm}
            handleKeymapApplyCancel={handleKeymapApplyCancel}
            keymapApplyError={keymapApplyError}
            keymapApplyBusy={keymapApplyBusy}
            recKeystroke={recKeystroke}
            onTypingTestViewOnlyChange={onTypingTestViewOnlyChange}
            handleViewAnalytics={handleViewAnalytics}
            timelineHandoff={timelineHandoff}
            setTypingTestRunning={setTypingTestRunning}
          />
        )}

        {(fileIO.error || sideload.error || layoutStore.error) && (
          <div className="bg-danger/10 px-4 py-1.5 text-xs text-danger">
            {fileIO.error || sideload.error || layoutStore.error}
          </div>
        )}
      </div>

      <AppStatusBar
        connectedDevice={device.connectedDevice}
        keyboard={keyboard}
        editorUI={editorUI}
        devicePrefs={devicePrefs}
        sync={sync}
        hub={hub}
        themeCtx={themeCtx}
        lifecycle={lifecycle}
        analyticsPageOpen={analyticsPageOpen}
        onStatusBarViewOnlyChange={onStatusBarViewOnlyChange}
        onStatusBarTypingTestModeChange={onStatusBarTypingTestModeChange}
        handleViewAnalytics={handleViewAnalytics}
        handleTypingRecordEnabledChange={handleTypingRecordEnabledChange}
        handleKeyboardLayoutSelectChange={handleKeyboardLayoutSelectChange}
        keymapApplyBusy={keymapApplyBusy}
        typingTestRunning={typingTestRunning}
      />

      <AppModals
        device={device}
        keyboard={keyboard}
        editorUI={editorUI}
        devicePrefs={devicePrefs}
        hub={hub}
        startupNotification={startupNotification}
        missingKeyLabel={missingKeyLabel}
        decodedLayoutOptions={decodedLayoutOptions}
        deserializedMacros={deserializedMacros}
      />
    </div>
  )
}
