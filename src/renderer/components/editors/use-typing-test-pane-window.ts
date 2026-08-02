// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useEffect, useRef } from 'react'
import { KEY_UNIT, KEYBOARD_PADDING } from '../keyboard/constants'
import { repositionLayoutKeys, filterVisibleKeys } from '../../../shared/kle/filter-keys'
import type { KleKey } from '../../../shared/kle/types'
import type { useTypingTest } from '../../typing-test/useTypingTest'

const MARGIN = 20

interface UseTypingTestPaneWindowParams {
  typingTest: ReturnType<typeof useTypingTest>
  viewOnly?: boolean
  keys: KleKey[]
  layoutOptions: Map<number, number>
  viewOnlyWindowSize?: { width: number; height: number }
  onViewOnlyWindowSizeChange?: (size: { width: number; height: number }) => void
  viewOnlyAlwaysOnTop?: boolean
  onViewOnlyChange?: (enabled: boolean) => void
}

/** View-only window sizing/scaling + always-on-top + controls-open state.
 *  Split out of TypingTestPane (file-splitting.md cap) — see
 *  Task-split-typing-test-pane.md. Behavior-preserving: effects and dep
 *  arrays are copied verbatim from the pre-split Pane. */
export function useTypingTestPaneWindow({
  typingTest,
  viewOnly,
  keys,
  layoutOptions,
  viewOnlyWindowSize,
  onViewOnlyWindowSizeChange,
  viewOnlyAlwaysOnTop,
  onViewOnlyChange,
}: UseTypingTestPaneWindowParams) {
  const [viewOnlyControlsOpen, setViewOnlyControlsOpen] = useState(false)
  const [mouseOver, setMouseOver] = useState(false)

  // Show hint text only when mouse is over the window
  useEffect(() => {
    if (!viewOnly) return
    const onEnter = (): void => setMouseOver(true)
    const onLeave = (): void => setMouseOver(false)
    document.documentElement.addEventListener('mouseenter', onEnter)
    document.documentElement.addEventListener('mouseleave', onLeave)
    return () => {
      document.documentElement.removeEventListener('mouseenter', onEnter)
      document.documentElement.removeEventListener('mouseleave', onLeave)
    }
  }, [viewOnly])
  // Always-on-top not supported on Wayland
  const [alwaysOnTopSupported, setAlwaysOnTopSupported] = useState(false)
  useEffect(() => {
    window.vialAPI.isAlwaysOnTopSupported().then(setAlwaysOnTopSupported).catch(() => {})
  }, [])
  // Assigned during render on purpose (NOT in an effect): the auto-fit effect
  // below reads this ref instead of taking the callback as a dep so it never
  // re-subscribes its resize listener, and an effect-based assignment would
  // leave the ref one commit stale for the first resize after a prop change.
  const onViewOnlyWindowSizeChangeRef = useRef(onViewOnlyWindowSizeChange)
  onViewOnlyWindowSizeChangeRef.current = onViewOnlyWindowSizeChange

  // Close controls on Escape key
  useEffect(() => {
    if (!viewOnly || !viewOnlyControlsOpen) return
    const handleEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setViewOnlyControlsOpen(false)
    }
    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('keydown', handleEsc)
    }
  }, [viewOnly, viewOnlyControlsOpen])

  const [cssScale, setCssScale] = useState(1)
  const paneWrapperRef = useRef<HTMLDivElement>(null)
  const paneNaturalSizeRef = useRef({ w: 0, h: 0 })

  // Calculate default compact window size: keyboard at 100% + pane padding + margins
  const getDefaultCompactSize = useCallback(() => {
    const visibleKeys = filterVisibleKeys(repositionLayoutKeys(keys, layoutOptions), layoutOptions)
    let maxRight = 0
    let maxBottom = 0
    for (const key of visibleKeys) {
      const right = key.x + key.width
      const bottom = key.y + key.height
      if (right > maxRight) maxRight = right
      if (bottom > maxBottom) maxBottom = bottom
    }
    // SVG size at scale=1 + pane padding (px-5=40, border=4, pt-3=12, pb-2=8, label~18) + margins
    const svgW = maxRight * KEY_UNIT + KEYBOARD_PADDING * 2
    const svgH = maxBottom * KEY_UNIT + KEYBOARD_PADDING * 2
    const paneW = svgW + 44
    const paneH = svgH + 42
    let w = paneW + MARGIN * 2
    let h = paneH + MARGIN * 2
    // Cap to 80% of screen if keyboard at 100% exceeds it
    const maxW = window.screen.availWidth * 0.8
    const maxH = window.screen.availHeight * 0.8
    const capScale = Math.min(1, maxW / w, maxH / h)
    if (capScale < 1) {
      w = Math.round(w * capScale)
      h = Math.round(h * capScale)
    }
    return { width: w, height: h }
  }, [keys, layoutOptions])

  // App.tsx entry paths (analytics back, post-unlock, view restore, status bar)
  // call setWindowCompactMode with an undefined saved size, which main skips —
  // leaving the window at normal size. Apply the default here so every entry
  // path lands on a sensibly sized window.
  const appliedDefaultSizeRef = useRef(false)
  useEffect(() => {
    if (!viewOnly) {
      appliedDefaultSizeRef.current = false
      return
    }
    if (viewOnlyWindowSize) return
    if (appliedDefaultSizeRef.current) return
    if (keys.length === 0) return
    appliedDefaultSizeRef.current = true
    const size = getDefaultCompactSize()
    window.vialAPI.setWindowCompactMode(true, size).catch(() => {})
    onViewOnlyWindowSizeChangeRef.current?.(size)
  }, [viewOnly, viewOnlyWindowSize, getDefaultCompactSize, keys.length])

  // Auto-fit using CSS transform + aspect ratio lock
  useEffect(() => {
    if (!viewOnly) return
    let paneNaturalW = 0
    let paneNaturalH = 0

    const computeCssScale = (): void => {
      if (paneNaturalW <= 0 || paneNaturalH <= 0) return
      const availW = window.innerWidth - MARGIN * 2
      const availH = window.innerHeight - MARGIN * 2
      const fitW = availW / paneNaturalW
      const fitH = availH / paneNaturalH
      const fitted = Math.min(fitW, fitH)
      setCssScale(Math.max(0.05, fitted))
    }

    requestAnimationFrame(() => {
      const el = paneWrapperRef.current
      if (!el) return
      paneNaturalW = el.scrollWidth
      paneNaturalH = el.scrollHeight
      paneNaturalSizeRef.current = { w: paneNaturalW, h: paneNaturalH }
      if (paneNaturalW <= 0 || paneNaturalH <= 0) return

      const totalW = paneNaturalW + MARGIN * 2
      const totalH = paneNaturalH + MARGIN * 2
      window.vialAPI.setWindowAspectRatio(totalW / totalH).catch(() => {})

      computeCssScale()
    })

    // Save window size on resize (debounced)
    let saveTimer: ReturnType<typeof setTimeout> | null = null
    const onResize = (): void => {
      computeCssScale()
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(() => {
        onViewOnlyWindowSizeChangeRef.current?.({ width: window.innerWidth, height: window.innerHeight })
      }, 500)
    }

    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      if (saveTimer) clearTimeout(saveTimer)
      window.vialAPI.setWindowAspectRatio(0).catch(() => {})
    }
  }, [viewOnly, keys, layoutOptions])

  // Sync always-on-top state
  useEffect(() => {
    if (!viewOnly) return
    window.vialAPI.setWindowAlwaysOnTop(viewOnlyAlwaysOnTop ?? false).catch(() => {})
    return () => { window.vialAPI.setWindowAlwaysOnTop(false).catch(() => {}) }
  }, [viewOnly, viewOnlyAlwaysOnTop])

  // Compact mode is managed by App.tsx onViewOnlyChange handler

  const handleViewOnlyToggle = useCallback(() => {
    if (!onViewOnlyChange) return
    const next = !viewOnly
    if (next) {
      const compactSize = viewOnlyWindowSize ?? getDefaultCompactSize()
      window.vialAPI.setWindowCompactMode(true, compactSize).then(() => {
        onViewOnlyChange(true)
      }).catch(() => {})
    } else {
      onViewOnlyChange(false)
    }
    // `typingTest` is unread by the body — kept in the deps verbatim from the
    // pre-split Pane, which is also why the hook still takes it as a param.
  }, [viewOnly, viewOnlyWindowSize, getDefaultCompactSize, onViewOnlyChange, typingTest])

  return {
    viewOnlyControlsOpen,
    setViewOnlyControlsOpen,
    mouseOver,
    alwaysOnTopSupported,
    paneWrapperRef,
    paneNaturalSizeRef,
    cssScale,
    getDefaultCompactSize,
    handleViewOnlyToggle,
  }
}
