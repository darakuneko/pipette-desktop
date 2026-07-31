// SPDX-License-Identifier: GPL-2.0-or-later

import { useEffect } from 'react'

/**
 * Close a modal / dialog when the user presses Escape.
 *
 * The listener runs in the bubble phase so nested elements that consume
 * Escape in the capture phase (KeyPopover, MacroRecorder, MacroTextEditor,
 * JsonEditorModal, etc.) get first chance to stop propagation. This keeps
 * inner popovers / recorders from accidentally closing the outer modal —
 * though only because those inner listeners run in the CAPTURE phase and
 * call `stopPropagation` there, before this bubble-phase listener ever
 * sees the event; `stopPropagation` itself has no node-level exclusivity
 * of its own; two ordinary bubble-phase listeners on the very same node
 * (e.g. two separate `useEscapeClose` calls in the same component) would
 * both still fire independently. See `useEscapeCloseCapture`'s own doc
 * comment for why THAT hook's phase/stopPropagation combination is what
 * actually gives it priority over this one, not `stopPropagation` alone.
 *
 * Skips the close in the following "user is interacting" cases so pressing
 * Escape cannot discard work:
 * - IME composition is active (`e.isComposing`)
 * - A typable element (`<textarea>`, `<select>`, a text-like `<input>`, or
 *   any `contenteditable`) is the event target or the current
 *   `activeElement` — an `<input>` of a non-text type (`range`,
 *   `checkbox`, `radio`, `button`, `submit`, `color`; see
 *   `NON_TYPABLE_INPUT_TYPES`) has nothing Escape could discard, so it is
 *   deliberately NOT covered by this guard: without this distinction, a
 *   focused zoom slider (an `<input type="range">`, e.g.
 *   WordTimelineView's) made Escape dead for the whole modal stack,
 *   nested or not, since this same predicate backs both this hook and
 *   `useEscapeCloseCapture`.
 *
 * The caller can also pass `enabled = false` to disable the listener while
 * the modal is busy (e.g. sync in progress).
 */
const NON_TYPABLE_INPUT_TYPES = new Set(['range', 'checkbox', 'radio', 'button', 'submit', 'color'])

function isTypableElement(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') return !NON_TYPABLE_INPUT_TYPES.has((el as HTMLInputElement).type)
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
 * Close on Escape, same as `useEscapeClose`, but in the CAPTURE phase and
 * with `stopPropagation` — for a modal nested inside another modal that
 * also has its own bubble-phase `useEscapeClose`. Without this, a single
 * Escape press would close both: the inner view first (bubble phase
 * hasn't even started yet) is not enough on its own to stop the SAME
 * event from later reaching the outer modal's bubble-phase listener,
 * since bubble-phase listeners fire on the way back up. Registering in
 * the capture phase runs before that — `stopPropagation` there prevents
 * the event from ever reaching the outer listener at all.
 *
 * Keeps the exact same "user is interacting" guards `useEscapeClose` has
 * (IME composition, focus in a typable element) BY DEFAULT so this can't
 * discard work either — the alternative (`useEscapeSwallow` below) has no
 * such guard because it never closes anything itself.
 *
 * `guardTypable` (default `true`) lets a caller opt OUT of the typable-
 * element check specifically, while always keeping the `isComposing`
 * check (IME protection is a strict improvement with no such tradeoff).
 * `JsonEditorModal` passes `false`: its only control is the textarea it
 * edits JSON in, so with the default guard on, Escape could never close
 * it at all — every keydown while typing originates from inside that
 * same typable element. That IS a real regression from before this
 * component was switched onto this shared hook (its previous hand-rolled
 * handler had no typable guard), not a new tradeoff being introduced.
 */
export function useEscapeCloseCapture(onClose: () => void, enabled = true, guardTypable = true): void {
  useEffect(() => {
    if (!enabled) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (e.isComposing) return
      if (guardTypable && (isTypableElement(e.target) || isTypableElement(document.activeElement))) return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [enabled, guardTypable, onClose])
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
