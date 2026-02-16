// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { serialize, isLMKeycode, resolve } from '../../../shared/keycodes/keycodes'

interface Props {
  currentKeycode: number
  maskOnly?: boolean
  onRawKeycodeSelect: (code: number) => void
}

function parseHexDigits(input: string, maxDigits: number): number | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  if (trimmed.length > maxDigits) return null
  if (!/^[0-9a-fA-F]+$/.test(trimmed)) return null
  return parseInt(trimmed, 16)
}

function hasNamedKeycode(code: number): boolean {
  return !serialize(code).startsWith('0x')
}

function extractDisplayCode(code: number, lmMode: boolean, maskOnly: boolean): number {
  if (lmMode) return code & resolve('QMK_LM_MASK')
  if (maskOnly) return code & 0x00ff
  return code
}

function mergeInnerCode(currentCode: number, inner: number, lmMode: boolean, maskOnly: boolean): number {
  if (lmMode) {
    const lmMask = resolve('QMK_LM_MASK')
    return (currentCode & ~lmMask) | (inner & lmMask)
  }
  if (maskOnly) return (currentCode & 0xff00) | (inner & 0x00ff)
  return inner
}

export function PopoverTabCode({ currentKeycode, maskOnly, onRawKeycodeSelect }: Props) {
  const { t } = useTranslation()
  const [hexInput, setHexInput] = useState('')
  const lmMode = maskOnly && isLMKeycode(currentKeycode)
  const maxDigits = maskOnly ? 2 : 4

  useEffect(() => {
    const displayCode = extractDisplayCode(currentKeycode, !!lmMode, !!maskOnly)
    setHexInput(displayCode.toString(16).padStart(maxDigits, '0').toUpperCase())
  }, [currentKeycode, maskOnly, lmMode, maxDigits])

  const parsed = parseHexDigits(hexInput, maxDigits)
  const fullCode = parsed !== null
    ? mergeInnerCode(currentKeycode, parsed, !!lmMode, !!maskOnly)
    : null
  const qmkLabel = fullCode !== null ? serialize(fullCode) : null
  const canApply = fullCode !== null && fullCode !== currentKeycode && hasNamedKeycode(fullCode)

  const handleApply = useCallback(() => {
    if (canApply && fullCode !== null) {
      onRawKeycodeSelect(fullCode)
    }
  }, [canApply, fullCode, onRawKeycodeSelect])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && canApply) {
      handleApply()
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="mb-1 text-xs text-content-secondary">
          {t('editor.keymap.keyPopover.hexLabel')}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-sm font-mono text-content-muted">0x</span>
          <input
            type="text"
            value={hexInput}
            onChange={(e) => setHexInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={maskOnly ? '00' : '0000'}
            maxLength={maxDigits}
            className="w-full rounded border border-edge bg-surface px-2.5 py-1.5 text-sm font-mono uppercase focus:border-accent focus:outline-none"
            data-testid="popover-hex-input"
          />
        </div>
      </div>

      {qmkLabel !== null && (
        <div className="text-xs text-content-secondary">
          {t('editor.keymap.keyPopover.qmkLabel', { value: qmkLabel })}
        </div>
      )}

      <button
        type="button"
        className="self-end rounded bg-accent px-3 py-1.5 text-sm text-content-inverse hover:bg-accent-hover disabled:opacity-50"
        disabled={!canApply}
        onClick={handleApply}
        data-testid="popover-code-apply"
      >
        {t('common.apply')}
      </button>
    </div>
  )
}
