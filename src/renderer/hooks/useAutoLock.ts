// SPDX-License-Identifier: GPL-2.0-or-later

import { useEffect, useRef } from 'react'

interface UseAutoLockOptions {
  unlocked: boolean
  autoLockMinutes: number
  activityCounter: number
  suspended?: boolean
  onLock: () => void
}

export function useAutoLock({ unlocked, autoLockMinutes, activityCounter, suspended, onLock }: UseAutoLockOptions): void {
  const onLockRef = useRef(onLock)
  onLockRef.current = onLock

  useEffect(() => {
    if (!unlocked || suspended) return

    const ms = autoLockMinutes * 60_000
    const timer = setTimeout(() => {
      onLockRef.current()
    }, ms)

    return () => clearTimeout(timer)
  }, [unlocked, autoLockMinutes, activityCounter, suspended])
}
