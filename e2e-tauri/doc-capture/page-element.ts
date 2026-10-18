// SPDX-License-Identifier: GPL-2.0-or-later
//
// The actions and reads of one element that the capture's locators
// (page.ts) run in the page, on the element a locator marked
// (page-query.ts). Each function is sent to the page as its source text
// (WebdriverIO's `execute`), so it must not use anything from outside its
// own body.

/** A box in the page's viewport, as Playwright's `boundingBox` gives it. */
export interface ElementBox {
  x: number
  y: number
  width: number
  height: number
}

/** What {@link readElement} reads. */
export type ElementRead = 'text' | 'value' | 'box'

/**
 * Sets the value of the input or textarea `selector` finds to `value` the
 * way Playwright's `fill` does: focuses it, sets the value through the
 * element's own value setter (which React's change tracking watches), and
 * sends `input` and `change`. Answers null, or why it could not.
 */
export function fillElement(selector: string, value: string): string | null {
  const el = document.querySelector(selector)
  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return 'not an input or textarea'
  if (el.disabled || el.readOnly) return 'not editable'
  el.focus()
  const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (setter) setter.call(el, value)
  else el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return null
}

/**
 * Reads the element `selector` finds: its text content (`text`), the value
 * of an input, textarea or select (`value`, an empty string for any other
 * element), or its box in the viewport (`box`, null when it has no size,
 * as Playwright's `boundingBox` answers for an element it cannot see).
 */
export function readElement(selector: string, what: ElementRead): string | ElementBox | null {
  const el = document.querySelector(selector)
  if (!el) return null
  if (what === 'text') return el.textContent
  if (what === 'value') {
    return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
      ? el.value
      : ''
  }
  const box = el.getBoundingClientRect()
  if (box.width === 0 && box.height === 0) return null
  return { x: box.x, y: box.y, width: box.width, height: box.height }
}

/** Sends a bubbling `dblclick` to the element `selector` finds, without
 *  the pointer: Playwright's `dblclick({ force: true })` on an element
 *  that need not be reachable. Answers whether there was one. */
export function dispatchDoubleClick(selector: string): boolean {
  const el = document.querySelector(selector)
  if (!el) return false
  el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }))
  return true
}
