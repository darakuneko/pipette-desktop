// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { KleKey } from '../../../shared/kle/types'
import { KeyboardWidget } from '../keyboard'

const UNLOCK_POLL_INTERVAL = 200 // ms

interface Props {
  keys: KleKey[]
  unlockKeys: [number, number][]
  layoutOptions?: Map<number, number>
  unlockStart: () => Promise<void>
  unlockPoll: () => Promise<number[]>
  onComplete: () => void
}

export function UnlockDialog({
  keys,
  unlockKeys,
  layoutOptions,
  unlockStart,
  unlockPoll,
  onComplete,
}: Props) {
  const { t } = useTranslation()
  const [counter, setCounter] = useState(0)
  const totalRef = useRef(0)
  const pollingRef = useRef(true)
  const timerRef = useRef<ReturnType<typeof setTimeout>>()
  const startedRef = useRef(false)

  // Highlight unlock keys in the keyboard widget
  const highlightedKeys = new Set<string>()
  for (const [row, col] of unlockKeys) {
    highlightedKeys.add(`${row},${col}`)
  }

  const poll = useCallback(async () => {
    if (!pollingRef.current) return
    try {
      const data = await unlockPoll()
      if (!pollingRef.current) return
      if (data.length < 3) return // unexpected data

      const unlocked = data[0]
      const cnt = data[2]

      // Capture the max counter as total on first meaningful value
      if (cnt > totalRef.current) totalRef.current = cnt
      setCounter(cnt)

      if (unlocked === 1) {
        pollingRef.current = false
        onComplete()
        return
      }
    } catch {
      // device error
    }

    if (pollingRef.current) {
      timerRef.current = setTimeout(poll, UNLOCK_POLL_INTERVAL)
    }
  }, [unlockPoll, onComplete])

  useEffect(() => {
    pollingRef.current = true
    const start = async () => {
      if (startedRef.current) return
      startedRef.current = true
      try {
        await unlockStart()
        poll()
      } catch {
        // failed to start
      }
    }
    start()
    return () => {
      pollingRef.current = false
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [unlockStart, poll])

  // Derive progress from firmware counter
  const total = totalRef.current
  const progress = total > 0 ? total - counter : 0

  const emptyKeycodes = new Map<string, string>()

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-[600px] max-w-[90vw] rounded-lg bg-surface-alt p-6 shadow-xl">
        <h2 className="mb-4 text-lg font-semibold">{t('unlock.title')}</h2>
        <p className="mb-4 text-sm text-content-secondary">{t('unlock.instructions')}</p>

        <div className="mb-4 flex justify-center overflow-auto">
          <KeyboardWidget
            keys={keys}
            keycodes={emptyKeycodes}
            highlightedKeys={highlightedKeys}
            layoutOptions={layoutOptions}
            readOnly
            scale={0.5}
          />
        </div>

        {/* Progress bar */}
        <div className="mb-2 flex items-center justify-between text-sm text-content-secondary">
          <span>{t('unlock.progress', { current: progress, total: total || '?' })}</span>
        </div>
        <div className="mb-4 h-2 overflow-hidden rounded bg-surface-dim">
          <div
            className="h-full bg-accent transition-all"
            style={{ width: total > 0 ? `${(progress / total) * 100}%` : '0%' }}
          />
        </div>

        <p className="text-xs text-content-muted">{t('unlock.hint')}</p>
      </div>
    </div>
  )
}
