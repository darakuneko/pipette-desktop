// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { BTN_PRIMARY } from './settings-modal-shared'
import { HUB_ERROR_DISPLAY_NAME_CONFLICT, HUB_ERROR_RATE_LIMITED } from '../../../shared/types/hub'

export interface HubDisplayNameFieldProps {
  currentName: string | null
  onSave: (name: string) => Promise<{ success: boolean; error?: string }>
}

export function HubDisplayNameField({ currentName, onSave }: HubDisplayNameFieldProps) {
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
