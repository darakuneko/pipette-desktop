// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { UseSyncReturn } from '../../hooks/useSync'
import type { AppNotification } from '../../../shared/types/notification'
import type { ModalTabId } from '../editors/modal-tabs'
import { syncCredentialI18nKey } from '../../../shared/types/sync'

export interface UseSettingsSyncOptions {
  sync: UseSyncReturn
  connectedKeyboardUid?: string
  hubEnabled: boolean
  onHubEnabledChange: (enabled: boolean) => void
  activeTab: ModalTabId
}

export function useSettingsSync({
  sync,
  connectedKeyboardUid,
  hubEnabled,
  onHubEnabledChange,
  activeTab,
}: UseSettingsSyncOptions) {
  const { t } = useTranslation()

  const [password, setPassword] = useState('')
  const [passwordScore, setPasswordScore] = useState<number | null>(null)
  const [passwordFeedback, setPasswordFeedback] = useState<string[]>([])
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [changingPassword, setChangingPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [authenticating, setAuthenticating] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  const [confirmingGoogleDisconnect, setConfirmingGoogleDisconnect] = useState(false)
  const [confirmingHubDisconnect, setConfirmingHubDisconnect] = useState(false)
  const [recentNotifications, setRecentNotifications] = useState<AppNotification[]>([])
  const [notificationLoading, setNotificationLoading] = useState(false)
  const notificationFetchedRef = useRef(false)
  const authInFlight = useRef(false)
  const validationSeq = useRef(0)

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
        const errorKey = result.reason
          ? syncCredentialI18nKey('changePasswordError', result.reason)
          : (result.error ?? 'sync.passwordSetFailed')
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

  const syncDisabled = busy || !sync.authStatus.authenticated || !sync.hasPassword || sync.syncStatus === 'syncing' || sync.syncUnavailable

  return {
    password,
    passwordScore,
    passwordFeedback,
    passwordError,
    changingPassword,
    setChangingPassword,
    busy,
    authenticating,
    authError,
    confirmingGoogleDisconnect,
    setConfirmingGoogleDisconnect,
    confirmingHubDisconnect,
    setConfirmingHubDisconnect,
    syncDisabled,
    handleSignIn,
    handleGoogleDisconnect,
    handleHubDisconnect,
    handlePasswordChange,
    clearPasswordForm,
    handleSetPassword,
    handleSyncNow,
    handleAutoSyncToggle,
    recentNotifications,
    notificationLoading,
  }
}
