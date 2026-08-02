// SPDX-License-Identifier: GPL-2.0-or-later
// The disconnected-view shell (device picker + settings/data modals that
// remain reachable without a live keyboard). Split out of App.tsx
// (Task-split-app-tsx).

import { ConnectingOverlay } from './ConnectingOverlay'
import { DeviceSelector } from './DeviceSelector'
import { SettingsModal } from './SettingsModal'
import { DataModal } from './DataModal'
import { NotificationModal } from './NotificationModal'
import { JaRemovedBanner } from './i18n-packs/JaRemovedBanner'
import type { useDeviceConnection } from '../hooks/useDeviceConnection'
import type { UseSyncReturn } from '../hooks/useSync'
import type { useDeviceLifecycle } from '../hooks/useDeviceLifecycle'
import type { useTheme } from '../hooks/useTheme'
import type { UseDevicePrefsReturn } from '../hooks/useDevicePrefs'
import type { useAppConfig } from '../hooks/useAppConfig'
import type { useHubState } from '../hooks/useHubState'
import type { useStartupNotification } from '../hooks/useStartupNotification'

interface Props {
  deviceSyncing: boolean
  device: ReturnType<typeof useDeviceConnection>
  sync: UseSyncReturn
  lifecycle: ReturnType<typeof useDeviceLifecycle>
  themeCtx: ReturnType<typeof useTheme>
  devicePrefs: UseDevicePrefsReturn
  appConfig: ReturnType<typeof useAppConfig>
  hub: ReturnType<typeof useHubState>
  startupNotification: ReturnType<typeof useStartupNotification>
}

export function AppDisconnectedView({
  deviceSyncing,
  device,
  sync,
  lifecycle,
  themeCtx,
  devicePrefs,
  appConfig,
  hub,
  startupNotification,
}: Props) {
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
          hubCanUpload={hub.hubCanUpload}
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
        />
      )}
      {startupNotification.visible && (
        <NotificationModal
          notifications={startupNotification.notifications}
          onClose={startupNotification.dismiss}
        />
      )}
      <JaRemovedBanner />
    </>
  )
}
