// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { QmkSettingsTab, QmkSettingsField } from '../../../shared/types/protocol'
import { useConfirmAction } from '../../hooks/useConfirmAction'
import { ConfirmButton } from './ConfirmButton'
import settingsDefs from '../../../shared/qmk-settings-defs.json'
import { BTN_PRIMARY } from '../../constants/ui-tokens'

type SaveStatus = 'idle' | 'saving' | 'resetting' | 'saved' | 'failed'

// Flash duration for the 'saved' status before it fades back to idle.
const SAVED_FLASH_MS = 2000

// Full non-size class for each status (saving has no font-medium; saved/
// failed do). Callers compose `text-xs ${...}` on top of this.
function saveStatusColorClass(status: SaveStatus): string {
  if (status === 'saving') return 'text-content-muted'
  if (status === 'saved') return 'font-medium text-success'
  if (status === 'failed') return 'font-medium text-danger'
  return ''
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
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Guards setState after unmount. Accepted trade-off: an in-flight save
  // keeps writing to the device after the modal closes, and a reopened
  // modal's load effect can read a qsid before that write lands — the old
  // instance's onSettingsUpdate then overwrites the new instance's parent
  // state. This is accepted because HID is serialized, so the packets
  // themselves cannot interleave; only the order of the two independent
  // instances' state updates can race.
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearTimeout(savedTimerRef.current)
    }
  }, [])

  // Entry point for status transitions that may own a timer — always
  // clears any pending saved-flash timer first so an old timer cannot
  // clobber a newer 'saving'/'failed' state back to 'idle'. clearFailure
  // below is the only other writer of `status`; it's safe outside this
  // function because 'failed' never owns a timer.
  const setStatus = useCallback((next: SaveStatus) => {
    clearTimeout(savedTimerRef.current)
    setStatusState(next)
    if (next === 'saved') {
      // The unmount cleanup above already clears this timer, so no
      // mountedRef guard is needed here.
      savedTimerRef.current = setTimeout(() => {
        setStatusState('idle')
      }, SAVED_FLASH_MS)
    }
  }, [])

  // 'failed' never owns a timer, so clearing it needs no clearTimeout —
  // just fall back to 'idle' when it's the current status.
  const clearFailure = useCallback(
    () => setStatusState((s) => (s === 'failed' ? 'idle' : s)),
    [],
  )

  const busy = status === 'saving' || status === 'resetting'

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
      clearFailure()
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
    [clearFailure],
  )

  const handleIntegerChange = useCallback(
    (field: QmkSettingsField, value: number) => {
      clearFailure()
      const min = field.min ?? 0
      const max = field.max ?? Infinity
      const clamped = Math.max(min, Math.min(max, value))
      setEditedValues((prev) => {
        const next = new Map(prev)
        next.set(field.qsid, clamped)
        return next
      })
    },
    [clearFailure],
  )

  const handleSave = useCallback(async () => {
    setStatus('saving')
    const written = new Map(values)
    let failed = false
    let wrote = false
    // Outer try/finally: status must leave 'saving' even if something past
    // the device write throws (onSettingsUpdate, or setValues below) —
    // otherwise Save/Reset/Revert would stay disabled until the modal is
    // closed.
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
        wrote = true
      }
    } catch (err) {
      // The device write for this qsid already succeeded (qmkSettingsSet's
      // own try/catch above only covers that call), so a throw here means
      // onSettingsUpdate itself failed. Surface it as a failed save rather
      // than a silent 'saved' — the caller's state may not reflect what
      // was actually written.
      failed = true
      console.error('[QmkSettings] save failed:', err)
    } finally {
      if (mountedRef.current) {
        if (wrote) {
          try {
            setValues(written)
          } catch (err) {
            console.error('[QmkSettings] failed to apply written values:', err)
          }
        }
        setStatus(failed ? 'failed' : 'saved')
      }
    }
  }, [editedValues, values, tabs, qmkSettingsSet, onSettingsUpdate, setStatus])

  const handleUndo = useCallback(() => {
    clearFailure()
    setEditedValues(new Map(values))
  }, [clearFailure, values])

  const handleReset = useCallback(async () => {
    setStatus('resetting')
    try {
      await qmkSettingsReset()
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
      if (mountedRef.current) setStatus('idle')
    }
  }, [setStatus, qmkSettingsReset, qmkSettingsGet, allQsids, supportedQsids, tabs, onSettingsUpdate])

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
        <span
          className={['text-xs', saveStatusColorClass(status)].filter(Boolean).join(' ')}
          aria-live="polite"
          data-testid="qmk-save-status"
        >
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
            disabled={busy}
          />
          <ConfirmButton
            testId="qmk-revert"
            confirming={revertAction.confirming}
            onClick={() => { resetAction.reset(); revertAction.trigger() }}
            labelKey="common.revert"
            confirmLabelKey="common.confirmRevert"
            disabled={busy}
          />
          <button
            type="button"
            data-testid="qmk-save"
            className={BTN_PRIMARY}
            onClick={handleSave}
            disabled={busy || !hasChanges}
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
