// SPDX-License-Identifier: GPL-2.0-or-later
// Naming dialog for a typing-test result (and History rows). An input with an
// "Unnamed" placeholder plus quick-insert chips (material label, timestamp,
// WPM / KPM / Accuracy) that drop their text at the caret.

import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useEscapeClose } from '../hooks/useEscapeClose'
import { ModalCloseButton } from '../components/editors/ModalCloseButton'
import { BTN_SECONDARY, BTN_PRIMARY } from '../constants/ui-tokens'

interface Props {
  /** Current name (empty → the "Unnamed" placeholder shows). */
  initialName: string
  /** Quick-insert chip texts, inserted verbatim at the caret. */
  chips: string[]
  onSave: (name: string) => void
  onClose: () => void
}

export function ResultNameModal({ initialName, chips, onSave, onClose }: Props) {
  const { t } = useTranslation()
  const backdropRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(initialName)

  useEscapeClose(onClose)

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === backdropRef.current) onClose()
  }, [onClose])

  const insertChip = useCallback((text: string) => {
    const el = inputRef.current
    const start = el?.selectionStart ?? value.length
    const end = el?.selectionEnd ?? value.length
    // At the very start, insert as-is; after existing text, join with "_"
    // (skip if the preceding char is already "_" to avoid doubling).
    const prefix = start > 0 && value[start - 1] !== '_' ? '_' : ''
    const insert = prefix + text
    setValue(value.slice(0, start) + insert + value.slice(end))
    // Restore focus and place the caret just after the inserted text.
    requestAnimationFrame(() => {
      if (!el) return
      el.focus()
      const pos = start + insert.length
      el.setSelectionRange(pos, pos)
    })
  }, [value])

  const save = useCallback(() => {
    onSave(value.trim())
    onClose()
  }, [onSave, onClose, value])

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="dialog"
      aria-labelledby="result-name-title"
      onClick={handleBackdropClick}
      data-testid="result-name-modal"
    >
      <div className="w-full max-w-md rounded-xl border border-edge bg-surface-alt shadow-lg">
        <div className="flex items-center justify-between border-b border-edge px-4 py-3">
          <h2 id="result-name-title" className="text-base font-semibold text-content">
            {t('editor.typingTest.nameModal.title')}
          </h2>
          <ModalCloseButton testid="result-name-modal-close" onClick={onClose} />
        </div>
        <div className="p-4">
          <input
            ref={inputRef}
            autoFocus
            value={value}
            placeholder={t('editor.typingTest.history.unnamed')}
            aria-label={t('editor.typingTest.nameResult')}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              // The input is focused, so useEscapeClose skips it (it ignores
              // typable elements); handle Enter / Escape here instead.
              if (e.key === 'Enter') save()
              else if (e.key === 'Escape') onClose()
            }}
            className="w-full rounded border border-edge bg-surface px-2 py-1.5 text-sm text-content focus:border-accent focus:outline-none"
            data-testid="result-name-modal-input"
          />
          {chips.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {chips.map((chip, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => insertChip(chip)}
                  className="rounded-md border border-edge bg-surface/20 px-2 py-1 text-xs text-content-secondary transition-colors hover:bg-surface-dim"
                  data-testid={`result-name-chip-${i}`}
                >
                  {chip}
                </button>
              ))}
            </div>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className={BTN_SECONDARY} onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button type="button" className={BTN_PRIMARY} onClick={save} data-testid="result-name-modal-save">
              {t('common.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
