// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ModalCloseButton } from './ModalCloseButton'

export interface JsonEditorModalProps<T> {
  title: string
  initialText: string
  parse: (text: string) => { error: string | null; value?: T }
  onApply: (value: T) => void | Promise<void>
  onClose: () => void
  testIdPrefix: string
  warning?: string
  exportFileName?: string
}

export function JsonEditorModal<T>({
  title,
  initialText,
  parse,
  onApply,
  onClose,
  testIdPrefix,
  warning,
  exportFileName,
}: JsonEditorModalProps<T>) {
  const { t } = useTranslation()
  const [text, setText] = useState(initialText)
  const [error, setError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [onClose])

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value
      setText(value)
      const result = parse(value)
      setError(result.error)
    },
    [parse],
  )

  const handleApply = useCallback(async () => {
    const result = parse(text)
    if (result.error) {
      setError(result.error)
      return
    }
    setApplying(true)
    setError(null)
    try {
      await onApply(result.value as T)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('common.save'))
    } finally {
      setApplying(false)
    }
  }, [text, parse, onApply, onClose, t])

  const handleExport = useCallback(async () => {
    const ts = new Date().toISOString().replace(/:/g, '').replace(/\.\d+Z$/, '').replace('T', '-')
    const filename = `pipette-fav-${exportFileName}-current-all-${ts}`
    await window.vialAPI.exportJson(text, filename)
  }, [text, exportFileName])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid={testIdPrefix}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-[600px] max-w-[90vw] max-h-[80vh] overflow-y-auto rounded-lg bg-surface-alt p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">{title}</h3>
          <ModalCloseButton testid={`${testIdPrefix}-close`} onClick={onClose} />
        </div>
        {warning && (
          <p className="mb-3 text-xs text-warning" data-testid={`${testIdPrefix}-warning`}>{warning}</p>
        )}
        <textarea
          value={text}
          onChange={handleChange}
          rows={20}
          className="w-full rounded border border-edge bg-surface-dim p-2 font-mono text-xs leading-relaxed"
          data-testid={`${testIdPrefix}-textarea`}
        />
        {error && (
          <p className="mt-1 text-xs text-danger" data-testid={`${testIdPrefix}-error`}>
            {error}
          </p>
        )}
        <div className="mt-4 flex items-center">
          {exportFileName && (
            <button
              type="button"
              onClick={handleExport}
              className="rounded border border-edge px-4 py-2 text-sm hover:bg-surface-dim"
              data-testid={`${testIdPrefix}-export`}
            >
              {t('layoutStore.export')}
            </button>
          )}
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-edge px-4 py-2 text-sm hover:bg-surface-dim"
              data-testid={`${testIdPrefix}-cancel`}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={handleApply}
              disabled={!!error || applying}
              className="rounded bg-accent px-4 py-2 text-sm text-content-inverse hover:bg-accent-hover disabled:opacity-50"
              data-testid={`${testIdPrefix}-apply`}
            >
              {t('common.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
