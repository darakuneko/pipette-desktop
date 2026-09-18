// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { QmkSettingsTab, QmkSettingsField } from '../../../shared/types/protocol'
import { useConfirmAction } from '../../hooks/useConfirmAction'
import { ConfirmButton } from './ConfirmButton'
import settingsDefs from '../../../shared/qmk-settings-defs.json'
import { BTN_PRIMARY } from '../../constants/ui-tokens'

type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed'

// Flash duration for the 'saved' status — matches LayoutStoreContent's
// flashSaved().
const SAVED_FLASH_MS = 2000

function saveStatusClassName(status: SaveStatus): string {
  if (status === 'saving') return 'text-xs text-content-muted'
  if (status === 'saved') return 'text-xs font-medium text-success'
  if (status === 'failed') return 'text-xs font-medium text-danger'
  return 'text-xs'
}

interface Props {
  tabName: string
  supportedQsids: Set<number>
  qmkSettingsGet: (qsid: number) => Promise<number[]>
  qmkSettingsSet: (qsid: number, data: number[]) => Promise<void>
  qmkSettingsReset: () => Promise<void>
  onSettingsUpdate?: (qsid: number, data: number[]) => void
}

function deserializeValue(data: number[], width: number): number {
  let value = 0
  for (let i = 0; i < width && i < data.length; i++) {
    value |= data[i] << (8 * i)
  }
  return value
}

function serializeValue(value: number, width: number): number[] {
  const bytes: number[] = []
  for (let i = 0; i < width; i++) {
    bytes.push((value >> (8 * i)) & 0xff)
  }
  return bytes
}

export function QmkSettings({
  tabName,
  supportedQsids,
  qmkSettingsGet,
  qmkSettingsSet,
  qmkSettingsReset,
  onSettingsUpdate,
}: Props) {
  const { t } = useTranslation()
  const [values, setValues] = useState<Map<number, number>>(new Map())
  const [editedValues, setEditedValues] = useState<Map<number, number>>(new Map())
  const [loading, setLoading] = useState(true)
  const [status, setStatusState] = useState<SaveStatus>('idle')
  const [resetting, setResetting] = useState(false)
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const mountedRef = useRef(true)

  useEffect(() => {
    return () => {
      mountedRef.current = false
      clearTimeout(savedTimerRef.current)
    }
  }, [])

  // Single entry point for status transitions — always clears any pending
  // saved-flash timer first so an old timer cannot clobber a newer
  // 'saving'/'failed' state back to 'idle'.
  const setStatus = useCallback((next: SaveStatus) => {
    clearTimeout(savedTimerRef.current)
    setStatusState(next)
    if (next === 'saved') {
      savedTimerRef.current = setTimeout(() => {
        if (mountedRef.current) setStatusState('idle')
      }, SAVED_FLASH_MS)
    }
  }, [])

  const tabs = (settingsDefs as { tabs: QmkSettingsTab[] }).tabs

  // Collect all unique QSIDs from settings definition
  const allQsids = useMemo(() => {
    const ids = new Set<number>()
    for (const tab of tabs) {
      for (const field of tab.fields) ids.add(field.qsid)
    }
    return ids
  }, [tabs])

  // Load values for supported QSIDs
  useEffect(() => {
    const load = async () => {
      setLoading(true)
      try {
        const vals = new Map<number, number>()
        for (const qsid of allQsids) {
          if (supportedQsids.has(qsid)) {
            const data = await qmkSettingsGet(qsid)
            const field = findFieldByQsid(tabs, qsid)
            const width = field?.width ?? 1
            vals.set(qsid, deserializeValue(data, width))
            onSettingsUpdate?.(qsid, data)
          }
        }
        setValues(vals)
        setEditedValues(new Map(vals))
      } catch {
        // device may not support QMK settings
      }
      setLoading(false)
    }
    load()
  }, [supportedQsids, qmkSettingsGet, allQsids, tabs, onSettingsUpdate])

  // Filter tabs to only show those with supported fields
  const visibleTabs = useMemo(() => {
    return tabs.filter((tab) => tab.fields.some((f) => supportedQsids.has(f.qsid)))
  }, [tabs, supportedQsids])

  const hasChanges = useMemo(() => {
    for (const [qsid, val] of editedValues) {
      if (values.get(qsid) !== val) return true
    }
    return false
  }, [values, editedValues])

  const handleBooleanChange = useCallback(
    (field: QmkSettingsField, checked: boolean) => {
      if (status === 'failed') setStatus('idle')
      setEditedValues((prev) => {
        const next = new Map(prev)
        const current = next.get(field.qsid) ?? 0
        const bit = field.bit ?? 0
        const newValue = checked
          ? current | (1 << bit)
          : current & ~(1 << bit)
        next.set(field.qsid, newValue)
        return next
      })
    },
    [status, setStatus],
  )

  const handleIntegerChange = useCallback(
    (field: QmkSettingsField, value: number) => {
      if (status === 'failed') setStatus('idle')
      const min = field.min ?? 0
      const max = field.max ?? Infinity
      const clamped = Math.max(min, Math.min(max, value))
      setEditedValues((prev) => {
        const next = new Map(prev)
        next.set(field.qsid, clamped)
        return next
      })
    },
    [status, setStatus],
  )

  const handleSave = useCallback(async () => {
    setStatus('saving')
    const written = new Map(values)
    let failed = false
    try {
      for (const [qsid, val] of editedValues) {
        if (values.get(qsid) === val) continue
        const field = findFieldByQsid(tabs, qsid)
        const width = field?.width ?? 1
        const data = serializeValue(val, width)
        try {
          await qmkSettingsSet(qsid, data)
        } catch (err) {
          failed = true
          console.error(`[QmkSettings] save failed for qsid ${qsid}:`, err)
          break
        }
        onSettingsUpdate?.(qsid, data)
        written.set(qsid, val)
      }
    } finally {
      if (mountedRef.current) {
        setValues(written)
        setStatus(failed ? 'failed' : 'saved')
      }
    }
  }, [editedValues, values, tabs, qmkSettingsSet, onSettingsUpdate, setStatus])

  const handleUndo = useCallback(() => {
    if (status === 'failed') setStatus('idle')
    setEditedValues(new Map(values))
  }, [status, setStatus, values])

  const handleReset = useCallback(async () => {
    if (status === 'failed') setStatus('idle')
    setResetting(true)
    try {
      await qmkSettingsReset()
      // Reload values after reset
      const vals = new Map<number, number>()
      for (const qsid of allQsids) {
        if (supportedQsids.has(qsid)) {
          const data = await qmkSettingsGet(qsid)
          const field = findFieldByQsid(tabs, qsid)
          const width = field?.width ?? 1
          vals.set(qsid, deserializeValue(data, width))
          onSettingsUpdate?.(qsid, data)
        }
      }
      if (mountedRef.current) {
        setValues(vals)
        setEditedValues(new Map(vals))
      }
    } finally {
      if (mountedRef.current) setResetting(false)
    }
  }, [status, setStatus, qmkSettingsReset, qmkSettingsGet, allQsids, supportedQsids, tabs, onSettingsUpdate])

  const resetAction = useConfirmAction(handleReset)
  const revertAction = useConfirmAction(handleUndo)

  if (loading) {
    return <div className="p-4 text-content-muted">{t('common.loading')}</div>
  }

  const currentTab = visibleTabs.find((tab) => tab.name === tabName)

  if (!currentTab) {
    return null
  }

  return (
    <div className="flex flex-col gap-3" data-testid="editor-qmk-settings">
      <div className="space-y-3">
        {currentTab.fields
          .filter((f) => supportedQsids.has(f.qsid))
          .map((field, i) => (
            <div key={`${field.qsid}-${field.bit ?? i}`} className="flex items-start gap-3">
              <label className="flex-1 min-w-0 pt-1 text-sm">{field.title}</label>
              {field.type === 'boolean' ? (
                <input
                  type="checkbox"
                  checked={
                    (((editedValues.get(field.qsid) ?? 0) >> (field.bit ?? 0)) & 1) !== 0
                  }
                  onChange={(e) => handleBooleanChange(field, e.target.checked)}
                  className="h-4 w-4"
                />
              ) : (
                <input
                  type="number"
                  min={field.min ?? 0}
                  max={field.max}
                  value={editedValues.get(field.qsid) ?? 0}
                  onChange={(e) =>
                    handleIntegerChange(field, parseInt(e.target.value, 10) || 0)
                  }
                  className="w-28 rounded border border-edge px-2 py-1 text-sm focus:border-accent focus:outline-none"
                />
              )}
            </div>
          ))}
      </div>

      <div className="flex items-center justify-between pt-2">
        <span className={saveStatusClassName(status)} data-testid="qmk-save-status">
          {status === 'saving' && t('common.saving')}
          {status === 'saved' && t('common.saved')}
          {status === 'failed' && t('editor.keymap.qmkSettingsSaveFailed')}
        </span>
        <div className="flex gap-2">
          <ConfirmButton
            testId="qmk-reset"
            confirming={resetAction.confirming}
            onClick={() => { revertAction.reset(); resetAction.trigger() }}
            labelKey="common.reset"
            confirmLabelKey="common.confirmReset"
            disabled={status === 'saving' || resetting}
          />
          <ConfirmButton
            testId="qmk-revert"
            confirming={revertAction.confirming}
            onClick={() => { resetAction.reset(); revertAction.trigger() }}
            labelKey="common.revert"
            confirmLabelKey="common.confirmRevert"
            disabled={status === 'saving' || resetting}
          />
          <button
            type="button"
            data-testid="qmk-save"
            className={BTN_PRIMARY}
            onClick={handleSave}
            disabled={status === 'saving' || resetting || !hasChanges}
          >
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

function findFieldByQsid(
  tabs: QmkSettingsTab[],
  qsid: number,
): QmkSettingsField | undefined {
  for (const tab of tabs) {
    for (const field of tab.fields) {
      if (field.qsid === qsid) return field
    }
  }
  return undefined
}
