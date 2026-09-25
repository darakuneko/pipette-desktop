// SPDX-License-Identifier: GPL-2.0-or-later
//
// State machine for the key picker's tab reorder mode (`KeycodeTabBar.tsx`).
//
//   idle ──long-press 500 ms / Shift+F10 / ContextMenu──▶ active
//   active ──drag start──▶ dragging ──drop on a tab──▶ active (saves once)
//                                   └─drag end / Esc / outside drop──▶ active
//   active ──Enter / Esc / Done / pointerdown outside `barRef` / modal on top──▶ idle
//
// Only a drop on a tab or an arrow-key move commits, and only an order that
// actually changed is saved. The display order is a projection of the saved
// full order (`keycode-tab-order.ts`); selection and content never read it.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useKeycodeTabOrder } from './keycode-tab-order-context'
import { moveVisible, projectVisible, resolveFullOrder, sameOrder } from './keycode-tab-order'

export const LONG_PRESS_MS = 500
/** A press that moves further than this is a scroll or drag, not a long-press. */
const LONG_PRESS_MOVE_TOLERANCE_PX = 8

/** Marks the mode's own buttons (Reset / Done in `KeycodeTabBar.tsx`):
 *  Enter activates them instead of closing the mode. */
const TAB_REORDER_ACTION_SELECTOR = '[data-tab-reorder-action]'

interface Args {
  /** Only the keymap editor's picker edits the order. */
  enabled: boolean
  /** Visible tab ids in the canonical order. */
  visibleIds: readonly string[]
  barRef: RefObject<HTMLElement | null>
  onSelectTab: (id: string) => void
  /** Screen-reader text for a finished move (1-based position). */
  describeMove: (id: string, position: number, total: number) => string
  /** Screen-reader text announced when the mode opens. */
  enterMessage: string
}

/** True when something (a modal overlay) sits on top of the bar's centre. */
function isCovered(bar: HTMLElement | null): boolean {
  if (!bar || typeof document.elementFromPoint !== 'function') return false
  const rect = bar.getBoundingClientRect()
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
  return hit !== null && !bar.contains(hit)
}

export function useKeycodeTabReorder({ enabled, visibleIds, barRef, onSelectTab, describeMove, enterMessage }: Args) {
  const { order, setOrder, scopeKey } = useKeycodeTabOrder()
  const full = useMemo(() => resolveFullOrder(order), [order])
  const orderedIds = useMemo(() => projectVisible(visibleIds, full), [visibleIds, full])

  const [activeState, setActive] = useState(false)
  const active = enabled && activeState
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')

  const pressRef = useRef<{ timer: number; x: number; y: number } | null>(null)
  const dragIdRef = useRef<string | null>(null)
  // The long-press that opened the mode ends in a click on the same tab;
  // that click must not switch tabs.
  const suppressClickRef = useRef(false)
  const pendingFocusRef = useRef<string | null>(null)
  const lastWrittenRef = useRef(order)

  const cancelPress = useCallback(() => {
    if (pressRef.current) window.clearTimeout(pressRef.current.timer)
    pressRef.current = null
  }, [])

  const clearDrag = useCallback(() => {
    dragIdRef.current = null
    setDragId(null)
    setDropTargetId(null)
  }, [])

  const exit = useCallback(() => {
    cancelPress()
    clearDrag()
    suppressClickRef.current = false
    setActive(false)
    setAnnouncement('')
  }, [cancelPress, clearDrag])

  const enter = useCallback(() => {
    setActive(true)
    setAnnouncement(enterMessage)
  }, [enterMessage])

  function commitMove(fromId: string, toIndex: number): boolean {
    const next = moveVisible(full, orderedIds, fromId, toIndex)
    if (sameOrder(next, full)) return false
    lastWrittenRef.current = next
    setOrder(next)
    setAnnouncement(describeMove(fromId, toIndex + 1, orderedIds.length))
    return true
  }

  function reset(): void {
    clearDrag()
    if (order === undefined) return
    lastWrittenRef.current = undefined
    setOrder(undefined)
  }

  useEffect(() => cancelPress, [cancelPress])
  useEffect(() => { exit() }, [scopeKey, exit])
  useEffect(() => { if (!enabled) exit() }, [enabled, exit])

  // An order replaced from outside (another keyboard's prefs, a reset in a
  // second picker) drops a drag that started against the old order.
  useEffect(() => {
    if (order !== lastWrittenRef.current) clearDrag()
    lastWrittenRef.current = order
  }, [order, clearDrag])

  useEffect(() => {
    if (!enabled) return
    window.addEventListener('blur', cancelPress)
    return () => window.removeEventListener('blur', cancelPress)
  }, [enabled, cancelPress])

  useEffect(() => {
    if (!active) return
    const bar = barRef.current
    const onPointerDown = (e: PointerEvent): void => {
      if (!(e.target instanceof Node && bar?.contains(e.target))) exit()
    }
    // Capture on window runs before the picker's Enter-to-confirm and the
    // editor's Escape handlers, so the mode consumes these two keys first.
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter' && e.key !== 'Escape') return
      if (e.isComposing || e.keyCode === 229) return
      if (isCovered(bar)) { exit(); return }
      e.preventDefault()
      e.stopPropagation()
      const action = e.target instanceof Element ? e.target.closest<HTMLElement>(TAB_REORDER_ACTION_SELECTOR) : null
      if (e.key === 'Enter' && action) { action.click(); return }
      if (e.key === 'Escape' && dragIdRef.current) { clearDrag(); return }
      exit()
    }
    const observer = new MutationObserver(() => { if (isCovered(bar)) exit() })
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
      observer.disconnect()
    }
  }, [active, barRef, exit, clearDrag])

  // A move re-inserts the tab's DOM node, which drops its focus.
  useLayoutEffect(() => {
    const id = pendingFocusRef.current
    if (!id) return
    pendingFocusRef.current = null
    const tabs = barRef.current?.querySelectorAll<HTMLElement>('[data-keycode-tab]') ?? []
    const el = Array.from(tabs).find((tab) => tab.dataset.keycodeTab === id)
    el?.focus()
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [orderedIds, barRef])

  function tabProps(id: string) {
    return {
      'data-keycode-tab': id,
      draggable: active,
      onClick: (): void => {
        if (suppressClickRef.current) { suppressClickRef.current = false; return }
        if (!active) onSelectTab(id)
      },
      onPointerDown: (e: React.PointerEvent): void => {
        if (!enabled || active || e.button !== 0) return
        cancelPress()
        suppressClickRef.current = false
        const timer = window.setTimeout(() => {
          pressRef.current = null
          suppressClickRef.current = true
          enter()
        }, LONG_PRESS_MS)
        pressRef.current = { timer, x: e.clientX, y: e.clientY }
      },
      onPointerMove: (e: React.PointerEvent): void => {
        const press = pressRef.current
        if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > LONG_PRESS_MOVE_TOLERANCE_PX) cancelPress()
      },
      onPointerUp: cancelPress,
      onPointerCancel: cancelPress,
      onPointerLeave: cancelPress,
      onKeyDown: (e: React.KeyboardEvent): void => {
        if (!enabled) return
        if (!active) {
          if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); enter() }
          return
        }
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
        e.preventDefault()
        const target = orderedIds.indexOf(id) + (e.key === 'ArrowLeft' ? -1 : 1)
        if (commitMove(id, target)) pendingFocusRef.current = id
      },
      onDragStart: (e: React.DragEvent): void => {
        if (!active) { e.preventDefault(); return }
        dragIdRef.current = id
        setDragId(id)
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', id)
      },
      onDragOver: (e: React.DragEvent): void => {
        if (!dragIdRef.current) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDropTargetId(id)
      },
      onDragLeave: (e: React.DragEvent): void => {
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
        setDropTargetId((current) => (current === id ? null : current))
      },
      onDrop: (e: React.DragEvent): void => {
        const fromId = dragIdRef.current
        if (!fromId) return
        e.preventDefault()
        clearDrag()
        commitMove(fromId, orderedIds.indexOf(id))
      },
      onDragEnd: clearDrag,
    }
  }

  return { orderedIds, active, dragId, dropTargetId, announcement, canReset: order !== undefined, exit, reset, tabProps }
}
