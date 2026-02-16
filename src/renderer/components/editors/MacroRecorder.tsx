// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { MacroAction } from '../../../preload/macro'
import { findByRecorderAlias } from '../../../shared/keycodes/keycodes'

interface Props {
  onRecordComplete: (actions: MacroAction[]) => void
}

const TAP_THRESHOLD_MS = 200

interface PendingKey {
  code: string
  downTime: number
}

export function MacroRecorder({ onRecordComplete }: Props) {
  const { t } = useTranslation()
  const [recording, setRecording] = useState(false)
  const actionsRef = useRef<MacroAction[]>([])
  const pendingRef = useRef<Map<string, PendingKey>>(new Map())

  const flushPending = useCallback((code: string) => {
    const pending = pendingRef.current.get(code)
    if (!pending) return
    pendingRef.current.delete(code)

    const elapsed = Date.now() - pending.downTime
    const alias = pending.code.toLowerCase()
    const keycode = findByRecorderAlias(alias)

    if (elapsed <= TAP_THRESHOLD_MS) {
      // Short press = tap
      if (keycode?.printable && keycode.printable.length === 1) {
        // Merge consecutive printable text characters
        const last = actionsRef.current[actionsRef.current.length - 1]
        if (last && last.type === 'text') {
          last.text += keycode.printable
          return
        }
        actionsRef.current.push({ type: 'text', text: keycode.printable })
      } else if (keycode) {
        actionsRef.current.push({ type: 'tap', keycode: keycode.qmkId })
      }
    } else {
      // Long press = down + up
      if (keycode) {
        actionsRef.current.push({ type: 'down', keycode: keycode.qmkId })
        actionsRef.current.push({ type: 'up', keycode: keycode.qmkId })
      }
    }
  }, [])

  useEffect(() => {
    if (!recording) return

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const code = e.key
      if (pendingRef.current.has(code)) return // already tracking
      pendingRef.current.set(code, { code, downTime: Date.now() })
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      flushPending(e.key)
    }

    document.addEventListener('keydown', handleKeyDown, true)
    document.addEventListener('keyup', handleKeyUp, true)

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true)
      document.removeEventListener('keyup', handleKeyUp, true)
    }
  }, [recording, flushPending])

  const handleToggle = useCallback(() => {
    if (recording) {
      // Flush any remaining pending keys
      for (const code of pendingRef.current.keys()) {
        flushPending(code)
      }
      setRecording(false)
      onRecordComplete(actionsRef.current)
      actionsRef.current = []
      pendingRef.current.clear()
    } else {
      actionsRef.current = []
      pendingRef.current.clear()
      setRecording(true)
    }
  }, [recording, flushPending, onRecordComplete])

  return (
    <button
      type="button"
      className={`rounded px-3 py-1.5 text-sm ${
        recording
          ? 'bg-danger text-content-inverse hover:bg-danger'
          : 'bg-surface-dim hover:bg-surface-raised'
      }`}
      onClick={handleToggle}
    >
      {recording ? t('editor.macro.stopRecording') : t('editor.macro.record')}
    </button>
  )
}
