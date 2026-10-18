// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later
// The in-page half of the capture's locators: the elements a chain finds
// (Playwright's `hasText`, `has`, `:visible`, `nth` and `getByRole`
// semantics), the state it reads, and the marks it leaves.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  queryPage,
  REF_ATTRIBUTE,
  type ElementState,
  type Step,
  type StepFilter,
  type TextMatcher,
} from '../page-query'

const text = (value: string, exact = false): TextMatcher => ({ kind: 'text', text: value, exact })
const regex = (value: RegExp): TextMatcher => ({ kind: 'regex', source: value.source, flags: value.flags })
const step = (css: string, ...filters: StepFilter[]): Step => ({ css, filters })

const realRect = Element.prototype.getBoundingClientRect

beforeEach(() => {
  // jsdom lays nothing out: every element gets a box unless it is marked
  // as having none.
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const empty = this.classList.contains('no-box')
    return { x: 0, y: 0, top: 0, left: 0, right: empty ? 0 : 10, bottom: empty ? 0 : 10, width: empty ? 0 : 10, height: empty ? 0 : 10, toJSON: () => ({}) }
  }
})

afterEach(() => {
  Element.prototype.getBoundingClientRect = realRect
  document.body.innerHTML = ''
})

function ids(chain: Step[]): string[] {
  const tokens = queryPage(chain, 'tag', null) as string[]
  return tokens.map((token) => document.querySelector(`[${REF_ATTRIBUTE}="${token}"]`)?.id ?? '?')
}

describe('queryPage', () => {
  it('matches hasText as a case-insensitive substring and a regex as given', () => {
    document.body.innerHTML = `
      <button id="a">Basic</button>
      <button id="b">  Basic   View </button>
      <button id="c">basic</button>`
    expect(ids([step('button', { type: 'hasText', match: text('basic') })])).toEqual(['a', 'b', 'c'])
    expect(ids([step('button', { type: 'hasText', match: regex(/^Basic$/) })])).toEqual(['a'])
    expect(ids([step('button', { type: 'hasText', match: regex(/^Basic View$/) })])).toEqual(['b'])
  })

  it('looks for later steps inside the elements of the earlier ones', () => {
    document.body.innerHTML = `
      <div data-testid="editor-content"><button id="in">Macro</button></div>
      <button id="out">Macro</button>`
    expect(ids([step('[data-testid="editor-content"]'), step('button')])).toEqual(['in'])
  })

  it('keeps the elements that have a match of an inner chain inside them', () => {
    document.body.innerHTML = `
      <button id="one" data-testid="device-button"><span class="font-semibold">Virtual Keyboard</span></button>
      <button id="two" data-testid="device-button"><span class="font-semibold">Virtual Keyboard 2</span></button>`
    const has: StepFilter = { type: 'has', chain: [step('.font-semibold', { type: 'hasText', match: regex(/^Virtual Keyboard$/) })] }
    expect(ids([step('[data-testid="device-button"]', has)])).toEqual(['one'])
  })

  it('keeps the visible elements and picks by index after the other filters', () => {
    document.body.innerHTML = `
      <button id="a" class="no-box">x</button>
      <button id="b" style="visibility: hidden">x</button>
      <button id="c">x</button>
      <button id="d">x</button>`
    expect(ids([step('button', { type: 'visible' })])).toEqual(['c', 'd'])
    expect(ids([step('button', { type: 'visible' }, { type: 'nth', index: 0 })])).toEqual(['c'])
    expect(ids([step('button', { type: 'nth', index: -1 })])).toEqual(['d'])
    expect(ids([step('button', { type: 'nth', index: 9 })])).toEqual([])
  })

  it('finds a role by its accessible name, leaving out what is hidden from it', () => {
    document.body.innerHTML = `
      <button id="label" aria-label="Key Labels">QWERTY</button>
      <div role="listbox" aria-labelledby="title"><span id="title">Basic Tab View</span>
        <div id="ansi" role="option">ANSI</div>
        <div id="ansi-wide" role="option">ANSI (wide)</div>
      </div>
      <div aria-hidden="true"><button id="hidden">Key Labels</button></div>
      <div style="display: none"><button id="gone">Key Labels</button></div>`
    const button = 'button, [role="button"]'
    expect(ids([step(button, { type: 'role', name: text('key labels') })])).toEqual(['label'])
    const listbox = [step('[role="listbox"]', { type: 'role', name: text('Basic Tab View') })]
    expect(ids([...listbox, step('[role="option"]', { type: 'role', name: text('ANSI', true) })])).toEqual(['ansi'])
    expect(ids([...listbox, step('[role="option"]', { type: 'role', name: text('ANSI') })])).toEqual(['ansi', 'ansi-wide'])
  })

  it('reads whether the first element is visible and enabled', () => {
    document.body.innerHTML = `
      <button id="off" disabled>a</button>
      <div aria-disabled="true"><button id="aria">b</button></div>
      <fieldset disabled><legend><button id="legend">c</button></legend><button id="field">d</button></fieldset>
      <button id="on">e</button>`
    const state = (id: string): ElementState => queryPage([step(`#${id}`)], 'state', null) as ElementState
    expect(state('off')).toEqual({ count: 1, visible: true, enabled: false })
    expect(state('aria').enabled).toBe(false)
    expect(state('legend').enabled).toBe(true)
    expect(state('field').enabled).toBe(false)
    expect(state('on').enabled).toBe(true)
    expect(queryPage([step('#none')], 'state', null)).toEqual({ count: 0, visible: false, enabled: false })
  })

  it('counts, reads an attribute and moves its marks to the latest match', () => {
    document.body.innerHTML = `<button id="a" aria-expanded="true">a</button><button id="b">b</button>`
    expect(queryPage([step('button')], 'count', null)).toBe(2)
    expect(queryPage([step('#a')], 'attribute', 'aria-expanded')).toBe('true')
    expect(queryPage([step('#b')], 'attribute', 'aria-expanded')).toBeNull()
    expect(queryPage([step('#none')], 'attribute', 'aria-expanded')).toBeNull()
    const [first] = queryPage([step('#a')], 'tag', null) as string[]
    const [second] = queryPage([step('#b')], 'tag', null) as string[]
    expect(second).not.toBe(first)
    expect(document.querySelectorAll(`[${REF_ATTRIBUTE}]`)).toHaveLength(1)
    expect(document.getElementById('b')?.getAttribute(REF_ATTRIBUTE)).toBe(second)
  })
})
