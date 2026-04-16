// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
import { BTN_PRIMARY, BTN_SECONDARY } from './settings-modal-shared'
import { SyncStatusSection } from './SyncStatusSection'
import { DisconnectConfirmButton } from './DisconnectConfirmButton'
import { PasswordSection } from './PasswordSection'
import { HubDisplayNameField } from './HubDisplayNameField'
import { ROW_CLASS } from '../editors/modal-controls'
import type { UseSyncReturn } from '../../hooks/useSync'

export interface SettingsDataTabProps {
  sync: UseSyncReturn
  hubEnabled: boolean
  hubAuthenticated: boolean
  hubDisplayName: string | null
  hubAuthConflict?: boolean
  hubAccountDeactivated?: boolean
  onHubEnabledChange: (enabled: boolean) => void
  onHubDisplayNameChange: (name: string) => Promise<{ success: boolean; error?: string }>
  onResolveAuthConflict?: (name: string) => Promise<{ success: boolean; error?: string }>
  authenticating: boolean
  authError: string | null
  busy: boolean
  confirmingGoogleDisconnect: boolean
  setConfirmingGoogleDisconnect: (v: boolean) => void
  confirmingHubDisconnect: boolean
  setConfirmingHubDisconnect: (v: boolean) => void
  password: string
  passwordScore: number | null
  passwordFeedback: string[]
  passwordError: string | null
  changingPassword: boolean
  setChangingPassword: (v: boolean) => void
  syncDisabled: boolean
  handleSignIn: () => void
  handleGoogleDisconnect: () => void
  handleHubDisconnect: () => void
  handlePasswordChange: (value: string) => void
  handleSetPassword: () => void
  clearPasswordForm: () => void
  handleSyncNow: () => void
  handleAutoSyncToggle: () => void
}

export function SettingsDataTab({
  sync,
  hubEnabled,
  hubAuthenticated,
  hubDisplayName,
  hubAuthConflict,
  hubAccountDeactivated,
  onHubEnabledChange,
  onHubDisplayNameChange,
  onResolveAuthConflict,
  authenticating,
  authError,
  busy,
  confirmingGoogleDisconnect,
  setConfirmingGoogleDisconnect,
  confirmingHubDisconnect,
  setConfirmingHubDisconnect,
  password,
  passwordScore,
  passwordFeedback,
  passwordError,
  changingPassword,
  setChangingPassword,
  syncDisabled,
  handleSignIn,
  handleGoogleDisconnect,
  handleHubDisconnect,
  handlePasswordChange,
  handleSetPassword,
  clearPasswordForm,
  handleSyncNow,
  handleAutoSyncToggle,
}: SettingsDataTabProps) {
  const { t } = useTranslation()

  return (
    <div className="pt-4">
      {/* Google Account */}
      <section className="mb-4">
        <h3 className="mb-3 text-[15px] font-bold text-content">
          {t('sync.googleAccount')}
        </h3>
        {sync.authStatus.authenticated ? (
          <div className="flex items-center justify-between">
            <span className="text-sm text-accent" data-testid="sync-auth-status">
              {t('sync.connected')}
            </span>
            <DisconnectConfirmButton
              confirming={confirmingGoogleDisconnect}
              onRequestConfirm={() => setConfirmingGoogleDisconnect(true)}
              onCancelConfirm={() => setConfirmingGoogleDisconnect(false)}
              onConfirm={handleGoogleDisconnect}
              disconnectLabelKey="sync.signOut"
              confirmLabelKey="sync.confirmDisconnect"
              disconnectTestId="sync-sign-out"
              confirmTestId="sync-sign-out-confirm"
              cancelTestId="sync-sign-out-cancel"
              warningKey={hubEnabled ? 'sync.disconnectHubWarning' : undefined}
              warningTestId="sync-disconnect-hub-warning"
            />
          </div>
        ) : (
          <div className="space-y-2">
            <button
              type="button"
              className="w-full rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
              onClick={handleSignIn}
              disabled={authenticating}
              data-testid="sync-sign-in"
            >
              {authenticating ? t('sync.authenticating') : t('sync.signIn')}
            </button>
            {authError && (
              <div className="text-xs text-danger" data-testid="sync-auth-error">
                {authError}
              </div>
            )}
          </div>
        )}
      </section>

      <hr className="my-4 border-edge" />

      {/* Data Sync */}
      <h3 className="mb-3 text-[15px] font-bold text-content" data-testid="data-sync-title">
        {t('settings.dataSync')}
      </h3>

      {/* Sync Unavailable */}
      {sync.syncUnavailable && (
        <div className="mb-4 flex items-center justify-between rounded border border-danger/30 bg-danger/10 p-3 text-sm text-danger" data-testid="sync-unavailable">
          <span>{t('sync.unavailable')}</span>
          <button
            type="button"
            className="ml-2 rounded border border-danger/50 px-2 py-1 text-xs hover:bg-danger/20"
            onClick={sync.retryRemoteCheck}
            data-testid="sync-retry-btn"
          >
            {t('sync.retry')}
          </button>
        </div>
      )}

      {/* Encryption Password */}
      <section className="mb-4">
        <h4 className="mb-2 text-sm font-medium text-content-secondary">
          {t('sync.encryptionPassword')}
        </h4>
        <PasswordSection
          sync={sync}
          password={password}
          passwordScore={passwordScore}
          passwordFeedback={passwordFeedback}
          passwordError={passwordError}
          changingPassword={changingPassword}
          busy={busy}
          onPasswordChange={handlePasswordChange}
          onSetPassword={handleSetPassword}
          onStartChange={() => setChangingPassword(true)}
          onCancelChange={clearPasswordForm}
        />
      </section>

      {/* Sync Controls */}
      <div className="mb-2 grid grid-cols-2 gap-3">
        <div className={ROW_CLASS} data-testid="sync-auto-row">
          <span className="text-[13px] font-medium text-content">
            {t('sync.autoSync')}
          </span>
          <button
            type="button"
            className={sync.config.autoSync ? BTN_SECONDARY : BTN_PRIMARY}
            onClick={handleAutoSyncToggle}
            disabled={!sync.config.autoSync && syncDisabled}
            data-testid={sync.config.autoSync ? 'sync-auto-off' : 'sync-auto-on'}
          >
            {t(sync.config.autoSync ? 'sync.disable' : 'sync.enable')}
          </button>
        </div>

        <div className={ROW_CLASS} data-testid="sync-manual-row">
          <span className="text-[13px] font-medium text-content">
            {t('sync.manualSync')}
          </span>
          <button
            type="button"
            className={BTN_PRIMARY}
            onClick={handleSyncNow}
            disabled={syncDisabled}
            data-testid="sync-now"
          >
            {t('sync.sync')}
          </button>
        </div>
      </div>

      {/* Sync Status */}
      <SyncStatusSection
        syncStatus={sync.syncStatus}
        progress={sync.progress}
        lastSyncResult={sync.lastSyncResult}
        syncReadinessReason={sync.syncReadinessReason}
      />

      <hr className="my-4 border-edge" />

      {/* Pipette Hub */}
      <h3 className="mb-3 text-[15px] font-bold text-content" data-testid="pipette-hub-title">
        {t('hub.pipetteHub')}
      </h3>

      <section className="mb-4">
        {hubEnabled ? (
          <div data-testid="hub-enable-row">
            <div className="flex items-center justify-between">
              <span className="text-sm text-accent" data-testid="hub-enabled-status">
                {t('hub.enabled')}
              </span>
              <DisconnectConfirmButton
                confirming={confirmingHubDisconnect}
                onRequestConfirm={() => setConfirmingHubDisconnect(true)}
                onCancelConfirm={() => setConfirmingHubDisconnect(false)}
                onConfirm={handleHubDisconnect}
                disconnectLabelKey="hub.disable"
                confirmLabelKey="hub.confirmDisconnect"
                disconnectTestId="hub-enable-toggle"
                confirmTestId="hub-disconnect-confirm"
                cancelTestId="hub-disconnect-cancel"
              />
            </div>
            {!hubAuthenticated && (
              <p className="mt-2 text-xs text-content-muted" data-testid="hub-requires-auth">
                {t('hub.requiresAuth')}
              </p>
            )}
          </div>
        ) : (
          <div data-testid="hub-enable-row">
            <button
              type="button"
              className="w-full rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
              onClick={() => onHubEnabledChange(true)}
              disabled={!hubAuthenticated}
              data-testid="hub-enable-toggle"
            >
              {t('hub.enable')}
            </button>
            {!hubAuthenticated && (
              <p className="mt-2 text-xs text-content-muted" data-testid="hub-requires-auth">
                {t('hub.requiresAuth')}
              </p>
            )}
          </div>
        )}
      </section>

      {/* Account Deactivated Warning */}
      {hubAccountDeactivated && hubAuthenticated && (
        <div
          className="mb-4 rounded border border-danger/50 bg-danger/10 p-3 text-sm text-danger"
          data-testid="hub-account-deactivated-warning"
        >
          {t('hub.accountDeactivated')}
        </div>
      )}

      {/* Auth Conflict Warning */}
      {hubAuthConflict && hubAuthenticated && (
        <section className="mb-4">
          <div
            className="rounded border border-warning/50 bg-warning/10 p-3 text-sm text-warning"
            data-testid="hub-auth-conflict-warning"
          >
            {t('hub.authDisplayNameConflict')}
          </div>
          <div className="mt-3">
            <HubDisplayNameField
              currentName={null}
              onSave={onResolveAuthConflict ?? onHubDisplayNameChange}
            />
          </div>
        </section>
      )}

      {/* Display Name */}
      {hubEnabled && hubAuthenticated && !hubAuthConflict && (
        <section className="mb-4">
          <HubDisplayNameField
            currentName={hubDisplayName}
            onSave={onHubDisplayNameChange}
          />
        </section>
      )}

    </div>
  )
}
