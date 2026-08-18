// SPDX-License-Identifier: GPL-2.0-or-later
// The connected-view editor surface: the overlay's Import row
// (`toolsExtra`), File tab (`dataPanel`), and the `editor-content` div
// wrapping the ~130-prop KeymapEditor itself. Split out of App.tsx
// (Task-split-app-tsx) — this is the highest-traffic e2e surface in the
// app, so the `editor-content` testid div and its style-based
// (never conditional-render) visibility toggle move verbatim.

import { useCallback, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { LayoutStoreContent } from './editors/LayoutStoreModal'
import { IMPORT_BTN } from './editors/layout-store-types'
import { ROW_CLASS } from './editors/modal-controls'
import { KeymapEditor, type KeymapEditorHandle } from './editors/KeymapEditor'
import type { AnalyticsOrigin } from './editors/keymap-editor-types'
import type { TimelineHandoff } from '../hooks/useRunTimelineHandoff'
import type { useDeviceConnection } from '../hooks/useDeviceConnection'
import type { useKeyboard } from '../hooks/useKeyboard'
import type { useEditorUIState } from '../hooks/useEditorUIState'
import type { UseDevicePrefsReturn } from '../hooks/useDevicePrefs'
import type { useAppConfig } from '../hooks/useAppConfig'
import type { useHubState } from '../hooks/useHubState'
import type { useLayoutStore } from '../hooks/useLayoutStore'
import type { useFileHandlers } from '../hooks/useFileHandlers'
import type { useEntryOperations } from '../hooks/useEntryOperations'
import type { useFileIO } from '../hooks/useFileIO'
import type { useSideloadJson } from '../hooks/useSideloadJson'
import type { useDeviceLifecycle } from '../hooks/useDeviceLifecycle'
import type { useRecKeystrokeCounter } from '../hooks/useRecKeystrokeCounter'
import type { decodeLayoutOptions } from '../../shared/kle/layout-options'
import type { ResolvedTappingTerm } from '../../shared/qmk-settings-tapping-term'
import { ZOOM_FACTOR_DEFAULT } from '../../shared/types/app-config'

interface Props {
  device: ReturnType<typeof useDeviceConnection>
  keyboard: ReturnType<typeof useKeyboard>
  editorUI: ReturnType<typeof useEditorUIState>
  devicePrefs: UseDevicePrefsReturn
  appConfig: ReturnType<typeof useAppConfig>
  hub: ReturnType<typeof useHubState>
  layoutStore: ReturnType<typeof useLayoutStore>
  fileHandlers: ReturnType<typeof useFileHandlers>
  entryOps: ReturnType<typeof useEntryOperations>
  fileIO: ReturnType<typeof useFileIO>
  sideload: ReturnType<typeof useSideloadJson>
  lifecycle: ReturnType<typeof useDeviceLifecycle>
  deviceName: string
  effectiveIsDummy: boolean
  decodedLayoutOptions: ReturnType<typeof decodeLayoutOptions>
  tappingTerm: ResolvedTappingTerm
  viewExitTransition: boolean
  editorRef: RefObject<KeymapEditorHandle | null>
  requestKeymapApply: () => void
  pendingKeymapApply: { id: string; name: string } | null
  handleKeymapApplyConfirm: () => void
  handleKeymapApplyCancel: () => void
  keymapApplyError: string | null
  keymapApplyBusy: boolean
  recKeystroke: ReturnType<typeof useRecKeystrokeCounter>
  onTypingTestViewOnlyChange: (enabled: boolean) => void
  handleViewAnalytics: (origin: AnalyticsOrigin) => void
  timelineHandoff: TimelineHandoff | null
  setTypingTestRunning: (running: boolean) => void
}

export function AppEditorSurface({
  device,
  keyboard,
  editorUI,
  devicePrefs,
  appConfig,
  hub,
  layoutStore,
  fileHandlers,
  entryOps,
  fileIO,
  sideload,
  lifecycle,
  deviceName,
  effectiveIsDummy,
  decodedLayoutOptions,
  tappingTerm,
  viewExitTransition,
  editorRef,
  requestKeymapApply,
  pendingKeymapApply,
  handleKeymapApplyConfirm,
  handleKeymapApplyCancel,
  keymapApplyError,
  keymapApplyBusy,
  recKeystroke,
  onTypingTestViewOnlyChange,
  handleViewAnalytics,
  timelineHandoff,
  setTypingTestRunning,
}: Props) {
  const { t } = useTranslation()
  const api = window.vialAPI

  const handleLoadEntry = useCallback(async (entryId: string) => {
    const entry = layoutStore.entries.find((e) => e.id === entryId)
    const ok = await layoutStore.loadLayout(entryId)
    if (ok) {
      lifecycle.setLastLoadedLabel(entry?.label ?? '')
      fileHandlers.clearFileStatus()
    }
  }, [layoutStore, fileHandlers.clearFileStatus, lifecycle.setLastLoadedLabel])

  const toolsExtra = (
    <>
      {/* handleImportVil / sideloadJson are always-defined functions, so the
          old function-reference guards were constant-true — the row always
          renders and only the sideload button is gated (on !isDummy). */}
      <div className={ROW_CLASS} data-testid="overlay-import-row">
        <span className="text-sm font-medium text-content">{t('layoutStore.import')}</span>
        <div className="flex gap-2">
          <button
            type="button"
            className={IMPORT_BTN}
            onClick={fileHandlers.handleImportVil}
            disabled={fileIO.saving || fileIO.loading}
            data-testid="overlay-import-vil"
          >
            {t('fileIO.loadLayout')}
          </button>
          {!device.isDummy && (
            <button
              type="button"
              className={IMPORT_BTN}
              onClick={sideload.sideloadJson}
              disabled={fileIO.saving || fileIO.loading}
              data-testid="overlay-sideload-json"
            >
              {t('fileIO.sideloadJson')}
            </button>
          )}
        </div>
      </div>
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
    <div className={`flex min-h-0 flex-1 flex-col ${editorUI.typingTestMode && devicePrefs.typingTestViewOnly ? 'overflow-hidden p-0' : 'overflow-auto p-4'}`} data-testid="editor-content" style={viewExitTransition ? { display: 'none' } : undefined}>
      <KeymapEditor
        ref={editorRef}
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
        remapKind={devicePrefs.remapKind}
        pickerRemapLabel={devicePrefs.pickerRemapLabel}
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
        tappingTermMs={tappingTerm.termMs}
        autoAdvance={devicePrefs.autoAdvance}
        onAutoAdvanceChange={devicePrefs.setAutoAdvance}
        viewMatrix={devicePrefs.viewMatrix}
        onViewMatrixChange={devicePrefs.setViewMatrix}
        basicViewType={devicePrefs.basicViewType}
        onBasicViewTypeChange={devicePrefs.setBasicViewType}
        splitKeyMode={devicePrefs.splitKeyMode}
        onSplitKeyModeChange={devicePrefs.setSplitKeyMode}
        quickSelect={devicePrefs.quickSelect}
        onQuickSelectChange={devicePrefs.setQuickSelect}
        keyboardLayout={devicePrefs.layout}
        onKeyboardLayoutChange={devicePrefs.setLayout}
        keymapPackName={devicePrefs.activeLayoutName}
        onRequestKeymapApply={requestKeymapApply}
        keymapApplyOpen={pendingKeymapApply !== null}
        keymapApplyLabelName={pendingKeymapApply?.name}
        keymapApplyBusy={keymapApplyBusy}
        onKeymapApplyConfirm={handleKeymapApplyConfirm}
        onKeymapApplyCancel={handleKeymapApplyCancel}
        keymapApplyError={keymapApplyError}
        onLock={lifecycle.handleLock}
        onTypingRecordDisarm={() => devicePrefs.setTypingRecordEnabled(false)}
        unlockStatusKnown={keyboard.unlockStatusKnown}
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
        keyEditorZoom={devicePrefs.keyEditorZoom ?? (appConfig.config.zoomFactor ?? ZOOM_FACTOR_DEFAULT)}
        onKeyEditorZoomChange={devicePrefs.setKeyEditorZoom}
        typingTestMode={editorUI.typingTestMode}
        onTypingTestModeChange={editorUI.handleTypingTestModeChange}
        onSaveTypingTestResult={devicePrefs.addTypingTestResult}
        onRenameTypingTestResult={devicePrefs.renameTypingTestResult}
        onDeleteTypingTestResult={devicePrefs.deleteTypingTestResult}
        typingTestHistory={devicePrefs.typingTestResults}
        typingTestConfig={devicePrefs.typingTestConfig}
        typingTestMonkeytypeConfig={devicePrefs.typingTestMonkeytypeConfig}
        typingTestLanguage={devicePrefs.typingTestLanguage}
        onTypingTestConfigChange={devicePrefs.setTypingTestConfig}
        onTypingTestLanguageChange={devicePrefs.setTypingTestLanguage}
        typingTestViewOnly={devicePrefs.typingTestViewOnly}
        onTypingTestViewOnlyChange={onTypingTestViewOnlyChange}
        typingTestViewOnlyWindowSize={devicePrefs.typingTestViewOnlyWindowSize}
        onTypingTestViewOnlyWindowSizeChange={devicePrefs.setTypingTestViewOnlyWindowSize}
        typingTestViewOnlyAlwaysOnTop={devicePrefs.typingTestViewOnlyAlwaysOnTop}
        onTypingTestViewOnlyAlwaysOnTopChange={devicePrefs.setTypingTestViewOnlyAlwaysOnTop}
        typingTestMemory={devicePrefs.typingTestMemory}
        onTypingTestMemoryChange={devicePrefs.setTypingTestMemory}
        typingTestDisplayLines={devicePrefs.typingTestDisplayLines}
        typingTestFontSize={devicePrefs.typingTestFontSize}
        onTypingTestDisplayLinesChange={devicePrefs.setTypingTestDisplayLines}
        onTypingTestFontSizeChange={devicePrefs.setTypingTestFontSize}
        typingTestHideKeymap={devicePrefs.typingTestHideKeymap}
        typingTestHideStatsRow={devicePrefs.typingTestHideStatsRow}
        typingTestHideControls={devicePrefs.typingTestHideControls}
        typingTestSaveUnnamed={devicePrefs.typingTestSaveUnnamed}
        typingTestComparisonBaselines={devicePrefs.typingTestComparisonBaselines}
        onTypingTestHideKeymapChange={devicePrefs.setTypingTestHideKeymap}
        onTypingTestHideStatsRowChange={devicePrefs.setTypingTestHideStatsRow}
        onTypingTestHideControlsChange={devicePrefs.setTypingTestHideControls}
        onTypingTestSaveUnnamedChange={devicePrefs.setTypingTestSaveUnnamed}
        onTypingTestComparisonBaselineChange={devicePrefs.setTypingTestComparisonBaseline}
        typingTestSettingsPanelOpen={devicePrefs.typingTestSettingsPanelOpen}
        onTypingTestSettingsPanelOpenChange={devicePrefs.setTypingTestSettingsPanelOpen}
        typingRecordEnabled={devicePrefs.typingRecordEnabled}
        onRecKeystroke={recKeystroke.increment}
        typingHeatmapWindowMin={appConfig.config.typingHeatmapWindowMin}
        typingRecordingConsentAccepted={appConfig.config.typingRecordingConsentAccepted}
        onViewAnalytics={handleViewAnalytics}
        timelineHandoff={timelineHandoff}
        onTypingTestRunningChange={setTypingTestRunning}
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
  )
}
