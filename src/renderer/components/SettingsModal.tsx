// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Monitor, Sun, Moon } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { ModalCloseButton } from './editors/ModalCloseButton'
import { ROW_CLASS, toggleTrackClass, toggleKnobClass } from './editors/modal-controls'
import { formatDate, formatDateShort } from './editors/store-modal-shared'
import { ModalTabBar, ModalTabPanel } from './editors/modal-tabs'
import { SYNC_STATUS_CLASS } from './sync-ui'
import type { ModalTabId } from './editors/modal-tabs'
import type { SyncStatusType, LastSyncResult, SyncProgress, SyncResetTargets, LocalResetTargets, UndecryptableFile } from '../../shared/types/sync'
import type { UseSyncReturn } from '../hooks/useSync'
import type { ThemeMode } from '../hooks/useTheme'
import type { KeyboardLayoutId, AutoLockMinutes } from '../hooks/useDevicePrefs'
import { HUB_ERROR_DISPLAY_NAME_CONFLICT, HUB_ERROR_RATE_LIMITED } from '../../shared/types/hub'
import { KEYBOARD_LAYOUTS } from '../data/keyboard-layouts'
import i18n, { SUPPORTED_LANGUAGES } from '../i18n'
import { AboutTabContent } from './AboutTabContent'
import { useAppConfig } from '../hooks/useAppConfig'
import type { AppNotification } from '../../shared/types/notification'

const TABS = [
  { id: 'tools' as const, labelKey: 'settings.tabTools' },
  { id: 'data' as const, labelKey: 'settings.tabData' },
  { id: 'notification' as const, labelKey: 'settings.tabNotification' },
  { id: 'about' as const, labelKey: 'settings.tabAbout' },
]

function scoreColor(score: number | null): string {
  if (score === null) return 'bg-surface-dim'
  if (score < 2) return 'bg-danger'
  if (score < 4) return 'bg-warning'
  return 'bg-accent'
}

const BTN_PRIMARY = 'rounded bg-accent px-3 py-1 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50'
const BTN_SECONDARY = 'rounded border border-edge px-3 py-1 text-sm text-content-secondary hover:bg-surface-dim disabled:opacity-50'
const BTN_DANGER_OUTLINE = 'rounded border border-danger px-3 py-1 text-sm text-danger hover:bg-danger/10'

interface SyncStatusSectionProps {
  syncStatus: SyncStatusType
  progress: SyncProgress | null
  lastSyncResult: LastSyncResult | null
}

function SyncStatusSection({ syncStatus, progress, lastSyncResult }: SyncStatusSectionProps) {
  const { t } = useTranslation()

  return (
    <section className="mb-6">
      {syncStatus === 'none' ? (
        <span className="text-sm text-content-muted" data-testid="sync-status-label">
          {t('sync.noSyncYet')}
        </span>
      ) : (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className={`text-sm ${SYNC_STATUS_CLASS[syncStatus]}`} data-testid="sync-status-label">
              {t(`statusBar.sync.${syncStatus}`)}
            </span>
            {syncStatus === 'syncing' && progress?.current != null && progress?.total != null && (
              <span className="text-xs text-content-muted" data-testid="sync-status-progress">
                {progress.current} / {progress.total}
              </span>
            )}
            {lastSyncResult?.timestamp != null && syncStatus !== 'syncing' && (
              <span className="ml-auto text-xs text-content-muted" data-testid="sync-status-time">
                {formatDate(lastSyncResult.timestamp)}
              </span>
            )}
          </div>
          {syncStatus === 'syncing' && progress?.syncUnit && (
            <div className="text-xs text-content-muted" data-testid="sync-status-unit">
              {progress.syncUnit}
            </div>
          )}
          {syncStatus === 'error' && lastSyncResult?.message && (
            <div
              className="rounded border border-danger/30 bg-danger/10 px-2 py-1 text-xs text-danger"
              data-testid="sync-status-error-message"
            >
              {t(lastSyncResult.message, lastSyncResult.message)}
            </div>
          )}
          {syncStatus === 'partial' && lastSyncResult?.failedUnits && lastSyncResult.failedUnits.length > 0 && (
            <div
              className="rounded border border-warning/30 bg-warning/10 px-2 py-1 text-xs text-warning"
              data-testid="sync-status-partial-details"
            >
              <div>{t(lastSyncResult.message ?? '', lastSyncResult.message ?? '')}</div>
              <ul className="mt-1 list-disc pl-4">
                {lastSyncResult.failedUnits.map((unit) => (
                  <li key={unit}>{unit}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

interface UndecryptableFilesSectionProps {
  sync: UseSyncReturn
  disabled: boolean
}

function UndecryptableFilesSection({ sync, disabled }: UndecryptableFilesSectionProps) {
  const { t } = useTranslation()
  const [files, setFiles] = useState<UndecryptableFile[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleScan = useCallback(async () => {
    setScanning(true)
    setFiles(null)
    setSelected(new Set())
    setConfirming(false)
    setError(null)
    try {
      const result = await sync.listUndecryptable()
      setFiles(result)
    } catch {
      setError(t('statusBar.sync.error'))
    } finally {
      setScanning(false)
    }
  }, [sync, t])

  const toggleFile = useCallback((fileId: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(fileId)) next.delete(fileId)
      else next.add(fileId)
      return next
    })
    setConfirming(false)
  }, [])

  const toggleAll = useCallback(() => {
    if (!files) return
    if (selected.size === files.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(files.map((f) => f.fileId)))
    }
    setConfirming(false)
  }, [files, selected.size])

  const handleDelete = useCallback(async () => {
    if (selected.size === 0) return
    setDeleting(true)
    setError(null)
    try {
      const result = await sync.deleteFiles([...selected])
      if (result.success) {
        setFiles((prev) => prev?.filter((f) => !selected.has(f.fileId)) ?? null)
        setSelected(new Set())
        setConfirming(false)
      } else {
        setError(result.error ?? t('statusBar.sync.error'))
      }
    } catch {
      setError(t('statusBar.sync.error'))
    } finally {
      setDeleting(false)
    }
  }, [sync, selected, t])

  const allSelected = files !== null && files.length > 0 && selected.size === files.length

  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-sm font-medium text-content-secondary">
          {t('sync.undecryptable')}
        </h4>
        <button
          type="button"
          className={BTN_SECONDARY}
          onClick={handleScan}
          disabled={disabled || scanning}
          data-testid="undecryptable-scan"
        >
          {scanning ? t('sync.scanning') : t('sync.scanUndecryptable')}
        </button>
      </div>
      {error && (
        <div className="mb-2 text-xs text-danger" data-testid="undecryptable-error">
          {error}
        </div>
      )}
      {files !== null && (
        <div className="space-y-2">
          {files.length === 0 ? (
            <p className="text-sm text-content-muted" data-testid="undecryptable-empty">
              {t('sync.noUndecryptable')}
            </p>
          ) : (
            <>
              <p className="text-sm text-content-muted" data-testid="undecryptable-count">
                {t('sync.undecryptableFound', { count: files.length })}
              </p>
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  className="text-xs text-content-muted hover:text-content"
                  onClick={toggleAll}
                  data-testid="undecryptable-toggle-all"
                >
                  {allSelected ? t('sync.deselectAll') : t('sync.selectAll')}
                </button>
              </div>
              <div className="max-h-40 overflow-y-auto space-y-1">
                {files.map((file) => (
                  <label
                    key={file.fileId}
                    className="flex items-center gap-2 rounded border border-edge bg-surface/20 px-2 py-1.5 text-sm text-content"
                    data-testid={`undecryptable-file-${file.fileId}`}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(file.fileId)}
                      onChange={() => toggleFile(file.fileId)}
                      disabled={deleting}
                      className="accent-danger"
                    />
                    <span className="truncate">{file.syncUnit ?? file.fileName}</span>
                  </label>
                ))}
              </div>
              <div className="flex items-center justify-end">
                <button
                  type="button"
                  className={`${BTN_DANGER_OUTLINE} disabled:opacity-50`}
                  onClick={() => setConfirming(true)}
                  disabled={selected.size === 0 || deleting}
                  data-testid="undecryptable-delete"
                >
                  {t('sync.deleteUndecryptable')}
                </button>
              </div>
              {confirming && (
                <div className="space-y-2">
                  <div
                    className="rounded border border-danger/50 bg-danger/10 p-2 text-xs text-danger"
                    data-testid="undecryptable-delete-warning"
                  >
                    {t('sync.deleteUndecryptableConfirm')}
                  </div>
                  <div className="flex gap-2 justify-end">
                    <button
                      type="button"
                      className={BTN_SECONDARY}
                      onClick={() => setConfirming(false)}
                      disabled={deleting}
                      data-testid="undecryptable-delete-cancel"
                    >
                      {t('common.cancel')}
                    </button>
                    <button
                      type="button"
                      className="rounded bg-danger px-3 py-1 text-sm font-medium text-white hover:bg-danger/90 disabled:opacity-50"
                      onClick={handleDelete}
                      disabled={selected.size === 0 || deleting}
                      data-testid="undecryptable-delete-confirm"
                    >
                      {t('sync.deleteUndecryptable')}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}

interface DangerCheckboxItem {
  key: string
  checked: boolean
  labelKey: string
  testId: string
}

interface DangerCheckboxGroupProps {
  items: DangerCheckboxItem[]
  onToggle: (key: string, checked: boolean) => void
  disabled: boolean
  confirming: boolean
  onRequestConfirm: () => void
  onCancelConfirm: () => void
  onConfirm: () => void
  confirmWarningKey: string
  deleteTestId: string
  confirmTestId: string
  cancelTestId: string
  warningTestId: string
  busy: boolean
  confirmDisabled: boolean
}

function DangerCheckboxGroup({
  items,
  onToggle,
  disabled,
  confirming,
  onRequestConfirm,
  onCancelConfirm,
  onConfirm,
  confirmWarningKey,
  deleteTestId,
  confirmTestId,
  cancelTestId,
  warningTestId,
  busy,
  confirmDisabled,
}: DangerCheckboxGroupProps) {
  const { t } = useTranslation()
  const anySelected = items.some((item) => item.checked)

  return (
    <div className="space-y-2">
      {items.map((item) => (
        <label key={item.key} className="flex items-center gap-2 text-sm text-content" data-testid={item.testId}>
          <input
            type="checkbox"
            checked={item.checked}
            onChange={(e) => onToggle(item.key, e.target.checked)}
            disabled={disabled}
            className="accent-danger"
          />
          {t(item.labelKey)}
        </label>
      ))}
      <div className="flex items-center justify-end">
        <button
          type="button"
          className={`${BTN_DANGER_OUTLINE} disabled:opacity-50`}
          onClick={onRequestConfirm}
          disabled={disabled || !anySelected}
          data-testid={deleteTestId}
        >
          {t('sync.deleteSelected')}
        </button>
      </div>
      {confirming && (
        <div className="space-y-2">
          <div
            className="rounded border border-danger/50 bg-danger/10 p-2 text-xs text-danger"
            data-testid={warningTestId}
          >
            {t(confirmWarningKey)}
          </div>
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              className={BTN_SECONDARY}
              onClick={onCancelConfirm}
              disabled={busy}
              data-testid={cancelTestId}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="rounded bg-danger px-3 py-1 text-sm font-medium text-white hover:bg-danger/90 disabled:opacity-50"
              onClick={onConfirm}
              disabled={confirmDisabled || !anySelected}
              data-testid={confirmTestId}
            >
              {t('sync.deleteSelected')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

interface DisconnectConfirmButtonProps {
  confirming: boolean
  onRequestConfirm: () => void
  onCancelConfirm: () => void
  onConfirm: () => void
  disconnectLabelKey: string
  confirmLabelKey: string
  disconnectTestId: string
  confirmTestId: string
  cancelTestId: string
  warningKey?: string
  warningTestId?: string
}

function DisconnectConfirmButton({
  confirming,
  onRequestConfirm,
  onCancelConfirm,
  onConfirm,
  disconnectLabelKey,
  confirmLabelKey,
  disconnectTestId,
  confirmTestId,
  cancelTestId,
  warningKey,
  warningTestId,
}: DisconnectConfirmButtonProps) {
  const { t } = useTranslation()

  if (confirming) {
    return (
      <div>
        <div className="flex items-center gap-2 justify-end">
          <button
            type="button"
            className={BTN_DANGER_OUTLINE}
            onClick={onConfirm}
            data-testid={confirmTestId}
          >
            {t(confirmLabelKey)}
          </button>
          <button
            type="button"
            className={BTN_SECONDARY}
            onClick={onCancelConfirm}
            data-testid={cancelTestId}
          >
            {t('common.cancel')}
          </button>
        </div>
        {warningKey && (
          <p className="mt-2 text-xs text-danger" data-testid={warningTestId}>
            {t(warningKey)}
          </p>
        )}
      </div>
    )
  }

  return (
    <button
      type="button"
      className={BTN_SECONDARY}
      onClick={onRequestConfirm}
      data-testid={disconnectTestId}
    >
      {t(disconnectLabelKey)}
    </button>
  )
}

interface ThemeOption {
  mode: ThemeMode
  icon: LucideIcon
}

const THEME_OPTIONS: ThemeOption[] = [
  { mode: 'system', icon: Monitor },
  { mode: 'light', icon: Sun },
  { mode: 'dark', icon: Moon },
]

const TIME_STEPS = [10, 20, 30, 40, 50, 60] as const

interface Props {
  sync: UseSyncReturn
  connectedKeyboardUid?: string
  theme: ThemeMode
  onThemeChange: (mode: ThemeMode) => void
  defaultLayout: KeyboardLayoutId
  onDefaultLayoutChange: (layout: KeyboardLayoutId) => void
  defaultAutoAdvance: boolean
  onDefaultAutoAdvanceChange: (enabled: boolean) => void
  defaultLayerPanelOpen: boolean
  onDefaultLayerPanelOpenChange: (open: boolean) => void
  defaultBasicViewType: 'list' | 'keyboard'
  onDefaultBasicViewTypeChange: (type: 'list' | 'keyboard') => void
  autoLockTime: AutoLockMinutes
  onAutoLockTimeChange: (m: AutoLockMinutes) => void
  onResetStart?: () => void
  onResetEnd?: () => void
  onClose: () => void
  hubEnabled: boolean
  onHubEnabledChange: (enabled: boolean) => void
  hubAuthenticated: boolean
  hubDisplayName: string | null
  onHubDisplayNameChange: (name: string) => Promise<{ success: boolean; error?: string }>
  hubAuthConflict?: boolean
  onResolveAuthConflict?: (name: string) => Promise<{ success: boolean; error?: string }>
  hubAccountDeactivated?: boolean
}

interface HubDisplayNameFieldProps {
  currentName: string | null
  onSave: (name: string) => Promise<{ success: boolean; error?: string }>
}

function HubDisplayNameField({ currentName, onSave }: HubDisplayNameFieldProps) {
  const { t } = useTranslation()
  const [value, setValue] = useState(currentName ?? '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const savedTimerRef = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    setValue(currentName ?? '')
  }, [currentName])

  useEffect(() => {
    return () => clearTimeout(savedTimerRef.current)
  }, [])

  const hasChanged = value !== (currentName ?? '')

  const handleSave = useCallback(async () => {
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const result = await onSave(value.trim())
      if (result.success) {
        setSaved(true)
        clearTimeout(savedTimerRef.current)
        savedTimerRef.current = setTimeout(() => setSaved(false), 2000)
      } else if (result.error === HUB_ERROR_DISPLAY_NAME_CONFLICT) {
        setError(t('hub.displayNameTaken'))
      } else if (result.error === HUB_ERROR_RATE_LIMITED) {
        setError(t('hub.rateLimited'))
      } else {
        setError(t('hub.displayNameSaveFailed'))
      }
    } catch {
      setError(t('hub.displayNameSaveFailed'))
    } finally {
      setSaving(false)
    }
  }, [value, onSave, t])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && hasChanged && value.trim()) {
      void handleSave()
    }
  }, [handleSave, hasChanged, value])

  return (
    <div>
      <h4 className="mb-1 text-sm font-medium text-content-secondary">
        {t('hub.displayName')}
      </h4>
      <p className="mb-2 text-xs text-content-muted">
        {t('hub.displayNameDescription')}
      </p>
      <div className="flex items-center gap-2">
        <input
          type="text"
          className="flex-1 rounded border border-edge bg-surface px-2.5 py-1.5 text-sm text-content focus:border-accent focus:outline-none"
          value={value}
          onChange={(e) => { setValue(e.target.value); setSaved(false); setError(null) }}
          onKeyDown={handleKeyDown}
          disabled={saving}
          maxLength={50}
          data-testid="hub-display-name-input"
        />
        <button
          type="button"
          className={BTN_PRIMARY}
          onClick={handleSave}
          disabled={saving || !hasChanged || !value.trim()}
          data-testid="hub-display-name-save"
        >
          {saving ? t('common.saving') : t('common.save')}
        </button>
      </div>
      {!currentName?.trim() && !saved && !error && (
        <p className="mt-1 text-xs text-warning" data-testid="hub-display-name-required">
          {t('hub.displayNameRequired')}
        </p>
      )}
      {saved && (
        <p className="mt-1 text-xs text-accent" data-testid="hub-display-name-saved">
          {t('hub.displayNameSaved')}
        </p>
      )}
      {error && (
        <p className="mt-1 text-xs text-danger" data-testid="hub-display-name-error">
          {error}
        </p>
      )}
    </div>
  )
}

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
  autoLockTime,
  onAutoLockTimeChange,
  onResetStart,
  onResetEnd,
  onClose,
  hubEnabled,
  onHubEnabledChange,
  hubAuthenticated,
  hubDisplayName,
  onHubDisplayNameChange,
  hubAuthConflict,
  onResolveAuthConflict,
  hubAccountDeactivated,
}: Props) {
  const { t } = useTranslation()
  const appConfig = useAppConfig()
  const [activeTab, setActiveTab] = useState<ModalTabId>('tools')
  const [password, setPassword] = useState('')
  const [passwordScore, setPasswordScore] = useState<number | null>(null)
  const [passwordFeedback, setPasswordFeedback] = useState<string[]>([])
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [changingPassword, setChangingPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [syncTargets, setSyncTargets] = useState<SyncResetTargets>({ keyboards: false, favorites: false })
  const [confirmingSyncReset, setConfirmingSyncReset] = useState(false)
  const [localTargets, setLocalTargets] = useState<LocalResetTargets>({ keyboards: false, favorites: false, appSettings: false })
  const [confirmingLocalReset, setConfirmingLocalReset] = useState(false)
  const [authenticating, setAuthenticating] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  const [confirmingGoogleDisconnect, setConfirmingGoogleDisconnect] = useState(false)
  const [confirmingHubDisconnect, setConfirmingHubDisconnect] = useState(false)
  const [importResult, setImportResult] = useState<'success' | 'error' | null>(null)
  const [recentNotifications, setRecentNotifications] = useState<AppNotification[]>([])
  const [notificationLoading, setNotificationLoading] = useState(false)
  const notificationFetchedRef = useRef(false)

  useEffect(() => {
    if (activeTab !== 'notification' || notificationFetchedRef.current) return

    let cancelled = false
    setNotificationLoading(true)
    window.vialAPI.notificationFetch().then((result) => {
      if (cancelled) return
      if (result.success && result.notifications) {
        const sorted = [...result.notifications]
          .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
          .slice(0, 3)
        setRecentNotifications(sorted)
      }
    }).catch(() => {
      // Network errors are non-critical
    }).finally(() => {
      if (cancelled) return
      notificationFetchedRef.current = true
      setNotificationLoading(false)
    })
    return () => { cancelled = true }
  }, [activeTab])

  useEffect(() => { setConfirmingGoogleDisconnect(false) }, [sync.authStatus.authenticated])
  useEffect(() => { setConfirmingHubDisconnect(false) }, [hubEnabled])
  const authInFlight = useRef(false)
  const validationSeq = useRef(0)

  const handleSignIn = useCallback(async () => {
    if (authInFlight.current) return
    authInFlight.current = true
    setAuthenticating(true)
    setAuthError(null)
    try {
      await sync.startAuth()
    } catch (err) {
      const detail = err instanceof Error ? err.message : ''
      setAuthError(detail || t('sync.authFailed'))
    } finally {
      authInFlight.current = false
      setAuthenticating(false)
    }
  }, [sync, t])

  const handleGoogleDisconnect = useCallback(() => {
    void sync.signOut()
    onHubEnabledChange(false)
    setConfirmingGoogleDisconnect(false)
  }, [sync, onHubEnabledChange])

  const handleHubDisconnect = useCallback(() => {
    onHubEnabledChange(false)
    setConfirmingHubDisconnect(false)
  }, [onHubEnabledChange])

  const handlePasswordChange = useCallback(
    async (value: string) => {
      setPassword(value)
      setPasswordError(null)
      setPasswordScore(null)
      setPasswordFeedback([])
      if (value.length > 0) {
        const seq = ++validationSeq.current
        const result = await sync.validatePassword(value)
        if (seq !== validationSeq.current) return
        setPasswordScore(result.score)
        setPasswordFeedback(result.feedback)
      } else {
        validationSeq.current++
      }
    },
    [sync],
  )

  const clearPasswordForm = useCallback(() => {
    setPassword('')
    setPasswordScore(null)
    setPasswordFeedback([])
    setPasswordError(null)
    setChangingPassword(false)
  }, [])

  const handleSetPassword = useCallback(async () => {
    if (passwordScore === null || passwordScore < 4) {
      setPasswordError(t('sync.passwordTooWeak'))
      return
    }
    setBusy(true)
    try {
      const result = changingPassword
        ? await sync.changePassword(password)
        : await sync.setPassword(password)
      if (result.success) {
        clearPasswordForm()
      } else {
        const errorKey = result.error ?? t('sync.passwordSetFailed')
        setPasswordError(t(errorKey, errorKey))
      }
    } finally {
      setBusy(false)
    }
  }, [sync, password, passwordScore, changingPassword, clearPasswordForm, t])

  const handleSyncNow = useCallback(async () => {
    setBusy(true)
    try {
      await sync.syncNow('download', 'favorites')
      if (connectedKeyboardUid) {
        await sync.syncNow('download', { keyboard: connectedKeyboardUid })
      }
      await sync.syncNow('upload', 'favorites')
      if (connectedKeyboardUid) {
        await sync.syncNow('upload', { keyboard: connectedKeyboardUid })
      }
    } finally {
      setBusy(false)
    }
  }, [sync, connectedKeyboardUid])

  const handleAutoSyncToggle = useCallback(async () => {
    const newValue = !sync.config.autoSync
    sync.setConfig({ autoSync: newValue })
    if (newValue && sync.authStatus.authenticated && sync.hasPassword) {
      await handleSyncNow()
    }
  }, [sync, handleSyncNow])

  const handleResetSyncTargets = useCallback(async () => {
    setBusy(true)
    onResetStart?.()
    try {
      const result = await sync.resetSyncTargets(syncTargets)
      if (result.success) {
        setConfirmingSyncReset(false)
        setSyncTargets({ keyboards: false, favorites: false })
      }
    } finally {
      setBusy(false)
      onResetEnd?.()
    }
  }, [sync, syncTargets, onResetStart, onResetEnd])

  const handleResetLocalTargets = useCallback(async () => {
    setBusy(true)
    onResetStart?.()
    try {
      const result = await window.vialAPI.resetLocalTargets(localTargets)
      if (result.success) {
        setConfirmingLocalReset(false)
        setLocalTargets({ keyboards: false, favorites: false, appSettings: false })
      }
    } finally {
      setBusy(false)
      onResetEnd?.()
    }
  }, [localTargets, onResetStart, onResetEnd])

  const handleExport = useCallback(async () => {
    setBusy(true)
    try {
      await window.vialAPI.exportLocalData()
    } finally {
      setBusy(false)
    }
  }, [])

  const handleImport = useCallback(async () => {
    setBusy(true)
    try {
      const result = await window.vialAPI.importLocalData()
      setImportResult(result.success ? 'success' : 'error')
    } finally {
      setBusy(false)
    }
  }, [])

  const isSyncing = sync.syncStatus === 'syncing'
  const syncDisabled = busy || !sync.authStatus.authenticated || !sync.hasPassword || isSyncing || sync.syncUnavailable

  function renderPasswordSection(): React.ReactNode {
    if (sync.checkingRemotePassword) {
      return (
        <div className="flex items-center gap-2 rounded border border-accent/50 bg-accent/10 p-2 text-xs text-accent" data-testid="sync-checking-remote" role="status">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" aria-hidden="true" />
          {t('sync.checkingRemotePassword')}
        </div>
      )
    }

    if (sync.hasPassword && !changingPassword) {
      return (
        <div className="flex items-center justify-between">
          <span className="text-sm text-accent" data-testid="sync-password-set">
            {t('sync.passwordSet')}
          </span>
          <button
            type="button"
            className={BTN_SECONDARY}
            onClick={() => setChangingPassword(true)}
            disabled={busy || !sync.authStatus.authenticated || sync.syncUnavailable}
            data-testid="sync-password-change-btn"
          >
            {t('sync.changePassword')}
          </button>
        </div>
      )
    }

    return (
      <div className="space-y-2">
        {busy && (
          <div className="flex items-center gap-2 rounded border border-accent/50 bg-accent/10 p-2 text-xs text-accent" data-testid="sync-password-busy" role="status">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" aria-hidden="true" />
            {t(changingPassword ? 'sync.changingPassword' : 'sync.settingPassword')}
          </div>
        )}
        {!busy && changingPassword && (
          <div className="rounded border border-accent/50 bg-accent/10 p-2 text-xs text-accent" data-testid="sync-change-password-info">
            {t('sync.changePasswordInfo')}
          </div>
        )}
        {!busy && !changingPassword && sync.hasRemotePassword === true && (
          <div className="rounded border border-accent/50 bg-accent/10 p-2 text-xs text-accent" data-testid="sync-existing-password-hint">
            {t('sync.existingPasswordHint')}
          </div>
        )}
        <input
          type="password"
          className="w-full rounded border border-edge bg-surface px-3 py-2 text-sm text-content disabled:opacity-50"
          placeholder={t('sync.passwordPlaceholder')}
          value={password}
          onChange={(e) => handlePasswordChange(e.target.value)}
          disabled={busy || sync.syncUnavailable}
          data-testid="sync-password-input"
        />
        {passwordScore !== null && !busy && (
          <div className="space-y-1">
            <div className="flex gap-1">
              {[0, 1, 2, 3, 4].map((i) => (
                <div
                  key={i}
                  className={`h-1.5 flex-1 rounded ${i <= passwordScore ? scoreColor(passwordScore) : 'bg-surface-dim'}`}
                />
              ))}
            </div>
            {passwordFeedback.map((fb, i) => (
              <div key={i} className="text-xs text-content-muted">
                {fb}
              </div>
            ))}
          </div>
        )}
        {passwordError && (
          <div className="text-xs text-danger" data-testid="sync-password-error">{passwordError}</div>
        )}
        {!busy && (
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
              onClick={handleSetPassword}
              disabled={!password || (passwordScore !== null && passwordScore < 4) || sync.syncUnavailable}
              data-testid="sync-password-save"
            >
              {t('sync.setPassword')}
            </button>
            {changingPassword && (
              <button
                type="button"
                className="rounded border border-edge px-4 py-1.5 text-sm text-content-secondary hover:bg-surface-dim"
                onClick={clearPasswordForm}
                data-testid="sync-password-reset-cancel"
              >
                {t('common.cancel')}
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="settings-backdrop"
      onClick={busy ? undefined : onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-busy={busy}
        aria-labelledby="settings-title"
        className="w-[480px] max-w-[90vw] h-[min(840px,85vh)] flex flex-col rounded-2xl bg-surface-alt border border-edge shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        data-testid="settings-modal"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-0 shrink-0">
          <h2 id="settings-title" className="text-lg font-bold text-content">{t('settings.title')}</h2>
          {!busy && <ModalCloseButton testid="settings-close" onClick={onClose} />}
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
            <div className="pt-4 space-y-6">
              <section>
                <h4 className="mb-2 text-sm font-medium text-content-secondary">
                  {t('theme.label')}
                </h4>
                <div className="flex rounded-lg border border-edge bg-surface p-1 gap-0.5">
                  {THEME_OPTIONS.map(({ mode, icon: Icon }) => (
                    <button
                      key={mode}
                      type="button"
                      className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                        theme === mode
                          ? 'bg-accent/15 text-accent'
                          : 'text-content-secondary hover:text-content'
                      }`}
                      onClick={() => onThemeChange(mode)}
                      data-testid={`theme-option-${mode}`}
                    >
                      <Icon size={16} aria-hidden="true" />
                      {t(`theme.${mode}`)}
                    </button>
                  ))}
                </div>
              </section>

              <section>
                <div className={ROW_CLASS} data-testid="settings-language-row">
                  <label htmlFor="settings-language-selector" className="text-sm font-medium text-content-secondary">
                    {t('settings.language')}
                  </label>
                  <select
                    id="settings-language-selector"
                    value={appConfig.config.language ?? 'en'}
                    onChange={(e) => {
                      appConfig.set('language', e.target.value)
                      void i18n.changeLanguage(e.target.value)
                    }}
                    className="rounded border border-edge bg-surface px-2.5 py-1.5 text-[13px] text-content focus:border-accent focus:outline-none"
                    data-testid="settings-language-selector"
                  >
                    {SUPPORTED_LANGUAGES.map((lang) => (
                      <option key={lang.id} value={lang.id}>
                        {lang.name}
                      </option>
                    ))}
                  </select>
                </div>
              </section>

              <section>
                <h4 className="mb-1 text-sm font-medium text-content-secondary">
                  {t('settings.defaults')}
                </h4>
                <p className="mb-3 text-xs text-content-muted">
                  {t('settings.defaultsDescription')}
                </p>
                <div className="flex flex-col gap-3">
                  <div className={ROW_CLASS} data-testid="settings-default-layout-row">
                    <label htmlFor="settings-default-layout-selector" className="text-[13px] font-medium text-content">
                      {t('settings.defaultLayout')}
                    </label>
                    <select
                      id="settings-default-layout-selector"
                      value={defaultLayout}
                      onChange={(e) => onDefaultLayoutChange(e.target.value as KeyboardLayoutId)}
                      className="rounded border border-edge bg-surface px-2.5 py-1.5 text-[13px] text-content focus:border-accent focus:outline-none"
                      data-testid="settings-default-layout-selector"
                    >
                      {KEYBOARD_LAYOUTS.map((layoutDef) => (
                        <option key={layoutDef.id} value={layoutDef.id}>
                          {layoutDef.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className={ROW_CLASS} data-testid="settings-default-auto-advance-row">
                    <span className="text-[13px] font-medium text-content">
                      {t('settings.defaultAutoAdvance')}
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={defaultAutoAdvance}
                      aria-label={t('settings.defaultAutoAdvance')}
                      className={toggleTrackClass(defaultAutoAdvance)}
                      onClick={() => onDefaultAutoAdvanceChange(!defaultAutoAdvance)}
                      data-testid="settings-default-auto-advance-toggle"
                    >
                      <span className={toggleKnobClass(defaultAutoAdvance)} />
                    </button>
                  </div>

                  <div className={ROW_CLASS} data-testid="settings-default-layer-panel-open-row">
                    <span className="text-[13px] font-medium text-content">
                      {t('settings.defaultLayerPanelOpen')}
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={defaultLayerPanelOpen}
                      aria-label={t('settings.defaultLayerPanelOpen')}
                      className={toggleTrackClass(defaultLayerPanelOpen)}
                      onClick={() => onDefaultLayerPanelOpenChange(!defaultLayerPanelOpen)}
                      data-testid="settings-default-layer-panel-open-toggle"
                    >
                      <span className={toggleKnobClass(defaultLayerPanelOpen)} />
                    </button>
                  </div>

                  <div className={ROW_CLASS} data-testid="settings-default-basic-view-type-row">
                    <label htmlFor="settings-default-basic-view-type-selector" className="text-[13px] font-medium text-content">
                      {t('settings.defaultBasicViewType')}
                    </label>
                    <select
                      id="settings-default-basic-view-type-selector"
                      value={defaultBasicViewType}
                      onChange={(e) => onDefaultBasicViewTypeChange(e.target.value as 'list' | 'keyboard')}
                      className="rounded border border-edge bg-surface px-2.5 py-1.5 text-[13px] text-content focus:border-accent focus:outline-none"
                      data-testid="settings-default-basic-view-type-selector"
                    >
                      <option value="ansi">{t('settings.basicViewTypeAnsi')}</option>
                      <option value="iso">{t('settings.basicViewTypeIso')}</option>
                      <option value="list">{t('settings.basicViewTypeList')}</option>
                    </select>
                  </div>
                </div>
              </section>

              <section>
                <h4 className="mb-1 text-sm font-medium text-content-secondary">
                  {t('settings.security')}
                </h4>
                <div className="flex flex-col gap-3">
                  <div className={ROW_CLASS} data-testid="settings-auto-lock-time-row">
                    <div className="flex flex-col gap-0.5">
                      <label htmlFor="settings-auto-lock-time-selector" className="text-[13px] font-medium text-content">
                        {t('settings.autoLockTime')}
                      </label>
                      <span className="text-xs text-content-muted">
                        {t('settings.autoLockDescription')}
                      </span>
                    </div>
                    <select
                      id="settings-auto-lock-time-selector"
                      value={autoLockTime}
                      onChange={(e) => onAutoLockTimeChange(Number(e.target.value) as AutoLockMinutes)}
                      className="rounded border border-edge bg-surface px-2.5 py-1.5 text-[13px] text-content focus:border-accent focus:outline-none"
                      data-testid="settings-auto-lock-time-selector"
                    >
                      {TIME_STEPS.map((m) => (
                        <option key={m} value={m}>
                          {t('settings.autoLockMinutes', { minutes: m })}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </section>
            </div>
          )}
          {activeTab === 'data' && (
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
                {renderPasswordSection()}
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
              <SyncStatusSection syncStatus={sync.syncStatus} progress={sync.progress} lastSyncResult={sync.lastSyncResult} />

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

              <hr className="my-4 border-edge" />

              {/* Troubleshooting (collapsible) */}
              <details className="mb-4" data-testid="troubleshooting-details">
                <summary className="cursor-pointer text-[15px] font-bold text-content select-none">
                  {t('sync.troubleshooting')}
                </summary>
                <div className="mt-4 space-y-6">
                  {/* Undecryptable Files */}
                  <UndecryptableFilesSection sync={sync} disabled={syncDisabled} />

                  {/* Reset Sync Data */}
                  <section>
                    <h4 className="mb-2 text-sm font-medium text-content-secondary">
                      {t('sync.resetSyncData')}
                    </h4>
                    <DangerCheckboxGroup
                      items={[
                        { key: 'keyboards', checked: syncTargets.keyboards, labelKey: 'sync.resetTarget.keyboards', testId: 'sync-target-keyboards' },
                        { key: 'favorites', checked: syncTargets.favorites, labelKey: 'sync.resetTarget.favorites', testId: 'sync-target-favorites' },
                      ]}
                      onToggle={(key, checked) => setSyncTargets((prev) => ({ ...prev, [key]: checked }))}
                      disabled={busy || syncDisabled}
                      confirming={confirmingSyncReset}
                      onRequestConfirm={() => setConfirmingSyncReset(true)}
                      onCancelConfirm={() => setConfirmingSyncReset(false)}
                      onConfirm={handleResetSyncTargets}
                      confirmWarningKey="sync.resetTargetsConfirm"
                      deleteTestId="sync-reset-data"
                      warningTestId="sync-reset-data-warning"
                      cancelTestId="sync-reset-data-cancel"
                      confirmTestId="sync-reset-data-confirm"
                      busy={busy}
                      confirmDisabled={busy || syncDisabled}
                    />
                  </section>

                  {/* Local Data */}
                  <section>
                    <h4 className="mb-2 text-sm font-medium text-content-secondary">
                      {t('sync.localData')}
                    </h4>
                    <div className="flex items-center justify-between mb-3">
                      {importResult ? (
                        <span
                          className={`text-sm ${importResult === 'success' ? 'text-accent' : 'text-danger'}`}
                          data-testid="local-data-import-result"
                        >
                          {importResult === 'success' ? t('sync.importComplete') : t('sync.importFailed')}
                        </span>
                      ) : (
                        <span />
                      )}
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          className={BTN_SECONDARY}
                          onClick={handleImport}
                          disabled={busy}
                          data-testid="local-data-import"
                        >
                          {t('sync.import')}
                        </button>
                        <button
                          type="button"
                          className={BTN_SECONDARY}
                          onClick={handleExport}
                          disabled={busy}
                          data-testid="local-data-export"
                        >
                          {t('sync.export')}
                        </button>
                      </div>
                    </div>
                    <DangerCheckboxGroup
                      items={[
                        { key: 'keyboards', checked: localTargets.keyboards, labelKey: 'sync.resetTarget.keyboards', testId: 'local-target-keyboards' },
                        { key: 'favorites', checked: localTargets.favorites, labelKey: 'sync.resetTarget.favorites', testId: 'local-target-favorites' },
                        { key: 'appSettings', checked: localTargets.appSettings, labelKey: 'sync.resetTarget.appSettings', testId: 'local-target-appSettings' },
                      ]}
                      onToggle={(key, checked) => setLocalTargets((prev) => ({ ...prev, [key]: checked }))}
                      disabled={busy || isSyncing}
                      confirming={confirmingLocalReset}
                      onRequestConfirm={() => setConfirmingLocalReset(true)}
                      onCancelConfirm={() => setConfirmingLocalReset(false)}
                      onConfirm={handleResetLocalTargets}
                      confirmWarningKey="sync.resetLocalTargetsConfirm"
                      deleteTestId="reset-local-data"
                      warningTestId="reset-local-data-warning"
                      cancelTestId="reset-local-data-cancel"
                      confirmTestId="reset-local-data-confirm"
                      busy={busy}
                      confirmDisabled={busy || isSyncing}
                    />
                  </section>
                </div>
              </details>
            </div>
          )}
          {activeTab === 'notification' && (
            <div className="pt-4" aria-live="polite" data-testid="notification-tab-content">
              {notificationLoading ? (
                <p className="text-sm text-content-muted">{t('common.loading')}</p>
              ) : recentNotifications.length === 0 ? (
                <p className="text-sm text-content-muted" data-testid="notification-empty">
                  {t('notification.empty')}
                </p>
              ) : (
                <ul className="space-y-4">
                  {recentNotifications.map((notification, index) => (
                    <li key={`${notification.publishedAt}-${index}`} className="rounded-md border border-edge p-4">
                      <div className="mb-2 flex items-center gap-2">
                        <span className="text-sm font-medium text-content">{notification.title}</span>
                        <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs text-accent">
                          {t(`notification.type.${notification.type}`, { defaultValue: notification.type })}
                        </span>
                      </div>
                      <p className="whitespace-pre-line text-sm text-content-secondary">
                        {notification.body}
                      </p>
                      <time className="mt-2 block text-xs text-content-muted" dateTime={notification.publishedAt}>
                        {formatDateShort(notification.publishedAt)}
                      </time>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {activeTab === 'about' && <AboutTabContent />}
        </ModalTabPanel>
      </div>
    </div>
  )
}
