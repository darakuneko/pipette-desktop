// SPDX-License-Identifier: GPL-2.0-or-later
//
// A thin Playwright-like layer over the WebdriverIO session of the capture,
// so the capture steps read as they do with Playwright: `page.locator(css,
// { hasText })`, `.filter({ has })`, `.first()`, `getByRole`, `click`,
// `waitFor`, `screenshot` and the like. Elements are found in the page by
// `queryPage` (page-query.ts); actions that need WebDriver (click,
// element screenshot) mark the element there first and then address it by
// that mark. Like Playwright, an action waits for its element (30 s unless
// given a timeout) and refuses a locator that matches more than one.

import { $, browser } from '@wdio/globals'
import {
  queryPage,
  REF_ATTRIBUTE,
  type ElementState,
  type QueryOp,
  type Step,
  type StepFilter,
  type TextMatcher,
} from './page-query'

const DEFAULT_TIMEOUT_MS = 30_000
const POLL_MS = 100

/** The WebDriver codes of the keys the capture presses. */
const KEY_CODES: Record<string, string> = {
  Escape: '\uE00C',
}

/** The selectors of the roles the capture looks up with `getByRole`. */
const ROLE_SELECTORS: Record<string, string> = {
  button: 'button, [role="button"], input[type="button"], input[type="submit"]',
  option: 'option, [role="option"]',
  listbox: 'select, [role="listbox"]',
}

/** Runs `fn` in the page with `args` and returns its answer. The function
 *  goes as its source text, so it may use only its own body. */
function runInPage<A extends unknown[], R>(fn: (...args: A) => R, ...args: A): Promise<Awaited<R>> {
  return browser.execute(fn as (...innerArgs: unknown[]) => R, ...args) as Promise<Awaited<R>>
}

function query<T>(chain: Step[], op: QueryOp, arg: string | null = null): Promise<T> {
  return runInPage(queryPage, chain, op, arg) as Promise<T>
}

function textMatcher(text: string | RegExp, exact = false): TextMatcher {
  return typeof text === 'string'
    ? { kind: 'text', text, exact }
    : { kind: 'regex', source: text.source, flags: text.flags }
}

/** The step of `css`. A trailing `:visible` (Playwright's pseudo-class,
 *  which no browser knows) becomes the visibility filter. */
function cssStep(css: string, hasText?: string | RegExp): Step {
  const visibleOnly = css.endsWith(':visible')
  const filters: StepFilter[] = []
  if (visibleOnly) filters.push({ type: 'visible' })
  if (hasText !== undefined) filters.push({ type: 'hasText', match: textMatcher(hasText) })
  return { css: visibleOnly ? css.slice(0, -':visible'.length) : css, filters }
}

function roleStep(role: string, opts: { name?: string | RegExp; exact?: boolean }): Step {
  const css = ROLE_SELECTORS[role]
  if (!css) throw new Error(`getByRole does not know the role ${role}`)
  const name = opts.name === undefined ? null : textMatcher(opts.name, opts.exact ?? false)
  return { css, filters: [{ type: 'role', name }] }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** The message of {@link Locator}'s check that the element it marked is
 *  still there: the page replaced the node between the mark and its use. */
const REPLACED_MESSAGE = 'the marked element was replaced'

/** Whether a failed WebDriver action may succeed on a later try with the
 *  element found again: it was covered, not yet interactable, or replaced
 *  in between. */
function isRetryableError(err: unknown): boolean {
  return (
    err instanceof Error &&
    new RegExp(`intercepted|not interactable|stale element|no such element|wasn't found|${REPLACED_MESSAGE}`, 'i').test(err.message)
  )
}

interface ClickOptions {
  timeout?: number
  /** Clicks in the page without waiting for the element to be visible,
   *  enabled and uncovered. */
  force?: boolean
  /** The point to click, from the element's top-left corner. */
  position?: { x: number; y: number }
}

type WaitState = 'attached' | 'detached' | 'visible'

export class Locator {
  constructor(
    private readonly owner: Page,
    readonly chain: Step[],
    private readonly description: string,
  ) {}

  page(): Page {
    return this.owner
  }

  locator(css: string, opts: { hasText?: string | RegExp } = {}): Locator {
    return new Locator(this.owner, [...this.chain, cssStep(css, opts.hasText)], `${this.description} >> ${css}`)
  }

  getByRole(role: string, opts: { name?: string | RegExp; exact?: boolean } = {}): Locator {
    return new Locator(this.owner, [...this.chain, roleStep(role, opts)], `${this.description} >> role=${role}[${String(opts.name)}]`)
  }

  filter(opts: { has?: Locator; hasText?: string | RegExp }): Locator {
    const added: StepFilter[] = []
    if (opts.hasText !== undefined) added.push({ type: 'hasText', match: textMatcher(opts.hasText) })
    if (opts.has) added.push({ type: 'has', chain: opts.has.chain })
    return this.withFilters(added, ' >> filter')
  }

  first(): Locator {
    return this.nth(0)
  }

  nth(index: number): Locator {
    return this.withFilters([{ type: 'nth', index }], ` >> nth=${index}`)
  }

  async all(): Promise<Locator[]> {
    const count = await this.count()
    return Array.from({ length: count }, (_, i) => this.nth(i))
  }

  count(): Promise<number> {
    return query<number>(this.chain, 'count')
  }

  /** Whether the element is visible now, without waiting. */
  async isVisible(): Promise<boolean> {
    const state = await this.state()
    if (state.count > 1) throw this.strictError(state.count)
    return state.visible
  }

  async isEnabled(): Promise<boolean> {
    await this.waitFor({ state: 'attached' })
    return (await this.state()).enabled
  }

  async getAttribute(name: string): Promise<string | null> {
    await this.waitFor({ state: 'attached' })
    return query<string | null>(this.chain, 'attribute', name)
  }

  async waitFor(opts: { state?: WaitState; timeout?: number } = {}): Promise<void> {
    const wanted = opts.state ?? 'visible'
    const deadline = Date.now() + (opts.timeout ?? DEFAULT_TIMEOUT_MS)
    for (;;) {
      const state = await this.state()
      if (state.count > 1 && wanted !== 'detached') throw this.strictError(state.count)
      if (this.reached(wanted, state)) return
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${this.description} to be ${wanted}`)
      await sleep(POLL_MS)
    }
  }

  async click(opts: ClickOptions = {}): Promise<void> {
    const deadline = Date.now() + (opts.timeout ?? DEFAULT_TIMEOUT_MS)
    if (opts.force) {
      await this.waitFor({ state: 'attached', timeout: opts.timeout })
      const ref = await this.mark()
      await runInPage((selector: string) => {
        ;(document.querySelector(selector) as HTMLElement).click()
      }, ref)
      return
    }
    for (;;) {
      await this.waitFor({ state: 'visible', timeout: Math.max(0, deadline - Date.now()) })
      if ((await this.state()).enabled) {
        try {
          const element = await this.markedElement()
          if (opts.position) {
            // WebDriver takes whole pixels from the element's center.
            const size = await element.getSize()
            await element.click({
              x: Math.round(opts.position.x - size.width / 2),
              y: Math.round(opts.position.y - size.height / 2),
            })
          } else {
            await element.click()
          }
          return
        } catch (err) {
          if (!isRetryableError(err) || Date.now() >= deadline) throw err
        }
      } else if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for ${this.description} to be enabled`)
      }
      await sleep(POLL_MS)
    }
  }

  /** Picks the option of a `<select>` whose value (or else label) is
   *  `value`, or the one at `index`, and sends the `input` and `change`
   *  events a user's choice sends, as Playwright's `selectOption` does. */
  async selectOption(value: string | null | { index: number }): Promise<void> {
    if (value === null) throw new Error(`selectOption on ${this.description} got no value`)
    await this.waitFor({ state: 'attached' })
    const ref = await this.mark()
    const picked = await runInPage(
      (selector: string, wanted: string | { index: number }) => {
        const select = document.querySelector(selector)
        if (!(select instanceof HTMLSelectElement)) return 'not a select element'
        const options = Array.from(select.options)
        const option = typeof wanted === 'string'
          ? options.find((o) => o.value === wanted) ?? options.find((o) => o.label === wanted)
          : options[wanted.index]
        if (!option) return `no option ${JSON.stringify(wanted)}`
        select.value = option.value
        select.dispatchEvent(new Event('input', { bubbles: true }))
        select.dispatchEvent(new Event('change', { bubbles: true }))
        return null
      },
      ref,
      value,
    )
    if (picked !== null) throw new Error(`selectOption on ${this.description}: ${picked}`)
  }

  async scrollIntoViewIfNeeded(): Promise<void> {
    await this.waitFor({ state: 'attached' })
    await query<boolean>(this.chain, 'scroll')
  }

  /** Runs `fn` in the page with the element. */
  evaluate<R>(fn: (el: Element) => R): Promise<Awaited<R>> {
    return this.withElement('attached', (element) => element.execute(fn) as Promise<Awaited<R>>)
  }

  /** Saves a screenshot of the element alone. */
  async screenshot(opts: { path: string }): Promise<void> {
    await this.withElement('visible', (element) => element.saveScreenshot(opts.path))
  }

  /** Waits for the element in `state` and runs `action` on it, finding it
   *  again when the page replaced it in between, for up to the default
   *  timeout. */
  private async withElement<T>(state: WaitState, action: (element: WebdriverIO.Element) => Promise<T>): Promise<T> {
    const deadline = Date.now() + DEFAULT_TIMEOUT_MS
    for (;;) {
      await this.waitFor({ state, timeout: Math.max(0, deadline - Date.now()) })
      try {
        return await action(await this.markedElement())
      } catch (err) {
        if (!isRetryableError(err) || Date.now() >= deadline) throw err
      }
      await sleep(POLL_MS)
    }
  }

  /** The WebDriver element of {@link mark}, checked to exist without the
   *  implicit wait WebdriverIO gives an element it has not found. */
  private async markedElement(): Promise<WebdriverIO.Element> {
    const element = await $(await this.mark()).getElement()
    if (!(await element.isExisting())) throw new Error(`${this.description}: ${REPLACED_MESSAGE}`)
    return element
  }

  private reached(wanted: WaitState, state: ElementState): boolean {
    switch (wanted) {
      case 'attached':
        return state.count === 1
      case 'detached':
        return state.count === 0
      case 'visible':
        return state.count === 1 && state.visible
    }
  }

  private state(): Promise<ElementState> {
    return query<ElementState>(this.chain, 'state')
  }

  /** Marks the one element of the locator and returns its selector. */
  private async mark(): Promise<string> {
    const tokens = await query<string[]>(this.chain, 'tag')
    if (tokens.length === 0) throw new Error(`${this.description} matches no element`)
    if (tokens.length > 1) throw this.strictError(tokens.length)
    return `[${REF_ATTRIBUTE}="${tokens[0]}"]`
  }

  private withFilters(added: StepFilter[], suffix: string): Locator {
    const last = this.chain[this.chain.length - 1]
    const chain = [...this.chain.slice(0, -1), { ...last, filters: [...last.filters, ...added] }]
    return new Locator(this.owner, chain, `${this.description}${suffix}`)
  }

  private strictError(count: number): Error {
    return new Error(`strict mode violation: ${this.description} matches ${count} elements`)
  }
}

export class Page {
  readonly keyboard = {
    press: async (key: string): Promise<void> => {
      const code = KEY_CODES[key]
      if (!code) throw new Error(`keyboard.press does not know the key ${key}`)
      await browser.keys([code])
    },
  }

  locator(css: string, opts: { hasText?: string | RegExp } = {}): Locator {
    return new Locator(this, [cssStep(css, opts.hasText)], css)
  }

  getByRole(role: string, opts: { name?: string | RegExp; exact?: boolean } = {}): Locator {
    return new Locator(this, [roleStep(role, opts)], `role=${role}[${String(opts.name)}]`)
  }

  /** Saves a screenshot of the window's page. The app's page is exactly
   *  the window's size (it does not scroll as a whole), so this is the
   *  full page too. */
  async screenshot(opts: { path: string }): Promise<void> {
    await browser.saveScreenshot(opts.path)
  }

  waitForTimeout(ms: number): Promise<void> {
    return sleep(ms)
  }

  evaluate<R>(fn: () => R): Promise<Awaited<R>> {
    return runInPage(fn)
  }
}
