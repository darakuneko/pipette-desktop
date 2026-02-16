// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { QmkSettingsTab, QmkSettingsField } from '../../../shared/types/protocol'
import settingsDefs from '../../../shared/qmk-settings-defs.json'

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
    [],
  )

  const handleIntegerChange = useCallback(
    (field: QmkSettingsField, value: number) => {
      setEditedValues((prev) => {
        const next = new Map(prev)
        next.set(field.qsid, value)
        return next
      })
    },
    [],
  )

  const handleSave = useCallback(async () => {
    for (const [qsid, val] of editedValues) {
      if (values.get(qsid) !== val) {
        const field = findFieldByQsid(tabs, qsid)
        const width = field?.width ?? 1
        const data = serializeValue(val, width)
        await qmkSettingsSet(qsid, data)
        onSettingsUpdate?.(qsid, data)
      }
    }
    setValues(new Map(editedValues))
  }, [editedValues, values, tabs, qmkSettingsSet, onSettingsUpdate])

  const handleUndo = useCallback(() => {
    setEditedValues(new Map(values))
  }, [values])

  const handleReset = useCallback(async () => {
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
    setValues(vals)
    setEditedValues(new Map(vals))
  }, [qmkSettingsReset, qmkSettingsGet, allQsids, supportedQsids, tabs, onSettingsUpdate])

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
                  className="w-28 rounded border border-edge px-2 py-1 text-sm"
                />
              )}
            </div>
          ))}
      </div>

      <div className="flex gap-2 pt-2">
        <button
          type="button"
          data-testid="qmk-save"
          className="rounded bg-accent px-4 py-1.5 text-sm text-content-inverse hover:bg-accent-hover disabled:opacity-50"
          onClick={handleSave}
          disabled={!hasChanges}
        >
          {t('common.save')}
        </button>
        <button
          type="button"
          data-testid="qmk-undo"
          className="rounded border border-edge px-4 py-1.5 text-sm hover:bg-surface-dim disabled:opacity-50"
          onClick={handleUndo}
          disabled={!hasChanges}
        >
          {t('common.undo')}
        </button>
        <button
          type="button"
          data-testid="qmk-reset"
          className="rounded border border-danger/30 px-4 py-1.5 text-sm text-danger hover:bg-danger/10"
          onClick={handleReset}
        >
          {t('common.reset')}
        </button>
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
