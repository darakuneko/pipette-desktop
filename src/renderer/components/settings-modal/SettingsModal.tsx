// SPDX-License-Identifier: GPL-2.0-or-later

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { TABS } from './settings-modal-shared'
import type { SettingsModalProps } from './settings-modal-shared'
import { useSettingsSync } from './useSettingsSync'
import { SettingsToolsTab } from './SettingsToolsTab'
import { SettingsDataTab } from './SettingsDataTab'
import { SettingsNotificationTab } from './SettingsNotificationTab'
import { ModalCloseButton } from '../editors/ModalCloseButton'
import { useEscapeClose } from '../../hooks/useEscapeClose'
import { ModalTabBar, ModalTabPanel } from '../editors/modal-tabs'
import { AboutTabContent } from '../AboutTabContent'
import type { ModalTabId } from '../editors/modal-tabs'

export function SettingsModal({
  sync,
  connectedKeyboardUid,
  theme,
  onThemeChange,
  defaultLayout,
  onDefaultLayoutChange,
  defaultAutoAdvance,
  onDefaultAutoAdvanceChange,
  defaultLayerPanelOpen,
  onDefaultLayerPanelOpenChange,
  defaultBasicViewType,
  onDefaultBasicViewTypeChange,
  defaultSplitKeyMode,
  onDefaultSplitKeyModeChange,
  defaultQuickSelect,
  onDefaultQuickSelectChange,
  autoLockTime,
  onAutoLockTimeChange,
  maxKeymapHistory,
  onMaxKeymapHistoryChange,
  onClose,
  hubEnabled,
  onHubEnabledChange,
  hubAuthenticated,
  hubDisplayName,
  onHubDisplayNameChange,
  hubAuthConflict,
  onResolveAuthConflict,
  hubAccountDeactivated,
}: SettingsModalProps) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<ModalTabId>('tools')

  const syncState = useSettingsSync({
    sync,
    connectedKeyboardUid,
    hubEnabled,
    onHubEnabledChange,
    activeTab,
  })

  useEscapeClose(onClose, !syncState.busy)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="settings-backdrop"
      onClick={syncState.busy ? undefined : onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-busy={syncState.busy}
        aria-labelledby="settings-title"
        className="w-[760px] max-w-[90vw] h-[min(840px,85vh)] flex flex-col rounded-2xl bg-surface-alt border border-edge shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        data-testid="settings-modal"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-0 shrink-0">
          <h2 id="settings-title" className="text-lg font-bold text-content">{t('settings.title')}</h2>
          {!syncState.busy && <ModalCloseButton testid="settings-close" onClick={onClose} />}
        </div>

        <ModalTabBar
          tabs={TABS}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          idPrefix="settings"
          testIdPrefix="settings"
        />

        <ModalTabPanel activeTab={activeTab} idPrefix="settings">
          {activeTab === 'tools' && (
            <SettingsToolsTab
              theme={theme}
              onThemeChange={onThemeChange}
              defaultLayout={defaultLayout}
              onDefaultLayoutChange={onDefaultLayoutChange}
              defaultAutoAdvance={defaultAutoAdvance}
              onDefaultAutoAdvanceChange={onDefaultAutoAdvanceChange}
              defaultLayerPanelOpen={defaultLayerPanelOpen}
              onDefaultLayerPanelOpenChange={onDefaultLayerPanelOpenChange}
              defaultBasicViewType={defaultBasicViewType}
              onDefaultBasicViewTypeChange={onDefaultBasicViewTypeChange}
              defaultSplitKeyMode={defaultSplitKeyMode}
              onDefaultSplitKeyModeChange={onDefaultSplitKeyModeChange}
              defaultQuickSelect={defaultQuickSelect}
              onDefaultQuickSelectChange={onDefaultQuickSelectChange}
              autoLockTime={autoLockTime}
              onAutoLockTimeChange={onAutoLockTimeChange}
              maxKeymapHistory={maxKeymapHistory}
              onMaxKeymapHistoryChange={onMaxKeymapHistoryChange}
            />
          )}
          {activeTab === 'data' && (
            <SettingsDataTab
              sync={sync}
              hubEnabled={hubEnabled}
              hubAuthenticated={hubAuthenticated}
              hubDisplayName={hubDisplayName}
              hubAuthConflict={hubAuthConflict}
              hubAccountDeactivated={hubAccountDeactivated}
              onHubEnabledChange={onHubEnabledChange}
              onHubDisplayNameChange={onHubDisplayNameChange}
              onResolveAuthConflict={onResolveAuthConflict}
              authenticating={syncState.authenticating}
              authError={syncState.authError}
              busy={syncState.busy}
              confirmingGoogleDisconnect={syncState.confirmingGoogleDisconnect}
              setConfirmingGoogleDisconnect={syncState.setConfirmingGoogleDisconnect}
              confirmingHubDisconnect={syncState.confirmingHubDisconnect}
              setConfirmingHubDisconnect={syncState.setConfirmingHubDisconnect}
              password={syncState.password}
              passwordScore={syncState.passwordScore}
              passwordFeedback={syncState.passwordFeedback}
              passwordError={syncState.passwordError}
              changingPassword={syncState.changingPassword}
              setChangingPassword={syncState.setChangingPassword}
              syncDisabled={syncState.syncDisabled}
              handleSignIn={syncState.handleSignIn}
              handleGoogleDisconnect={syncState.handleGoogleDisconnect}
              handleHubDisconnect={syncState.handleHubDisconnect}
              handlePasswordChange={syncState.handlePasswordChange}
              handleSetPassword={syncState.handleSetPassword}
              clearPasswordForm={syncState.clearPasswordForm}
              handleSyncNow={syncState.handleSyncNow}
              handleAutoSyncToggle={syncState.handleAutoSyncToggle}
            />
          )}
          {activeTab === 'notification' && (
            <SettingsNotificationTab
              recentNotifications={syncState.recentNotifications}
              notificationLoading={syncState.notificationLoading}
            />
          )}
          {activeTab === 'about' && <AboutTabContent />}
        </ModalTabPanel>
      </div>
    </div>
  )
}
