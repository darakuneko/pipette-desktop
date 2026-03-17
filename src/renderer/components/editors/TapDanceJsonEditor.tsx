// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { TapDanceEntry } from '../../../shared/types/protocol'
import { serialize, deserialize } from '../../../shared/keycodes/keycodes'
import { ModalCloseButton } from './ModalCloseButton'

type TapDanceArray = [string, string, string, string, number]

function entriesToJson(entries: TapDanceEntry[]): string {
  const arr: TapDanceArray[] = entries.map((e) => [
    serialize(e.onTap),
    serialize(e.onHold),
    serialize(e.onDoubleTap),
    serialize(e.onTapHold),
    e.tappingTerm,
  ])
  return JSON.stringify(arr, null, 2)
}

function isValidKeycode(kc: string): boolean {
  const code = deserialize(kc)
  return serialize(code) === kc || code !== 0 || kc === 'KC_NO'
}

interface ParseResult {
  entries: TapDanceEntry[]
  error: null
}
interface ParseError {
  entries: null
  error: string
}

function parseJson(json: string, expectedLength: number): ParseResult | ParseError {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { entries: null, error: 'invalidJson' }
  }
  if (!Array.isArray(parsed) || parsed.length !== expectedLength) return { entries: null, error: 'invalidJson' }
  const entries: TapDanceEntry[] = []
  for (let idx = 0; idx < parsed.length; idx++) {
    const item = parsed[idx]
    if (!Array.isArray(item) || item.length !== 5) return { entries: null, error: 'invalidJson' }
    const [onTap, onHold, onDoubleTap, onTapHold, tappingTerm] = item as [unknown, unknown, unknown, unknown, unknown]
    if (typeof tappingTerm !== 'number' || tappingTerm < 0 || tappingTerm > 10000) {
      return { entries: null, error: 'invalidTappingTerm' }
    }
    const keycodes = [onTap, onHold, onDoubleTap, onTapHold]
    for (const kc of keycodes) {
      if (typeof kc !== 'string') return { entries: null, error: 'invalidJson' }
      if (!isValidKeycode(kc)) return { entries: null, error: `unknownKeycode:${kc}` }
    }
    entries.push({
      onTap: deserialize(onTap as string),
      onHold: deserialize(onHold as string),
      onDoubleTap: deserialize(onDoubleTap as string),
      onTapHold: deserialize(onTapHold as string),
      tappingTerm: tappingTerm as number,
    })
  }
  return { entries, error: null }
}

interface Props {
  entries: TapDanceEntry[]
  onApply: (entries: TapDanceEntry[]) => void | Promise<void>
  onClose: () => void
}

export function TapDanceJsonEditor({ entries, onApply, onClose }: Props) {
  const { t } = useTranslation()
  const initialJson = useMemo(() => entriesToJson(entries), [entries])
  const [text, setText] = useState(initialJson)
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

  const formatError = useCallback((errorKey: string): string => {
    if (errorKey.startsWith('unknownKeycode:')) {
      return t('editor.tapDance.unknownKeycode', { keycode: errorKey.split(':')[1] })
    }
    return t(`editor.tapDance.${errorKey}`)
  }, [t])

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value
      setText(value)
      const result = parseJson(value, entries.length)
      setError(result.error ? formatError(result.error) : null)
    },
    [entries.length, formatError],
  )

  const handleApply = useCallback(async () => {
    const result = parseJson(text, entries.length)
    if (result.error) {
      setError(formatError(result.error))
      return
    }
    setApplying(true)
    setError(null)
    try {
      await onApply(result.entries)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('editor.tapDance.applyFailed'))
    } finally {
      setApplying(false)
    }
  }, [text, entries.length, onApply, onClose, t])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="tap-dance-json-editor"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-[600px] max-w-[90vw] max-h-[80vh] overflow-y-auto rounded-lg bg-surface-alt p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">{t('editor.tapDance.jsonEditorTitle')}</h3>
          <ModalCloseButton testid="tap-dance-json-editor-close" onClick={onClose} />
        </div>
        <textarea
          value={text}
          onChange={handleChange}
          rows={20}
          className="w-full rounded border border-edge bg-surface-dim p-2 font-mono text-xs leading-relaxed"
          data-testid="tap-dance-json-editor-textarea"
        />
        {error && (
          <p className="mt-1 text-xs text-danger" data-testid="tap-dance-json-editor-error">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-edge px-3 py-1.5 text-sm hover:bg-surface-dim"
            data-testid="tap-dance-json-editor-cancel"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={!!error || applying}
            className="rounded bg-accent px-3 py-1.5 text-sm text-content-inverse hover:bg-accent-hover disabled:opacity-50"
            data-testid="tap-dance-json-editor-apply"
          >
            {t('common.apply')}
          </button>
        </div>
      </div>
    </div>
  )
}
