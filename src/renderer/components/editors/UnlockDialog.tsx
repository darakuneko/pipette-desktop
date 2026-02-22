// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { KleKey } from '../../../shared/kle/types'
import { KeyboardWidget } from '../keyboard'

const UNLOCK_POLL_INTERVAL = 200 // ms
const EMPTY_KEYCODES = new Map<string, string>()

interface Props {
  keys: KleKey[]
  unlockKeys: [number, number][]
  layoutOptions?: Map<number, number>
  unlockStart: () => Promise<void>
  unlockPoll: () => Promise<number[]>
  onComplete: () => void
  macroWarning?: boolean
}

export function UnlockDialog({
  keys,
  unlockKeys,
  layoutOptions,
  unlockStart,
  unlockPoll,
  onComplete,
  macroWarning,
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

  // Store callbacks in refs so the interval handler always sees the
  // latest versions without re-triggering the useEffect.
  const unlockPollRef = useRef(unlockPoll)
  unlockPollRef.current = unlockPoll
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete
  const busyRef = useRef(false)

  // Single useEffect: send unlockStart once, then poll via setInterval.
  // setInterval (like Python's QTimer) guarantees exactly one poll loop.
  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | undefined
    let cancelled = false

    const pollOnce = async () => {
      if (cancelled || busyRef.current) return
      busyRef.current = true
      try {
        const data = await unlockPollRef.current()
        if (cancelled) return
        if (data.length < 3) return

        const unlocked = data[0]
        const cnt = data[2]

        if (cnt > totalRef.current) totalRef.current = cnt
        setCounter(cnt)

        if (unlocked === 1) {
          if (intervalId) clearInterval(intervalId)
          onCompleteRef.current()
          return
        }
      } catch {
        // device error — next interval tick will retry
      } finally {
        busyRef.current = false
      }
    }

    const start = async () => {
      if (startedRef.current) {
        intervalId = setInterval(() => void pollOnce(), UNLOCK_POLL_INTERVAL)
        return
      }
      startedRef.current = true
      try {
        await unlockStart()
        if (cancelled) return
        intervalId = setInterval(() => void pollOnce(), UNLOCK_POLL_INTERVAL)
      } catch {
        // failed to start unlock
      }
    }

    start()

    return () => {
      cancelled = true
      if (intervalId) clearInterval(intervalId)
    }
  }, [unlockStart])

  // Derive progress from firmware counter
  const total = totalRef.current
  const progress = total > 0 ? total - counter : 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-[600px] max-w-[90vw] rounded-lg bg-surface-alt p-6 shadow-xl">
        <h2 className="mb-4 text-lg font-semibold">{t('unlock.title')}</h2>
        <p className="mb-4 text-sm text-content-secondary">{t('unlock.instructions')}</p>

        <div className="mb-4 flex justify-center overflow-auto">
          <KeyboardWidget
            keys={keys}
            keycodes={EMPTY_KEYCODES}
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

        {macroWarning && (
          <div
            className="mt-4 space-y-2 rounded border border-warning/50 bg-warning/10 p-3 text-xs text-warning"
            data-testid="macro-unlock-warning"
          >
            <p>{t('editor.macro.unlockClickAgain')}</p>
            <p>{t('editor.macro.unlockWarning')}</p>
          </div>
        )}
      </div>
    </div>
  )
}
