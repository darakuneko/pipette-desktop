// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Monitor, Sun, Moon } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { ModalCloseButton } from './editors/ModalCloseButton'
import { ROW_CLASS, toggleTrackClass, toggleKnobClass } from './editors/modal-controls'
import { ACTION_BTN, DELETE_BTN, CONFIRM_DELETE_BTN, formatDate } from './editors/store-modal-shared'
import { ModalTabBar, ModalTabPanel } from './editors/modal-tabs'
import type { ModalTabId } from './editors/modal-tabs'
import type { SyncStatusType, LastSyncResult, SyncProgress, SyncResetTargets, LocalResetTargets } from '../../shared/types/sync'
import type { UseSyncReturn } from '../hooks/useSync'
import type { ThemeMode } from '../hooks/useTheme'
import type { KeyboardLayoutId, AutoLockMinutes, PanelSide } from '../hooks/useDevicePrefs'
import type { HubMyPost } from '../../shared/types/hub'
import { KEYBOARD_LAYOUTS } from '../data/keyboard-layouts'

const TABS = [
  { id: 'tools' as const, labelKey: 'settings.tabTools' },
  { id: 'data' as const, labelKey: 'settings.tabData' },
  { id: 'hub' as const, labelKey: 'settings.tabHub' },
]

function scoreColor(score: number | null): string {
  if (score === null) return 'bg-surface-dim'
  if (score < 2) return 'bg-danger'
  if (score < 4) return 'bg-warning'
  return 'bg-accent'
}

const SYNC_STATUS_CLASS: Record<Exclude<SyncStatusType, 'none'>, string> = {
  pending: 'text-pending',
  syncing: 'text-warning animate-pulse',
  synced: 'text-accent',
  error: 'text-danger',
}

const BTN_PRIMARY = 'rounded bg-accent px-3 py-1 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50'
const BTN_SECONDARY = 'rounded border border-edge px-3 py-1 text-sm text-content-secondary hover:bg-surface-dim disabled:opacity-50'

function formatTimestamp(timestamp: number): string {
  const d = new Date(timestamp)
  const date = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${date} ${d.getHours()}:${mm}:${ss}`
}

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
                {formatTimestamp(lastSyncResult.timestamp)}
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
              {lastSyncResult.message}
            </div>
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
          className="rounded border border-danger px-3 py-1 text-sm text-danger hover:bg-danger/10 disabled:opacity-50"
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

interface ThemeOption {
  mode: ThemeMode
  icon: LucideIcon
}

const THEME_OPTIONS: ThemeOption[] = [
  { mode: 'system', icon: Monitor },
  { mode: 'light', icon: Sun },
  { mode: 'dark', icon: Moon },
]

const PANEL_SIDE_OPTIONS: { side: PanelSide; labelKey: string }[] = [
  { side: 'left', labelKey: 'settings.panelLeft' },
  { side: 'right', labelKey: 'settings.panelRight' },
]

const TIME_STEPS = [10, 20, 30, 40, 50, 60] as const

interface HubPostRowProps {
  post: HubMyPost
  onRename: (postId: string, newTitle: string) => Promise<void>
  onDelete: (postId: string) => Promise<void>
}

function HubPostRow({ post, onRename, onDelete }: HubPostRowProps) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [editLabel, setEditLabel] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleStartEdit = useCallback(() => {
    setEditLabel(post.title)
    setEditing(true)
    setConfirmingDelete(false)
    setError(null)
  }, [post.title])

  const handleCancelEdit = useCallback(() => {
    setEditing(false)
  }, [])

  const handleSubmitRename = useCallback(async () => {
    if (!editLabel.trim()) return
    setBusy(true)
    setError(null)
    try {
      await onRename(post.id, editLabel.trim())
      setEditing(false)
    } catch {
      setError(t('hub.renameFailed'))
    } finally {
      setBusy(false)
    }
  }, [post.id, editLabel, onRename, t])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      void handleSubmitRename()
    } else if (e.key === 'Escape') {
      handleCancelEdit()
    }
  }, [handleSubmitRename, handleCancelEdit])

  const handleConfirmDelete = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await onDelete(post.id)
      setConfirmingDelete(false)
    } catch {
      setError(t('hub.deleteFailed'))
    } finally {
      setBusy(false)
    }
  }, [post.id, onDelete, t])

  const handleStartDelete = useCallback(() => {
    setConfirmingDelete(true)
    setEditing(false)
    setError(null)
  }, [])

  return (
    <div data-testid={`hub-post-${post.id}`}>
      <div className="flex items-center justify-between rounded-lg border border-edge bg-surface/20 px-3 py-2">
        {editing ? (
          <input
            type="text"
            className="flex-1 rounded border border-edge bg-surface px-2 py-1 text-sm text-content focus:border-accent focus:outline-none"
            value={editLabel}
            onChange={(e) => setEditLabel(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={busy}
            autoFocus
            data-testid={`hub-rename-input-${post.id}`}
          />
        ) : (
          <div className="flex flex-col min-w-0">
            <span className="text-sm text-content truncate">{post.title}</span>
            <span className="text-[11px] text-content-muted truncate">
              {post.keyboard_name} · {formatDate(post.created_at)}
            </span>
          </div>
        )}
        <div className="flex items-center gap-1 shrink-0 ml-2">
          {confirmingDelete && (
            <>
              <button
                type="button"
                className={CONFIRM_DELETE_BTN}
                onClick={handleConfirmDelete}
                disabled={busy}
                data-testid={`hub-confirm-delete-${post.id}`}
              >
                {t('layoutStore.confirmDelete')}
              </button>
              <button
                type="button"
                className={ACTION_BTN}
                onClick={() => setConfirmingDelete(false)}
                disabled={busy}
                data-testid={`hub-cancel-delete-${post.id}`}
              >
                {t('common.cancel')}
              </button>
            </>
          )}
          {!confirmingDelete && !editing && (
            <>
              <button
                type="button"
                className={ACTION_BTN}
                onClick={handleStartEdit}
                disabled={busy}
                data-testid={`hub-rename-${post.id}`}
              >
                {t('layoutStore.rename')}
              </button>
              <button
                type="button"
                className={DELETE_BTN}
                onClick={handleStartDelete}
                disabled={busy}
                data-testid={`hub-delete-${post.id}`}
              >
                {t('layoutStore.delete')}
              </button>
            </>
          )}
        </div>
      </div>
      {error && (
        <p className="mt-1 text-xs text-danger" data-testid={`hub-error-${post.id}`}>
          {error}
        </p>
      )}
    </div>
  )
}

interface Props {
  sync: UseSyncReturn
  theme: ThemeMode
  onThemeChange: (mode: ThemeMode) => void
  defaultLayout: KeyboardLayoutId
  onDefaultLayoutChange: (layout: KeyboardLayoutId) => void
  defaultAutoAdvance: boolean
  onDefaultAutoAdvanceChange: (enabled: boolean) => void
  autoLockTime: AutoLockMinutes
  onAutoLockTimeChange: (m: AutoLockMinutes) => void
  panelSide: PanelSide
  onPanelSideChange: (side: PanelSide) => void
  onResetStart?: () => void
  onResetEnd?: () => void
  onClose: () => void
  hubEnabled: boolean
  onHubEnabledChange: (enabled: boolean) => void
  hubPosts: HubMyPost[]
  hubAuthenticated: boolean
  onHubRefresh?: () => Promise<void>
  onHubRename: (postId: string, newTitle: string) => Promise<void>
  onHubDelete: (postId: string) => Promise<void>
  hubDisplayName: string | null
  onHubDisplayNameChange: (name: string | null) => Promise<boolean>
}

interface HubDisplayNameFieldProps {
  currentName: string | null
  onSave: (name: string | null) => Promise<boolean>
}

function HubDisplayNameField({ currentName, onSave }: HubDisplayNameFieldProps) {
  const { t } = useTranslation()
  const [value, setValue] = useState(currentName ?? '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setValue(currentName ?? '')
  }, [currentName])

  const hasChanged = value !== (currentName ?? '')

  const handleSave = useCallback(async () => {
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const ok = await onSave(value.trim() || null)
      if (ok) {
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
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
    if (e.key === 'Enter' && hasChanged) {
      void handleSave()
    }
  }, [handleSave, hasChanged])

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
          data-testid="hub-display-name-input"
        />
        <button
          type="button"
          className={BTN_PRIMARY}
          onClick={handleSave}
          disabled={saving || !hasChanged}
          data-testid="hub-display-name-save"
        >
          {saving ? t('common.saving') : t('common.save')}
        </button>
      </div>
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

function HubRefreshButton({ onRefresh }: { onRefresh: () => Promise<void> }) {
  const { t } = useTranslation()
  const [refreshing, setRefreshing] = useState(false)

  const handleClick = useCallback(async () => {
    setRefreshing(true)
    try {
      await onRefresh()
    } finally {
      setRefreshing(false)
    }
  }, [onRefresh])

  return (
    <button
      type="button"
      className="text-xs text-content-muted hover:text-content disabled:opacity-50"
      onClick={handleClick}
      disabled={refreshing}
      data-testid="hub-refresh-posts"
    >
      {refreshing ? t('common.refreshing') : t('common.refresh')}
    </button>
  )
}

export function SettingsModal({
  sync,
  theme,
  onThemeChange,
  defaultLayout,
  onDefaultLayoutChange,
  defaultAutoAdvance,
  onDefaultAutoAdvanceChange,
  autoLockTime,
  onAutoLockTimeChange,
  panelSide,
  onPanelSideChange,
  onResetStart,
  onResetEnd,
  onClose,
  hubEnabled,
  onHubEnabledChange,
  hubPosts,
  hubAuthenticated,
  onHubRefresh,
  onHubRename,
  onHubDelete,
  hubDisplayName,
  onHubDisplayNameChange,
}: Props) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<ModalTabId>('tools')
  const [password, setPassword] = useState('')
  const [passwordScore, setPasswordScore] = useState<number | null>(null)
  const [passwordFeedback, setPasswordFeedback] = useState<string[]>([])
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [resettingPassword, setResettingPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [syncTargets, setSyncTargets] = useState<SyncResetTargets>({ keyboards: false, favorites: false })
  const [confirmingSyncReset, setConfirmingSyncReset] = useState(false)
  const [localTargets, setLocalTargets] = useState<LocalResetTargets>({ keyboards: false, favorites: false, appSettings: false })
  const [confirmingLocalReset, setConfirmingLocalReset] = useState(false)
  const [authenticating, setAuthenticating] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  const [importResult, setImportResult] = useState<'success' | 'error' | null>(null)
  const authInFlight = useRef(false)
  const validationSeq = useRef(0)

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

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
    setResettingPassword(false)
  }, [])

  const handleSetPassword = useCallback(async () => {
    if (passwordScore === null || passwordScore < 4) {
      setPasswordError(t('sync.passwordTooWeak'))
      return
    }
    const result = resettingPassword
      ? await sync.resetPassword(password)
      : await sync.setPassword(password)
    if (result.success) {
      clearPasswordForm()
    } else {
      setPasswordError(result.error ?? t('sync.passwordSetFailed'))
    }
  }, [sync, password, passwordScore, resettingPassword, clearPasswordForm, t])

  const handleSyncNow = useCallback(async () => {
    setBusy(true)
    try {
      await sync.syncNow('download')
      await sync.syncNow('upload')
    } finally {
      setBusy(false)
    }
  }, [sync])

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
  const syncDisabled = busy || !sync.authStatus.authenticated || !sync.hasPassword || isSyncing

  function renderHubPostList(): React.ReactNode {
    if (!hubAuthenticated) {
      return (
        <p className="text-sm text-content-muted" data-testid="hub-requires-auth">
          {t('hub.requiresAuth')}
        </p>
      )
    }
    if (hubPosts.length === 0) {
      return (
        <p className="text-sm text-content-muted" data-testid="hub-no-posts">
          {t('hub.noPosts')}
        </p>
      )
    }
    return (
      <div className="space-y-1" data-testid="hub-post-list">
        {hubPosts.map((post) => (
          <HubPostRow
            key={post.id}
            post={post}
            onRename={onHubRename}
            onDelete={onHubDelete}
          />
        ))}
      </div>
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="settings-backdrop"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="w-[480px] max-w-[90vw] h-[min(760px,85vh)] flex flex-col rounded-2xl bg-surface-alt border border-edge shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        data-testid="settings-modal"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-0 shrink-0">
          <h2 id="settings-title" className="text-lg font-bold text-content">{t('settings.title')}</h2>
          <ModalCloseButton testid="settings-close" onClick={onClose} />
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
                <h4 className="mb-2 text-sm font-medium text-content-secondary">
                  {t('settings.panelSide')}
                </h4>
                <div className="flex rounded-lg border border-edge bg-surface p-1 gap-0.5">
                  {PANEL_SIDE_OPTIONS.map(({ side, labelKey }) => (
                    <button
                      key={side}
                      type="button"
                      className={`flex flex-1 items-center justify-center rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                        panelSide === side
                          ? 'bg-accent/15 text-accent'
                          : 'text-content-secondary hover:text-content'
                      }`}
                      onClick={() => onPanelSideChange(side)}
                      data-testid={`panel-side-option-${side}`}
                    >
                      {t(labelKey)}
                    </button>
                  ))}
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
              <section className="mb-6">
                <h4 className="mb-2 text-sm font-medium text-content-secondary">
                  {t('sync.googleAccount')}
                </h4>
                {sync.authStatus.authenticated ? (
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-accent" data-testid="sync-auth-status">
                      {t('sync.connected')}
                    </span>
                    <button
                      type="button"
                      className={BTN_SECONDARY}
                      onClick={sync.signOut}
                      data-testid="sync-sign-out"
                    >
                      {t('sync.signOut')}
                    </button>
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

              {/* Encryption Password */}
              <section className="mb-6">
                <h4 className="mb-2 text-sm font-medium text-content-secondary">
                  {t('sync.encryptionPassword')}
                </h4>
                {sync.hasPassword && !resettingPassword ? (
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-accent" data-testid="sync-password-set">
                      {t('sync.passwordSet')}
                    </span>
                    <button
                      type="button"
                      className={BTN_SECONDARY}
                      onClick={() => setResettingPassword(true)}
                      disabled={!sync.authStatus.authenticated}
                      data-testid="sync-password-reset-btn"
                    >
                      {t('sync.resetPassword')}
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {resettingPassword && (
                      <div className="rounded border border-warning/50 bg-warning/10 p-2 text-xs text-warning" data-testid="sync-reset-warning">
                        {t('sync.resetPasswordWarning')}
                      </div>
                    )}
                    <input
                      type="password"
                      className="w-full rounded border border-edge bg-surface px-3 py-2 text-sm text-content"
                      placeholder={t('sync.passwordPlaceholder')}
                      value={password}
                      onChange={(e) => handlePasswordChange(e.target.value)}
                      data-testid="sync-password-input"
                    />
                    {passwordScore !== null && (
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
                      <div className="text-xs text-danger">{passwordError}</div>
                    )}
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="rounded bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
                        onClick={handleSetPassword}
                        disabled={!password || (passwordScore !== null && passwordScore < 4)}
                        data-testid="sync-password-save"
                      >
                        {t('sync.setPassword')}
                      </button>
                      {resettingPassword && (
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
                  </div>
                )}
              </section>

              {/* Sync Controls */}
              <div className="mb-6 grid grid-cols-2 gap-3">
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

              {/* Reset Sync Data */}
              <section className="mb-6">
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
          )}
          {activeTab === 'hub' && (
            <div className="pt-4 space-y-6">
              {/* Hub Enable/Disable */}
              <section>
                <div className={ROW_CLASS} data-testid="hub-enable-row">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[13px] font-medium text-content">
                      {t('hub.enableToggle')}
                    </span>
                    <span className="text-xs text-content-muted">
                      {t('hub.enableDescription')}
                    </span>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={hubEnabled}
                    aria-label={t('hub.enableToggle')}
                    className={toggleTrackClass(hubEnabled)}
                    onClick={() => onHubEnabledChange(!hubEnabled)}
                    data-testid="hub-enable-toggle"
                  >
                    <span className={toggleKnobClass(hubEnabled)} />
                  </button>
                </div>
              </section>

              {/* Display Name */}
              {hubEnabled && hubAuthenticated && (
                <section>
                  <HubDisplayNameField
                    currentName={hubDisplayName}
                    onSave={onHubDisplayNameChange}
                  />
                </section>
              )}

              {/* My Posts */}
              <section>
                <div className="mb-2 flex items-center justify-between">
                  <h4 className="text-sm font-medium text-content-secondary">
                    {t('hub.myPosts')}
                  </h4>
                  {onHubRefresh && hubAuthenticated && (
                    <HubRefreshButton onRefresh={onHubRefresh} />
                  )}
                </div>
                {renderHubPostList()}
              </section>
            </div>
          )}
        </ModalTabPanel>
      </div>
    </div>
  )
}
