// SPDX-License-Identifier: GPL-2.0-or-later

import { useEffect } from 'react'

/**
 * Close a modal / dialog when the user presses Escape.
 *
 * The listener runs in the bubble phase so nested elements that consume
 * Escape in the capture phase (KeyPopover, MacroRecorder, MacroTextEditor,
 * JsonEditorModal, etc.) get first chance to stop propagation. This keeps
 * inner popovers / recorders from accidentally closing the outer modal.
 *
 * Skips the close in the following "user is interacting" cases so pressing
 * Escape cannot discard work:
 * - IME composition is active (`e.isComposing`)
 * - An input-like element (`<input>`, `<textarea>`, `<select>`, or any
 *   `contenteditable`) is the event target or the current `activeElement`
 *
 * The caller can also pass `enabled = false` to disable the listener while
 * the modal is busy (e.g. sync in progress).
 */
function isTypableElement(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  // Cover any element nested inside a contenteditable region
  return el.closest('[contenteditable=""], [contenteditable="true"]') !== null
}

export function useEscapeClose(onClose: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (e.isComposing) return
      if (isTypableElement(e.target) || isTypableElement(document.activeElement)) return
      onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [enabled, onClose])
}

/**
 * Consume Escape keydowns in the capture phase without taking any action.
 *
 * Used by overlays that must not close on Escape themselves but also must not
 * let the event reach a parent `useEscapeClose` listener (which would close
 * the modal beneath). Registering in the capture phase + `stopPropagation`
 * ensures the event is handled before any parent bubble-phase listener.
 */
export function useEscapeSwallow(enabled = true): void {
  useEffect(() => {
    if (!enabled) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') e.stopPropagation()
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [enabled])
}
