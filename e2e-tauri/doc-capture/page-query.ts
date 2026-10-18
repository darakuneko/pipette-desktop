// SPDX-License-Identifier: GPL-2.0-or-later
//
// The part of the capture's Playwright-like locators (page.ts) that runs in
// the page: finding the elements of a locator chain and reading their state.
// `queryPage` is sent to the page as its source text (`runInPage` of
// page.ts), so it must not use anything from outside its own body.

/** How an element's text, or its accessible name, is matched: a string is
 *  a case-insensitive substring of the whitespace-normalized text unless
 *  `exact`, a regular expression is tested against that text. */
export type TextMatcher =
  | { kind: 'text'; text: string; exact: boolean }
  | { kind: 'regex'; source: string; flags: string }

/** A filter applied, in order, to the elements a step's selector found. */
export type StepFilter =
  | { type: 'visible' }
  | { type: 'hasText'; match: TextMatcher }
  | { type: 'has'; chain: Step[] }
  | { type: 'role'; name: TextMatcher | null }
  | { type: 'nth'; index: number }

/** One step of a locator chain: the elements matching `css` inside the
 *  elements of the previous step (the document for the first one). */
export interface Step {
  css: string
  filters: StepFilter[]
}

/** What a query returns about the elements it found. */
export type QueryOp = 'count' | 'state' | 'tag' | 'attribute' | 'scroll'

/** The answer of the `state` query: how many elements matched, and the
 *  state of the first one. */
export interface ElementState {
  count: number
  visible: boolean
  enabled: boolean
}

/** Defines `__name` for a function sent as source text: the TypeScript
 *  loader keeps function names by wrapping them in `__name(...)`, which the
 *  page does not have, so the script defines it to return the function as
 *  is. */
const NAME_SHIM = 'var __name = function (target) { return target; };'

/** The WebDriver script that calls the function whose source is `source`
 *  with the script's arguments and returns its answer. */
export function callScript(source: string): string {
  return `${NAME_SHIM} return (${source}).apply(null, arguments);`
}

/** The WebDriver script that calls the function whose source is `source`
 *  with the element the script's first argument (a selector) finds. */
export function callWithElementScript(source: string): string {
  return `${NAME_SHIM} return (${source})(document.querySelector(arguments[0]));`
}

/** The attribute `tag` puts on the matched elements, so the WebDriver side
 *  can find exactly them (`[data-doc-capture-ref="<token>"]`). */
export const REF_ATTRIBUTE = 'data-doc-capture-ref'

/**
 * Finds the elements of `chain` and answers `op` about them:
 * - `count`: how many there are.
 * - `state`: the count and whether the first one is visible (a non-empty
 *   box and not `visibility: hidden`, as Playwright's `isVisible`) and
 *   enabled (no native `disabled`, no disabled fieldset, no
 *   `aria-disabled="true"` on it or an ancestor).
 * - `tag`: marks each with a fresh token in {@link REF_ATTRIBUTE}, after
 *   removing the marks of the previous `tag`, and returns the tokens.
 * - `attribute`: the attribute `arg` of the first one (null when absent or
 *   when nothing matched).
 * - `scroll`: scrolls the first one into the middle of the view unless it
 *   is already inside it; returns whether there was one.
 */
export function queryPage(chain: Step[], op: QueryOp, arg: string | null): unknown {
  const refAttribute = 'data-doc-capture-ref'
  const normalize = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim()
  const matches = (match: TextMatcher, text: string): boolean => {
    if (match.kind === 'regex') return new RegExp(match.source, match.flags).test(text)
    const wanted = normalize(match.text)
    return match.exact ? text === wanted : text.toLowerCase().includes(wanted.toLowerCase())
  }
  const isVisible = (el: Element): boolean => {
    const box = el.getBoundingClientRect()
    return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden'
  }
  const isHiddenFromRoles = (el: Element): boolean => {
    if (getComputedStyle(el).visibility === 'hidden') return true
    for (let node: Element | null = el; node; node = node.parentElement) {
      if (node.getAttribute('aria-hidden') === 'true') return true
      if (getComputedStyle(node).display === 'none') return true
    }
    return false
  }
  const accessibleName = (el: Element): string => {
    const label = normalize(el.getAttribute('aria-label'))
    if (label) return label
    const labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ')
      if (normalize(text)) return normalize(text)
    }
    return normalize(el.textContent)
  }
  const isEnabled = (el: Element): boolean => {
    if ((el as HTMLButtonElement).disabled === true) return false
    const fieldset = el.closest('fieldset[disabled]')
    if (fieldset && !fieldset.querySelector(':scope > legend')?.contains(el)) return false
    return el.closest('[aria-disabled="true"]') === null
  }
  const inDocumentOrder = (elements: Element[]): Element[] =>
    elements.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
  const resolve = (steps: Step[], roots: ParentNode[]): Element[] => {
    let current: ParentNode[] = roots
    let found: Element[] = []
    for (const step of steps) {
      const seen = new Set<Element>()
      for (const root of current) {
        for (const el of Array.from(root.querySelectorAll(step.css))) seen.add(el)
      }
      found = current.length > 1 ? inDocumentOrder([...seen]) : [...seen]
      for (const filter of step.filters) {
        if (filter.type === 'visible') found = found.filter(isVisible)
        else if (filter.type === 'hasText') found = found.filter((el) => matches(filter.match, normalize(el.textContent)))
        else if (filter.type === 'has') found = found.filter((el) => resolve(filter.chain, [el]).length > 0)
        else if (filter.type === 'role') {
          const name = filter.name
          found = found.filter((el) => !isHiddenFromRoles(el) && (name === null || matches(name, accessibleName(el))))
        } else {
          const picked = filter.index < 0 ? found[found.length + filter.index] : found[filter.index]
          found = picked ? [picked] : []
        }
      }
      current = found
    }
    return found
  }

  const elements = resolve(chain, [document])
  const first = elements[0]
  switch (op) {
    case 'count':
      return elements.length
    case 'state':
      return {
        count: elements.length,
        visible: first !== undefined && isVisible(first),
        enabled: first !== undefined && isEnabled(first),
      } satisfies ElementState
    case 'tag': {
      for (const el of Array.from(document.querySelectorAll(`[${refAttribute}]`))) el.removeAttribute(refAttribute)
      const page = window as unknown as { __docCaptureRefSeq?: number }
      return elements.map((el) => {
        page.__docCaptureRefSeq = (page.__docCaptureRefSeq ?? 0) + 1
        const token = String(page.__docCaptureRefSeq)
        el.setAttribute(refAttribute, token)
        return token
      })
    }
    case 'attribute':
      return first === undefined || arg === null ? null : first.getAttribute(arg)
    case 'scroll': {
      if (first === undefined) return false
      const box = first.getBoundingClientRect()
      const inView = box.top >= 0 && box.left >= 0 && box.bottom <= window.innerHeight && box.right <= window.innerWidth
      if (!inView) first.scrollIntoView({ block: 'center', inline: 'center' })
      return true
    }
  }
}
