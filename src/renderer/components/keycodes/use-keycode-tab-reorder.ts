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
// The tab the user works with — the one that opened the mode, a pressed,
// clicked or dragged tab, a tab moved with ←/→ — becomes the selected tab;
// a drop target never does.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useKeycodeTabOrder } from './keycode-tab-order-context'
import { moveVisible, projectVisible, resolveFullOrder, sameOrder } from './keycode-tab-order'

export const LONG_PRESS_MS = 500
/** A press that moves further than this is a scroll or drag, not a long-press. */
const LONG_PRESS_MOVE_TOLERANCE_PX = 8

/** Drag data type for a tab, so a tab dropped on a text field inserts nothing. */
const TAB_DRAG_MIME = 'application/x-pipette-keycode-tab'

interface Args {
  /** Only the keymap editor's picker edits the order. */
  enabled: boolean
  /** Visible tab ids in the canonical order. */
  visibleIds: readonly string[]
  barRef: RefObject<HTMLElement | null>
  onSelectTab: (id: string) => void
  /** The selected tab; gets the focus when the mode's own buttons lose it. */
  selectedId: string
  /** Screen-reader text for a finished move (1-based position). */
  describeMove: (id: string, position: number, total: number) => string
  /** Screen-reader text announced when the mode opens. */
  enterMessage: string
  /** Screen-reader text announced after Reset. */
  resetMessage: string
}

/** True when something (a modal overlay) sits on top of the bar's centre. */
function isCovered(bar: HTMLElement | null): boolean {
  if (!bar || typeof document.elementFromPoint !== 'function') return false
  const rect = bar.getBoundingClientRect()
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
  return hit !== null && !bar.contains(hit)
}

export function useKeycodeTabReorder({
  enabled, visibleIds, barRef, onSelectTab, selectedId, describeMove, enterMessage, resetMessage,
}: Args) {
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
  const pendingFocusRef = useRef<string | null>(null)
  const [focusRequest, setFocusRequest] = useState(0)
  const lastFocusedTabRef = useRef<string | null>(null)
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

  /** Focuses the last focused tab (or the selected one) after the render. */
  const focusTab = useCallback((id?: string) => {
    pendingFocusRef.current = id ?? lastFocusedTabRef.current ?? selectedId
    setFocusRequest((n) => n + 1)
  }, [selectedId])

  const exit = useCallback(() => {
    cancelPress()
    clearDrag()
    setActive(false)
    setAnnouncement('')
  }, [cancelPress, clearDrag])

  /** Exit that keeps keyboard focus in the tab bar (Done, Enter, Esc). */
  const finish = useCallback(() => {
    exit()
    focusTab()
  }, [exit, focusTab])

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
    setAnnouncement(resetMessage)
    // Reset disables itself; keep the focus in the tab bar.
    focusTab()
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
    // Enter on a focused button in the bar that is not a tab (Reset, Done,
    // the `tabBarRight` controls) presses that button instead; the picker's
    // own Enter handler would otherwise swallow the native click.
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter' && e.key !== 'Escape') return
      if (e.isComposing || e.keyCode === 229) return
      if (isCovered(bar)) { exit(); return }
      e.preventDefault()
      e.stopPropagation()
      const button = e.target instanceof Element ? e.target.closest('button') : null
      if (e.key === 'Enter' && button && bar?.contains(button) && !button.hasAttribute('data-keycode-tab')) {
        button.click()
        return
      }
      if (e.key === 'Escape' && dragIdRef.current) { clearDrag(); return }
      finish()
    }
    // Any mutation in the app can mean a modal opened, but `isCovered`
    // forces layout, so check at most once per frame.
    let frame: number | null = null
    const observer = new MutationObserver(() => {
      if (frame !== null) return
      frame = requestAnimationFrame(() => {
        frame = null
        if (isCovered(bar)) exit()
      })
    })
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
      observer.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [active, barRef, exit, finish, clearDrag])

  // A move re-inserts the tab's DOM node, which drops its focus; Done and
  // Reset hand the focus back to a tab.
  useLayoutEffect(() => {
    const id = pendingFocusRef.current
    if (!id) return
    pendingFocusRef.current = null
    const tabs = barRef.current?.querySelectorAll<HTMLElement>('[data-keycode-tab]') ?? []
    const el = Array.from(tabs).find((tab) => tab.dataset.keycodeTab === id)
    el?.focus()
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [orderedIds, focusRequest, barRef])

  /** Selects `id` unless it already is, so re-picking the selected tab
   *  (the release of the long-press that opened the mode, a move of the
   *  selected tab) does not clear the picker selection via `onTabChange`. */
  function pick(id: string): void {
    if (id !== selectedId) onSelectTab(id)
  }

  function tabProps(id: string) {
    return {
      'data-keycode-tab': id,
      draggable: active,
      onFocus: (): void => { lastFocusedTabRef.current = id },
      onClick: (): void => {
        if (active) pick(id)
        else onSelectTab(id)
      },
      onPointerDown: (e: React.PointerEvent): void => {
        if (!enabled || e.button !== 0) return
        // In the mode a press selects the tab right away; no preventDefault,
        // so the drag that may follow still starts.
        if (active) { pick(id); return }
        cancelPress()
        const timer = window.setTimeout(() => {
          pressRef.current = null
          pick(id)
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
          if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); pick(id); enter() }
          return
        }
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
        e.preventDefault()
        const target = orderedIds.indexOf(id) + (e.key === 'ArrowLeft' ? -1 : 1)
        if (!commitMove(id, target)) return
        pick(id)
        focusTab(id)
      },
      onDragStart: (e: React.DragEvent): void => {
        if (!active) { e.preventDefault(); return }
        dragIdRef.current = id
        setDragId(id)
        pick(id)
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData(TAB_DRAG_MIME, id)
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

  return { orderedIds, active, dragId, dropTargetId, announcement, canReset: order !== undefined, finish, reset, tabProps }
}
