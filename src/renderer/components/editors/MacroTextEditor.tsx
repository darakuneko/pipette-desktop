// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { MacroAction } from '../../../preload/macro'
import { jsonToMacroActions } from '../../../preload/macro'

interface Props {
  initialJson: string
  onApply: (actions: MacroAction[]) => void
  onClose: () => void
}

export function MacroTextEditor({ initialJson, onApply, onClose }: Props) {
  const { t } = useTranslation()
  const [text, setText] = useState(initialJson)
  const [error, setError] = useState(() => jsonToMacroActions(initialJson) === null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const titleId = 'macro-text-editor-title'

  useEffect(() => {
    textareaRef.current?.select()
  }, [])

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

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    setText(value)
    setError(jsonToMacroActions(value) === null)
  }, [])

  const handleApply = useCallback(() => {
    const actions = jsonToMacroActions(text)
    if (actions !== null) {
      onApply(actions)
      onClose()
    }
  }, [text, onApply, onClose])

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onClose()
    },
    [onClose],
  )

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={handleBackdropClick}
      data-testid="macro-text-editor"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-[500px] rounded-lg border border-edge bg-surface p-4 shadow-xl"
      >
        <h3 id={titleId} className="mb-3 text-sm font-medium">{t('editor.macro.textEditorTitle')}</h3>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleChange}
          rows={8}
          className="w-full rounded border border-edge bg-surface-dim p-2 font-mono text-sm"
          data-testid="macro-text-editor-textarea"
        />
        {error && (
          <p className="mt-1 text-xs text-danger" data-testid="macro-text-editor-error">
            {t('editor.macro.invalidJson')}
          </p>
        )}
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-edge px-3 py-1.5 text-sm hover:bg-surface-dim"
            data-testid="macro-text-editor-cancel"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={error}
            className="rounded bg-accent px-3 py-1.5 text-sm text-content-inverse hover:bg-accent-hover disabled:opacity-50"
            data-testid="macro-text-editor-apply"
          >
            {t('common.apply')}
          </button>
        </div>
      </div>
    </div>
  )
}
